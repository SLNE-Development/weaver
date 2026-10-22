import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal, Repo } from "@weaver/core";
import { createNpmHandler } from "./handler.js";
import { createHarness, type Harness } from "./test/harness.js";
import { fakeTarball, startFakeRegistry, type FakeRegistry } from "./test/fake-registry.js";
import { makeTarball, publishBody } from "./test/fixtures.js";

const CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const GROUP_ONLY = "tok-group-only";

let h: Harness;
let fake: FakeRegistry;
let down: FakeRegistry;
let hostedTgz: Buffer;
let group: Repo;
/** Calls the handler with an extra token that reads only the `npm-group` repository. */
let callGroupOnly: (path: string) => Promise<Response>;

beforeAll(async () => {
  h = await createHarness();
  fake = await startFakeRegistry([
    { name: "pkg", versions: ["1.0.0", "2.0.0"] },
    { name: "upstream-only", versions: ["3.0.0"] },
  ]);
  down = await startFakeRegistry([{ name: "pkg", versions: ["1.0.0"] }]);
  down.setOffline(true);

  await h.createRepo({ name: "npm-hosted", format: "npm", kind: "hosted", visibility: "private" });
  const mirror = (name: string, url: string) =>
    h.createRepo({ name, format: "npm", kind: "mirror", visibility: "private", upstreams: [{ url, authType: "none" }] });
  await mirror("npm-mirror", fake.url);
  await mirror("npm-down-a", down.url);
  await mirror("npm-down-b", down.url);
  group = await h.createRepo({ name: "npm-group", format: "npm", kind: "group", visibility: "private", members: ["npm-hosted", "npm-mirror"] });
  await h.createRepo({ name: "npm-group-down", format: "npm", kind: "group", visibility: "private", members: ["npm-hosted", "npm-down-a"] });
  await h.createRepo({ name: "npm-group-all-down", format: "npm", kind: "group", visibility: "private", members: ["npm-down-a", "npm-down-b"] });

  hostedTgz = await makeTarball("pkg", "1.0.0", { hosted: true });
  const res = await h.call("PUT", "npm-hosted/pkg", { token: h.tokens.writer, json: publishBody("pkg", "1.0.0", hostedTgz) });
  expect(res.status).toBe(201);

  const groupOnly: Principal = {
    kind: "apikey",
    keyId: "key-group-only",
    userId: "user-group-only",
    role: "maintainer",
    permissions: [{ repositoryId: group.id, repository: group.name, groupPrefix: null, access: "read" }],
  };
  const handler = createNpmHandler({
    ...h.deps,
    principal: (req) => (req.headers.get("authorization") === `Bearer ${GROUP_ONLY}` ? Promise.resolve(groupOnly) : h.deps.principal(req)),
  });
  callGroupOnly = (path) =>
    handler(new Request(`${h.publicUrl}/npm/${path}`, { headers: { authorization: `Bearer ${GROUP_ONLY}`, accept: CORGI } }), path);
}, 180_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
  await down?.close();
});

type Doc = { "dist-tags": Record<string, string>; versions: Record<string, { dist: { tarball: string } }>; modified?: string; readme?: string };

describe("npm group", () => {
  it("versions are merged and dist-tags of the earlier member win", async () => {
    for (const accept of [CORGI, "application/json"]) {
      const res = await h.call("GET", "npm-group/pkg", { token: h.tokens.reader, headers: { accept } });
      expect(res.status).toBe(200);
      const doc = (await res.json()) as Doc;
      expect(Object.keys(doc.versions).sort()).toEqual(["1.0.0", "2.0.0"]);
      expect(doc["dist-tags"].latest).toBe("1.0.0");
    }
    const corgi = await h.call("GET", "npm-group/pkg", { token: h.tokens.reader, headers: { accept: CORGI } });
    expect(corgi.headers.get("content-type")).toBe("application/vnd.npm.install-v1+json");
    const hosted = (await (await h.call("GET", "npm-hosted/pkg", { token: h.tokens.reader, headers: { accept: CORGI } })).json()) as Doc;
    expect(hosted.modified! > "2020-01-03T00:00:00.000Z").toBe(true);
    expect(((await corgi.json()) as Doc).modified).toBe(hosted.modified);
  });

  it("serves the merged dist-tags and versions", async () => {
    const tags = await h.call("GET", "npm-group/-/package/pkg/dist-tags", { token: h.tokens.reader });
    expect(tags.status).toBe(200);
    expect(await tags.json()).toEqual({ latest: "1.0.0" });
    const version = await h.call("GET", "npm-group/pkg/2.0.0", { token: h.tokens.reader });
    expect(version.status).toBe(200);
    expect(((await version.json()) as { dist: { tarball: string } }).dist.tarball).toBe("https://weaver.slne.dev/npm/npm-group/pkg/-/pkg-2.0.0.tgz");
    const latest = await h.call("GET", "npm-group/pkg/latest", { token: h.tokens.reader });
    expect(((await latest.json()) as { version: string }).version).toBe("1.0.0");
  });

  it("duplicate version uses the earlier member's tarball", async () => {
    const before = fake.hits.length;
    const res = await h.call("GET", "npm-group/pkg/-/pkg-1.0.0.tgz", { token: h.tokens.reader });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(hostedTgz)).toBe(true);
    expect(fake.hits.slice(before)).toEqual([]);
  });

  it("serves a version only a later member has from that member", async () => {
    const before = fake.hits.length;
    const res = await h.call("GET", "npm-group/pkg/-/pkg-2.0.0.tgz", { token: h.tokens.reader });
    // Only the tarball itself goes upstream: no member's packument is fetched to find it.
    expect(fake.hits.slice(before)).toEqual(["/pkg/-/pkg-2.0.0.tgz"]);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(await fakeTarball("pkg", "2.0.0"))).toBe(true);
    const head = await h.call("HEAD", "npm-group/upstream-only/-/upstream-only-3.0.0.tgz", { token: h.tokens.reader });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await h.call("GET", "npm-group/pkg/-/pkg-9.9.9.tgz", { token: h.tokens.reader })).status).toBe(404);
    expect((await h.call("GET", "npm-group/nope", { token: h.tokens.reader })).status).toBe(404);
  });

  it("tarball urls stay under the serving repo", async () => {
    for (const accept of [CORGI, "application/json"]) {
      const res = await h.call("GET", "npm-group/pkg", { token: h.tokens.reader, headers: { accept } });
      const text = await res.text();
      expect(text).not.toContain(fake.url);
      const doc = JSON.parse(text) as Doc;
      expect(doc.versions["1.0.0"]!.dist.tarball).toBe("https://weaver.slne.dev/npm/npm-group/pkg/-/pkg-1.0.0.tgz");
      expect(doc.versions["2.0.0"]!.dist.tarball).toBe("https://weaver.slne.dev/npm/npm-group/pkg/-/pkg-2.0.0.tgz");
    }
  });

  it("read on the group is enough", async () => {
    expect((await h.call("GET", "npm-group/pkg")).status).toBe(401);
    expect((await callGroupOnly("npm-hosted/pkg")).status).toBe(403);
    const res = await callGroupOnly("npm-group/pkg");
    expect(res.status).toBe(200);
    expect(Object.keys(((await res.json()) as Doc).versions)).toContain("1.0.0");
    const tgz = await callGroupOnly("npm-group/pkg/-/pkg-1.0.0.tgz");
    expect(tgz.status).toBe(200);
    expect(Buffer.from(await tgz.arrayBuffer()).equals(hostedTgz)).toBe(true);
  });

  it("refuses writes with 405", async () => {
    const res = await h.call("PUT", "npm-group/pkg", { token: h.tokens.admin, json: {} });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("a down mirror member does not break a package the hosted member has", async () => {
    const res = await h.call("GET", "npm-group-down/pkg", { token: h.tokens.reader, headers: { accept: CORGI } });
    expect(res.status).toBe(200);
    expect(Object.keys(((await res.json()) as Doc).versions)).toEqual(["1.0.0"]);
    const tgz = await h.call("GET", "npm-group-down/pkg/-/pkg-1.0.0.tgz", { token: h.tokens.reader });
    expect(tgz.status).toBe(200);
    expect(Buffer.from(await tgz.arrayBuffer()).equals(hostedTgz)).toBe(true);
  });

  it("all members down is 502", async () => {
    const res = await h.call("GET", "npm-group-all-down/pkg", { token: h.tokens.reader });
    expect(res.status).toBe(502);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.json()).toHaveProperty("error");
    expect((await h.call("GET", "npm-group-all-down/pkg/-/pkg-1.0.0.tgz", { token: h.tokens.reader })).status).toBe(502);
  });

  it("a package missing from the members it found while another member is down is 502", async () => {
    expect((await h.call("GET", "npm-group-down/upstream-only", { token: h.tokens.reader })).status).toBe(502);
  });
});

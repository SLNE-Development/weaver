import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { asset, component } from "@weaver/db";
import { compareSemver } from "./semver.js";
import { createHarness, type Harness } from "./test/harness.js";
import { makeTarball, publishBody } from "./test/fixtures.js";

const ABBREVIATED = "application/vnd.npm.install-v1+json";
const PKG = "@acme/ui";
const BASE = "npm-hosted/@acme%2fui";
const TAGS = "npm-hosted/-/package/@acme%2fui/dist-tags";

/** A loosely typed JSON document as served by the registry. */
interface Doc {
  _rev: string;
  versions: Record<string, { version?: string; deprecated?: string }>;
  "dist-tags": Record<string, string>;
  time: Record<string, string>;
}

let h: Harness;

/** Publishes `PKG@version` as the writer. */
async function publish(version: string, tag?: string) {
  const tgz = await makeTarball(PKG, version);
  return h.call("PUT", BASE, { token: h.tokens.writer, json: publishBody(PKG, version, tgz, { tag }) });
}

/** The full packument as served. */
async function packument(): Promise<Doc> {
  return (await h.call("GET", BASE)).json() as Promise<Doc>;
}

beforeAll(async () => {
  h = await createHarness();
  await h.createRepo({ name: "npm-hosted", format: "npm", kind: "hosted", visibility: "public" });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE npm_package, asset, component, usage_event CASCADE`);
});

describe("dist-tags", () => {
  it("dist-tag add, ls, rm", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    const put = await h.call("PUT", `${TAGS}/next`, { token: h.tokens.writer, json: "1.1.0" });
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ ok: true });
    const ls = await h.call("GET", TAGS);
    expect(ls.status).toBe(200);
    expect(await ls.json()).toEqual({ latest: "1.1.0", next: "1.1.0" });
    const rm = await h.call("DELETE", `${TAGS}/next`, { token: h.tokens.writer });
    expect(rm.status).toBe(200);
    expect(await rm.json()).toEqual({ ok: true });
    expect(await (await h.call("GET", TAGS)).json()).toEqual({ latest: "1.1.0" });
    expect((await h.call("DELETE", `${TAGS}/next`, { token: h.tokens.writer })).status).toBe(404);
  });

  it("adding a tag for a missing version is 400", async () => {
    await publish("1.0.0");
    const res = await h.call("PUT", `${TAGS}/next`, { token: h.tokens.writer, json: "9.9.9" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "version 9.9.9 does not exist" });
  });

  it("latest cannot be removed", async () => {
    await publish("1.0.0");
    const res = await h.call("DELETE", `${TAGS}/latest`, { token: h.tokens.writer });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cannot remove the latest tag" });
  });

  it("tag writes need write access and the package must exist", async () => {
    await publish("1.0.0");
    expect((await h.call("PUT", `${TAGS}/next`, { token: h.tokens.reader, json: "1.0.0" })).status).toBe(403);
    const missing = await h.call("PUT", "npm-hosted/-/package/nope/dist-tags/next", { token: h.tokens.writer, json: "1.0.0" });
    expect(missing.status).toBe(404);
  });
});

describe("deprecate and unpublish", () => {
  /** PUTs `body` to the rev URL as the writer. */
  function putRev(rev: string, body: unknown, token = h.tokens.writer) {
    return h.call("PUT", `${BASE}/-rev/${rev}`, { token, json: body });
  }

  it("deprecate sets and clears the message", async () => {
    await publish("1.0.0");
    let doc = await packument();
    doc.versions["1.0.0"]!.deprecated = "use 2.x";
    expect((await putRev(doc._rev, doc)).status).toBeLessThan(300);
    const abbreviated = (await (await h.call("GET", BASE, { headers: { accept: ABBREVIATED } })).json()) as Doc;
    expect(abbreviated.versions["1.0.0"]!.deprecated).toBe("use 2.x");

    doc = await packument();
    doc.versions["1.0.0"]!.deprecated = "";
    expect((await putRev(doc._rev, doc)).status).toBeLessThan(300);
    const cleared = (await (await h.call("GET", BASE, { headers: { accept: ABBREVIATED } })).json()) as Doc;
    expect(cleared.versions["1.0.0"]!.deprecated).toBeUndefined();
  });

  it("deprecate through PUT <name> with the rev in the body", async () => {
    await publish("1.0.0");
    const doc = await packument();
    doc.versions["1.0.0"]!.deprecated = "old";
    const res = await h.call("PUT", BASE, { token: h.tokens.writer, json: doc });
    expect(res.status).toBeLessThan(300);
    expect((await packument()).versions["1.0.0"]!.deprecated).toBe("old");
  });

  it("stale rev is 409", async () => {
    await publish("1.0.0");
    const doc = await packument();
    await publish("1.1.0");
    const res = await putRev(doc._rev, doc);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "document update conflict" });
  });

  it("unpublish one version keeps a tombstone and repoints latest", async () => {
    await publish("1.0.0");
    await publish("1.1.0");
    const current = await packument();
    expect(current["dist-tags"].latest).toBe("1.1.0");
    delete current.versions["1.1.0"];
    expect((await putRev(current._rev, current)).status).toBeLessThan(300);
    const del = await h.call("DELETE", `${BASE}/-/ui-1.1.0.tgz/-rev/${current._rev}`, { token: h.tokens.writer });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const after = await packument();
    expect(after["dist-tags"].latest).toBe("1.0.0");
    expect(Object.keys(after.versions)).toEqual(["1.0.0"]);
    expect(after.time["1.1.0"]).toBeTypeOf("string");
    expect((await h.call("GET", "npm-hosted/@acme/ui/-/ui-1.1.0.tgz")).status).toBe(404);
    expect(await h.db.select().from(asset).where(eq(asset.path, "@acme/ui/-/ui-1.1.0.tgz"))).toHaveLength(0);
    expect(await h.db.select().from(component).where(eq(component.version, "1.1.0"))).toHaveLength(0);
    expect((await publish("1.1.0")).status).toBe(409);
    // the tarball DELETE of a version that is still published is refused
    expect((await h.call("DELETE", `${BASE}/-/ui-1.0.0.tgz/-rev/${after._rev}`, { token: h.tokens.writer })).status).toBe(404);
  });

  it("unpublishing the tagged version drops its tags", async () => {
    await publish("1.0.0");
    await publish("1.1.0", "next");
    const doc = await packument();
    delete doc.versions["1.1.0"];
    expect((await putRev(doc._rev, doc)).status).toBeLessThan(300);
    expect((await packument())["dist-tags"]).toEqual({ latest: "1.0.0" });
  });

  it("a version that does not exist is 400 and removing all is refused", async () => {
    await publish("1.0.0");
    const doc = await packument();
    const extra = { ...doc, versions: { ...doc.versions, "2.0.0": { ...doc.versions["1.0.0"], version: "2.0.0" } } };
    expect((await putRev(doc._rev, extra)).status).toBe(400);
    const empty = await putRev(doc._rev, { ...doc, versions: {} });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "use npm unpublish --force" });
  });

  it("unpublish whole package frees the name", async () => {
    await publish("1.0.0");
    const doc = await packument();
    const del = await h.call("DELETE", `${BASE}/-rev/${doc._rev}`, { token: h.tokens.writer });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect((await h.call("GET", BASE)).status).toBe(404);
    expect(await h.db.select().from(asset)).toHaveLength(0);
    expect(await h.db.select().from(component)).toHaveLength(0);
    expect((await publish("1.0.0")).status).toBe(201);
  });

  it("deleting the whole package with a stale rev is 409", async () => {
    await publish("1.0.0");
    const res = await h.call("DELETE", `${BASE}/-rev/1-0000000000000000`, { token: h.tokens.writer });
    expect(res.status).toBe(409);
    expect((await h.call("GET", BASE)).status).toBe(200);
  });

  it("reader cannot unpublish (403)", async () => {
    await publish("1.0.0");
    const doc = await packument();
    expect((await putRev(doc._rev, { ...doc, versions: {} }, h.tokens.reader)).status).toBe(403);
    expect((await h.call("DELETE", `${BASE}/-rev/${doc._rev}`, { token: h.tokens.reader })).status).toBe(403);
    expect((await h.call("DELETE", `${BASE}/-rev/${doc._rev}`)).status).toBe(401);
    expect((await h.call("GET", BASE)).status).toBe(200);
  });
});

describe("compareSemver", () => {
  it("compareSemver orders 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0 < 1.10.0", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0", "1.2.0", "1.10.0"];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareSemver(ordered[i]!, ordered[i + 1]!), ordered[i]).toBeLessThan(0);
      expect(compareSemver(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
    }
    expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(compareSemver("1.0.0-1", "1.0.0-a")).toBeLessThan(0);
  });
});

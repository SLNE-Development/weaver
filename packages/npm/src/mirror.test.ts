import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { asset, usageEvent } from "@weaver/db";
import type { Repo } from "@weaver/core";
import { forwardUpstream } from "./upstream.js";
import { createHarness, type Harness } from "./test/harness.js";
import { fakeTarball, startFakeRegistry, type FakeRegistry } from "./test/fake-registry.js";

const CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const PACKAGES = [
  { name: "@acme/ui", versions: ["1.0.0", "1.1.0"], tags: { beta: "1.1.0" } },
  { name: "left-pad", versions: ["1.3.0"] },
  { name: "@internal/secret", versions: ["1.0.0"] },
];

let h: Harness;
let fake: FakeRegistry;
let down: FakeRegistry;
let gzip: FakeRegistry;
let locked: Server;
let lockedUrl: string;
let lockedHits = 0;
let lockedAuth: string | undefined;
let echo: Server;
let bad: Server;
let flip: Server;
let flipLocked = false;
let echoHeaders: Record<string, string | string[] | undefined> = {};
const repos: Record<string, Repo> = {};

/** Number of assets stored in `repo`. */
async function assetCount(repo: string): Promise<number> {
  const rows = await h.db.select({ path: asset.path }).from(asset).where(eq(asset.repositoryId, repos[repo]!.id));
  return rows.length;
}

/** Paths of the assets stored in `repo`. */
async function assetPaths(repo: string): Promise<string[]> {
  const rows = await h.db.select({ path: asset.path }).from(asset).where(eq(asset.repositoryId, repos[repo]!.id));
  return rows.map((r) => r.path).sort();
}

beforeAll(async () => {
  h = await createHarness();
  fake = await startFakeRegistry(PACKAGES);
  down = await startFakeRegistry(PACKAGES);
  gzip = await startFakeRegistry(PACKAGES, { gzip: true });
  locked = createServer((req, res) => {
    lockedHits++;
    lockedAuth = req.headers.authorization;
    req.resume();
    res.writeHead(401, { "www-authenticate": 'Basic realm="upstream"', "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>((resolve) => locked.listen(0, "127.0.0.1", resolve));
  lockedUrl = `http://127.0.0.1:${(locked.address() as AddressInfo).port}`;
  echo = createServer((req, res) => {
    echoHeaders = req.headers;
    req.resume();
    res.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": "x-weaver-unknown", "content-length": "5" });
    res.end("plain");
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  bad = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "left-pad", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": "not an object" } }));
  });
  await new Promise<void>((resolve) => bad.listen(0, "127.0.0.1", resolve));
  flip = createServer((req, res) => {
    req.resume();
    if (flipLocked) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "left-pad", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "left-pad", version: "1.0.0", dist: { tarball: "x", shasum: "y" } } } }));
  });
  await new Promise<void>((resolve) => flip.listen(0, "127.0.0.1", resolve));
  repos["npm-flip"] = await h.createRepo({
    name: "npm-flip",
    format: "npm",
    kind: "mirror",
    visibility: "public",
    upstreams: [{ url: `http://127.0.0.1:${(flip.address() as AddressInfo).port}`, authType: "none" }],
    config: { cache: { enabled: true, metadataTtlSeconds: 0 } },
  });
  repos["npm-bad"] = await h.createRepo({
    name: "npm-bad",
    format: "npm",
    kind: "mirror",
    visibility: "public",
    upstreams: [{ url: `http://127.0.0.1:${(bad.address() as AddressInfo).port}`, authType: "none" }],
  });
  repos["npm-echo"] = await h.createRepo({
    name: "npm-echo",
    format: "npm",
    kind: "mirror",
    upstreams: [{ url: `http://127.0.0.1:${(echo.address() as AddressInfo).port}`, authType: "none" }],
  });

  const mirror = (name: string, url: string, config?: unknown) =>
    h.createRepo({ name, format: "npm", kind: "mirror", visibility: "public", upstreams: [{ url, authType: "none" }], config });
  repos["npm-mirror"] = await mirror("npm-mirror", fake.url);
  repos["npm-cached"] = await mirror("npm-cached", fake.url, { cache: { enabled: true } });
  repos["npm-rules"] = await mirror("npm-rules", fake.url, { rules: { deny: ["@internal/*"] } });
  repos["npm-down"] = await mirror("npm-down", down.url, { cache: { enabled: true, metadataTtlSeconds: 0 } });
  repos["npm-gzip"] = await mirror("npm-gzip", gzip.url);
  repos["npm-locked"] = await mirror("npm-locked", lockedUrl);
  repos["npm-auth"] = await h.createRepo({
    name: "npm-auth",
    format: "npm",
    kind: "mirror",
    visibility: "public",
    upstreams: [{ url: fake.url, authType: "bearer", secret: "upstream-secret" }],
  });
  repos["npm-locked-auth"] = await h.createRepo({
    name: "npm-locked-auth",
    format: "npm",
    kind: "mirror",
    upstreams: [{ url: lockedUrl, authType: "bearer", secret: "upstream-secret" }],
  });
  repos["npm-offline"] = await mirror("npm-offline", fake.url, { offline: true });
}, 180_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
  await down?.close();
  await gzip?.close();
  await new Promise((resolve) => locked?.close(resolve));
  await new Promise((resolve) => echo?.close(resolve));
  await new Promise((resolve) => bad?.close(resolve));
  await new Promise((resolve) => flip?.close(resolve));
});

describe("npm mirror", () => {
  it("cache off: packument and tarball proxied, nothing stored", async () => {
    const meta = await h.call("GET", "npm-mirror/@acme%2fui", { headers: { accept: CORGI } });
    expect(meta.status).toBe(200);
    expect(meta.headers.get("content-type")).toBe("application/vnd.npm.install-v1+json");
    const doc = (await meta.json()) as { versions: Record<string, unknown>; "dist-tags": Record<string, string> };
    expect(Object.keys(doc.versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(doc["dist-tags"]).toEqual({ latest: "1.1.0", beta: "1.1.0" });

    const tgz = await h.call("GET", "npm-mirror/@acme/ui/-/ui-1.0.0.tgz");
    expect(tgz.status).toBe(200);
    expect(tgz.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = Buffer.from(await tgz.arrayBuffer());
    expect(bytes.equals(await fakeTarball("@acme/ui", "1.0.0"))).toBe(true);
    await h.deps.mirror.drain();
    expect(await assetCount("npm-mirror")).toBe(0);
  });

  it("tarball urls stay under the serving repo", async () => {
    for (const accept of [CORGI, "application/json"]) {
      const res = await h.call("GET", "npm-mirror/@acme%2fui", { headers: { accept } });
      const text = await res.text();
      expect(text).not.toContain(fake.url);
      const doc = JSON.parse(text) as { versions: Record<string, { dist: { tarball: string } }> };
      expect(doc.versions["1.0.0"]!.dist.tarball).toBe("https://weaver.slne.dev/npm/npm-mirror/@acme/ui/-/ui-1.0.0.tgz");
    }
  });

  it("serves the full packument for application/json", async () => {
    const res = await h.call("GET", "npm-mirror/left-pad");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({ name: "left-pad", readme: "# left-pad" });
    const head = await h.call("HEAD", "npm-mirror/left-pad");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("serves versions and dist-tags from the upstream packument", async () => {
    const version = await h.call("GET", "npm-mirror/@acme%2fui/beta");
    expect(version.status).toBe(200);
    const manifest = (await version.json()) as { version: string; dist: { tarball: string } };
    expect(manifest.version).toBe("1.1.0");
    expect(manifest.dist.tarball).toBe("https://weaver.slne.dev/npm/npm-mirror/@acme/ui/-/ui-1.1.0.tgz");
    expect((await h.call("GET", "npm-mirror/@acme%2fui/9.9.9")).status).toBe(404);

    const tags = await h.call("GET", "npm-mirror/-/package/@acme%2fui/dist-tags");
    expect(tags.status).toBe(200);
    expect(await tags.json()).toEqual({ latest: "1.1.0", beta: "1.1.0" });
    expect((await h.call("GET", "npm-mirror/-/package/nope/dist-tags")).status).toBe(404);
  });

  it("answers 404 for packages and tarballs the upstream lacks", async () => {
    const res = await h.call("GET", "npm-mirror/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect((await h.call("GET", "npm-mirror/left-pad/-/left-pad-9.9.9.tgz")).status).toBe(404);
  });

  it("refuses writes with 405", async () => {
    const res = await h.call("PUT", "npm-mirror/left-pad", { token: h.tokens.admin, json: {} });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("cache on: corgi and full cached separately; second install hits cache", async () => {
    const install = async () => {
      const corgi = await h.call("GET", "npm-cached/@acme%2fui", { headers: { accept: CORGI } });
      expect(corgi.status).toBe(200);
      const corgiDoc = (await corgi.json()) as Record<string, unknown>;
      expect(corgiDoc).not.toHaveProperty("readme");
      const full = await h.call("GET", "npm-cached/@acme%2fui", { headers: { accept: "application/json" } });
      expect(full.status).toBe(200);
      expect(full.headers.get("content-type")).toBe("application/json");
      expect(await full.json()).toMatchObject({ readme: "# @acme/ui" });
      const tgz = await h.call("GET", "npm-cached/@acme/ui/-/ui-1.0.0.tgz");
      expect(tgz.status).toBe(200);
      expect(Buffer.from(await tgz.arrayBuffer()).equals(await fakeTarball("@acme/ui", "1.0.0"))).toBe(true);
      await h.deps.mirror.drain();
    };
    await install();
    expect(await assetPaths("npm-cached")).toEqual(["@acme/ui/-/ui-1.0.0.tgz", "@acme/ui/.corgi", "@acme/ui/.packument"].sort());
    const before = fake.hits.length;
    await install();
    expect(fake.hits.length).toBe(before);

    const events = await h.db
      .select({ cache: usageEvent.cache })
      .from(usageEvent)
      .where(and(eq(usageEvent.repositoryId, repos["npm-cached"]!.id), eq(usageEvent.action, "download")));
    expect(events.map((e) => e.cache).sort()).toEqual(["hit", "miss"]);
  });

  it('deny rule "@internal/*" answers 404 without contacting upstream', async () => {
    const before = fake.hits.length;
    expect((await h.call("GET", "npm-rules/@internal%2fsecret")).status).toBe(404);
    expect((await h.call("GET", "npm-rules/@internal/secret/-/secret-1.0.0.tgz")).status).toBe(404);
    expect(fake.hits.length).toBe(before);
    expect((await h.call("GET", "npm-rules/left-pad")).status).toBe(200);
  });

  it("upstream down and nothing cached is 502 {error}", async () => {
    down.setOffline(true);
    try {
      const res = await h.call("GET", "npm-down/left-pad");
      expect(res.status).toBe(502);
      expect(await res.json()).toHaveProperty("error");
      expect((await h.call("GET", "npm-down/left-pad/-/left-pad-1.3.0.tgz")).status).toBe(502);
    } finally {
      down.setOffline(false);
    }
  });

  it("upstream down with cached packument serves it", async () => {
    const first = await h.call("GET", "npm-down/@acme%2fui", { headers: { accept: CORGI } });
    expect(first.status).toBe(200);
    await first.text();
    await h.deps.mirror.drain();
    down.setOffline(true);
    try {
      const res = await h.call("GET", "npm-down/@acme%2fui", { headers: { accept: CORGI } });
      expect(res.status).toBe(200);
      const doc = (await res.json()) as { versions: Record<string, { dist: { tarball: string } }> };
      expect(doc.versions["1.0.0"]!.dist.tarball).toBe("https://weaver.slne.dev/npm/npm-down/@acme/ui/-/ui-1.0.0.tgz");
    } finally {
      down.setOffline(false);
    }
  });

  it("an unreadable cached copy counts as none when the upstream refuses", async () => {
    const first = await h.call("GET", "npm-flip/left-pad");
    expect(first.status).toBe(200);
    await first.text();
    await h.deps.mirror.drain();
    flipLocked = true;
    try {
      const stale = await h.call("GET", "npm-flip/left-pad");
      expect(stale.status).toBe(200);
      await stale.text();
      const open = vi.spyOn(h.deps.assets, "open").mockRejectedValue(new Error("store gone"));
      try {
        const res = await h.call("GET", "npm-flip/left-pad");
        expect(res.status).toBe(502);
        expect(res.headers.get("www-authenticate")).toBeNull();
        expect(await res.json()).toHaveProperty("error");
      } finally {
        open.mockRestore();
      }
    } finally {
      flipLocked = false;
    }
  });

  it("a version entry that is not an object is an invalid packument", async () => {
    for (const accept of [CORGI, "application/json"]) {
      const res = await h.call("GET", "npm-bad/left-pad", { headers: { accept } });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "the upstream of npm-bad sent an invalid packument" });
    }
  });

  it("gzip upstream is passed through decoded", async () => {
    const res = await h.call("GET", "npm-gzip/@acme%2fui", { headers: { accept: CORGI, "accept-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    const doc = (await res.json()) as { name: string };
    expect(doc.name).toBe("@acme/ui");
  });

  it("scoped package is requested upstream as @scope%2fname", async () => {
    await (await h.call("GET", "npm-mirror/@acme/ui", { headers: { accept: CORGI } })).text();
    expect(fake.hits).toContain("/@acme%2fui");
    await (await h.call("GET", "npm-mirror/@acme%2fui/-/ui-1.1.0.tgz")).arrayBuffer();
    expect(fake.hits).toContain("/@acme%2fui/-/ui-1.1.0.tgz");
  });

  it("an upstream 401 is a 502, never a client challenge", async () => {
    for (const path of ["npm-locked/left-pad", "npm-locked/left-pad/-/left-pad-1.3.0.tgz"]) {
      const res = await h.call("GET", path);
      expect(res.status).toBe(502);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.json()).toHaveProperty("error");
    }
    expect(lockedHits).toBeGreaterThan(0);
  });

  it("an offline mirror without cache answers 404", async () => {
    const before = fake.hits.length;
    expect((await h.call("GET", "npm-offline/left-pad")).status).toBe(404);
    expect(fake.hits.length).toBe(before);
  });
});

describe("forwardUpstream", () => {
  it("forwards the query and applies upstream auth instead of the client's", async () => {
    const before = fake.hits.length;
    const res = await forwardUpstream(h.deps, repos["npm-auth"]!, "-/v1/search", {
      method: "GET",
      headers: new Headers({ authorization: "Bearer client-token", accept: "application/json" }),
      search: "?text=acme&size=5",
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { objects: Array<{ package: { name: string } }> };
    expect(body.objects.map((o) => o.package.name)).toEqual(["@acme/ui"]);
    expect(fake.hits.slice(before)).toEqual(["/-/v1/search?text=acme&size=5"]);
  });

  it("sends the upstream credentials and maps an upstream 401 to upstream_unavailable", async () => {
    await expect(
      forwardUpstream(h.deps, repos["npm-locked-auth"]!, "-/v1/search", { method: "GET", headers: new Headers({ authorization: "Bearer client-token" }) }),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(lockedAuth).toBe("Bearer upstream-secret");
  });

  it("forwards a POST body", async () => {
    const res = await forwardUpstream(h.deps, repos["npm-mirror"]!, "-/npm/v1/security/advisories/bulk", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode(JSON.stringify({ "left-pad": ["1.3.0"] })),
    });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({});
  });

  it("decodes gzip and drops the encoding headers", async () => {
    const res = await forwardUpstream(h.deps, repos["npm-gzip"]!, "-/v1/search", { method: "GET", headers: new Headers(), search: "text=left" });
    expect(res!.headers.get("content-encoding")).toBeNull();
    expect(res!.headers.get("content-length")).toBeNull();
    expect(((await res!.json()) as { total: number }).total).toBe(1);
  });

  it("forwards only the allow-listed request headers", async () => {
    const res = await forwardUpstream(h.deps, repos["npm-echo"]!, "-/v1/search", {
      method: "GET",
      headers: new Headers({
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "npm/11.0.0",
        "npm-command": "search",
        "npm-session": "abc",
        "npm-scope": "@acme",
        "npm-in-ci": "false",
        "x-forwarded-for": "10.0.0.1",
        forwarded: "for=10.0.0.1",
        "x-real-ip": "10.0.0.1",
        "npm-otp": "123456",
        referer: "search",
        "x-weaver-trace": "t",
        authorization: "Bearer client-token",
        cookie: "a=b",
      }),
    });
    await res!.arrayBuffer();
    expect(echoHeaders).toMatchObject({
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "npm/11.0.0",
      "npm-command": "search",
      "npm-session": "abc",
      "npm-scope": "@acme",
      "npm-in-ci": "false",
    });
    for (const name of ["x-forwarded-for", "forwarded", "x-real-ip", "npm-otp", "referer", "x-weaver-trace", "authorization", "cookie"]) {
      expect(echoHeaders).not.toHaveProperty(name);
    }
  });

  it("keeps the content-encoding of a body fetch could not decode", async () => {
    const res = await forwardUpstream(h.deps, repos["npm-echo"]!, "-/v1/search", { method: "GET", headers: new Headers() });
    expect(res!.headers.get("content-encoding")).toBe("x-weaver-unknown");
    expect(res!.headers.get("content-length")).toBe("5");
    expect(await res!.text()).toBe("plain");
  });

  it("returns null when every upstream answers 404 and when offline", async () => {
    expect(await forwardUpstream(h.deps, repos["npm-mirror"]!, "-/nothing-here", { method: "GET", headers: new Headers() })).toBeNull();
    expect(await forwardUpstream(h.deps, repos["npm-offline"]!, "-/v1/search", { method: "GET", headers: new Headers() })).toBeNull();
  });

  it("fails with upstream_unavailable when the upstream is down", async () => {
    down.setOffline(true);
    try {
      await expect(forwardUpstream(h.deps, repos["npm-down"]!, "-/v1/search", { method: "GET", headers: new Headers() })).rejects.toMatchObject({
        code: "upstream_unavailable",
      });
    } finally {
      down.setOffline(false);
    }
  });
});


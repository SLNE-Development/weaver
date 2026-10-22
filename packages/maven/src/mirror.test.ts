import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { usageEvent } from "@weaver/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MavenContext } from "./context.js";
import { contentClassFor, mirrorMetadataXml } from "./mirror.js";
import { parseMavenPath, type MavenPath } from "./path.js";
import { startMavenFixture, type MavenFixture } from "./testing/fixture.js";
import { startStubUpstream, type StubUpstream } from "./testing/upstream.js";

/** Parses a path below a repository into a non-directory target. */
function target(path: string): Exclude<MavenPath, { type: "directory" }> {
  const t = parseMavenPath(`r/${path}`).target;
  if (t === null || t.type === "directory") throw new Error(`not a file path: ${path}`);
  return t;
}

describe("contentClassFor", () => {
  it("classifies release files as immutable and snapshots and metadata as metadata", () => {
    expect(contentClassFor(target("org/ex/lib/1.0/lib-1.0.jar"))).toBe("immutable");
    expect(contentClassFor(target("org/ex/lib/1.0/lib-1.0.jar.sha1"))).toBe("immutable");
    expect(contentClassFor(target("org/ex/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT.jar"))).toBe("metadata");
    expect(contentClassFor(target("org/ex/lib/1.0-SNAPSHOT/lib-1.0-20261022.101010-1.jar"))).toBe("metadata");
    expect(contentClassFor(target("org/ex/lib/maven-metadata.xml"))).toBe("metadata");
    expect(contentClassFor(target("org/ex/lib/maven-metadata.xml.sha1"))).toBe("metadata");
    expect(contentClassFor(target("archetype-catalog.xml"))).toBe("metadata");
  });
});

describe("maven mirror repositories", () => {
  let fx: MavenFixture;
  let upstream: StubUpstream;

  const JAR = "org/ex/lib/1.0/lib-1.0.jar";
  const JAR_BYTES = "release-jar-bytes";

  beforeAll(async () => {
    fx = await startMavenFixture();
    upstream = await startStubUpstream({ [JAR]: JAR_BYTES, "com/evil/x/1/x-1.jar": "evil", "org/ex/x/1/x-1.jar": "x-one" });
    const upstreams = [{ url: upstream.url, authType: "none" as const }];
    await fx.createRepo({ name: "plain", format: "maven", kind: "mirror", visibility: "public", upstreams });
    await fx.createRepo({ name: "cached", format: "maven", kind: "mirror", visibility: "public", upstreams, config: { cache: { enabled: true } } });
    await fx.createRepo({
      name: "ruled",
      format: "maven",
      kind: "mirror",
      visibility: "public",
      upstreams,
      config: { rules: { allow: [], deny: ["com.evil.*"] } },
    });
    await fx.createRepo({
      name: "allowed",
      format: "maven",
      kind: "mirror",
      visibility: "public",
      upstreams,
      config: { rules: { allow: ["org.ex:lib"], deny: [] } },
    });
    /** Creates a public mirror over the stub upstream with the given config. */
    const mirror = (name: string, config: unknown) => fx.createRepo({ name, format: "maven", kind: "mirror", visibility: "public", upstreams, config });
    await mirror("deny-group", { rules: { allow: [], deny: ["com.evil"] } });
    await mirror("allow-lib-group", { rules: { allow: ["org.example.lib"], deny: [] } });
    await mirror("allow-mycorp", { rules: { allow: ["io.mycorp.*"], deny: [] } });
    await mirror("short-ttl", { cache: { enabled: true, metadataTtlSeconds: 0 } });
  }, 120_000);

  afterAll(async () => {
    await upstream?.close();
    await fx?.stop();
  });

  beforeEach(() => {
    upstream.hits.length = 0;
    upstream.down = false;
    upstream.statuses.clear();
  });

  /** GETs (or HEADs) anonymously. */
  const get = (path: string, method = "GET") => fx.request(method, path);
  /** The number of stored assets of a repository. */
  const assetCount = async (repo: string) => (await fx.deps.assets.list((await fx.repos.get(repo))!.id, "")).length;

  it("proxies a release jar with caching off", async () => {
    const res = await get(`plain/${JAR}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JAR_BYTES);
    expect(res.headers.get("content-length")).toBe(String(JAR_BYTES.length));
    expect(upstream.hits).toEqual([`/${JAR}`]);
    expect(await assetCount("plain")).toBe(0);
  });

  it("HEAD answers headers without a body", async () => {
    const res = await get(`plain/${JAR}`, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(JAR_BYTES.length));
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("caching on serves the second request from cache", async () => {
    expect(await (await get(`cached/${JAR}`)).text()).toBe(JAR_BYTES);
    await fx.deps.mirror.drain();
    expect(await (await get(`cached/${JAR}`)).text()).toBe(JAR_BYTES);
    expect(upstream.hits).toEqual([`/${JAR}`]);
  });

  it("deny rule answers 404 without contacting upstream", async () => {
    expect((await get("ruled/com/evil/x/1/x-1.jar")).status).toBe(404);
    expect(upstream.hits).toEqual([]);
    expect((await get("ruled/org/ex/x/1/x-1.jar")).status).toBe(200);
  });

  it("deny rule hides metadata whose group-level reading is denied", async () => {
    expect((await get("ruled/com/evil/maven-metadata.xml")).status).toBe(404);
    expect(upstream.hits).toEqual([]);
  });

  it("allow rule proxies only the listed artifact and its metadata", async () => {
    upstream.files.set("org/ex/lib/maven-metadata.xml", "<metadata/>");
    expect((await get(`allowed/${JAR}`)).status).toBe(200);
    expect((await get("allowed/org/ex/lib/maven-metadata.xml")).status).toBe(200);
    expect(upstream.hits).toEqual([`/${JAR}`, "/org/ex/lib/maven-metadata.xml"]);
    expect((await get("allowed/org/ex/x/1/x-1.jar")).status).toBe(404);
    expect(upstream.hits).toHaveLength(2);
  });

  it("a pattern without a colon is a groupId pattern", async () => {
    upstream.files.set("com/evil/1/evil-1.jar", "com-evil");
    upstream.files.set("org/example/lib/1/lib-1.jar", "lib");
    upstream.files.set("io/mycorp.evil/1/mycorp.evil-1.jar", "sneaky");
    upstream.files.set("io/mycorp/a/1/a-1.jar", "a");
    upstream.files.set("io/mycorp/sub/b/1/b-1.jar", "b");

    // deny `com.evil` blocks group com.evil, but not artifact `evil` of group com.
    expect((await get("deny-group/com/evil/x/1/x-1.jar")).status).toBe(404);
    expect(upstream.hits).toEqual([]);
    expect((await get("deny-group/com/evil/1/evil-1.jar")).status).toBe(200);

    // allow `org.example.lib` names a group, not the artifact org.example:lib.
    expect((await get("allow-lib-group/org/example/lib/1/lib-1.jar")).status).toBe(404);

    // allow `io.mycorp.*` covers io.mycorp and its subgroups, not io:mycorp.evil.
    expect((await get("allow-mycorp/io/mycorp.evil/1/mycorp.evil-1.jar")).status).toBe(404);
    expect((await get("allow-mycorp/io/mycorp/a/1/a-1.jar")).status).toBe(200);
    expect((await get("allow-mycorp/io/mycorp/sub/b/1/b-1.jar")).status).toBe(200);
  });

  it("a deny pattern `g.*` also covers group g itself", async () => {
    expect((await get("ruled/com/evil/1/evil-1.jar")).status).toBe(200);
    expect((await get("ruled/com/evil/sub/y/1/y-1.jar")).status).toBe(404);
  });

  it("generates a checksum the upstream lacks from the cached file", async () => {
    expect(await (await get("cached/org/ex/x/1/x-1.jar")).text()).toBe("x-one");
    await fx.deps.mirror.drain();
    const res = await get("cached/org/ex/x/1/x-1.jar.sha1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(createHash("sha1").update("x-one").digest("hex"));
  });

  it("a missing checksum without a cached file answers 404", async () => {
    expect((await get("plain/org/ex/x/1/x-1.jar.sha1")).status).toBe(404);
  });

  it("generates a checksum from the cached file while the upstream is down", async () => {
    upstream.files.set("org/ex/outage/1/outage-1.jar", "outage");
    expect(await (await get("cached/org/ex/outage/1/outage-1.jar")).text()).toBe("outage");
    await fx.deps.mirror.drain();
    upstream.down = true;
    const res = await get("cached/org/ex/outage/1/outage-1.jar.sha1");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(createHash("sha1").update("outage").digest("hex"));
    expect((await get("cached/org/ex/outage/1/outage-1.jar.asc.sha1")).status).toBe(502);
  });

  it("serves the cached copy when the upstream refuses with 401 or 403", async () => {
    const path = "org/ex/stale/maven-metadata.xml";
    upstream.files.set(path, "<metadata>stale</metadata>");
    expect(await (await get(`short-ttl/${path}`)).text()).toBe("<metadata>stale</metadata>");
    await fx.deps.mirror.drain();
    for (const status of [401, 403]) {
      upstream.statuses.set(path, status);
      const res = await get(`short-ttl/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.text()).toBe("<metadata>stale</metadata>");
    }
    const head = await get(`short-ttl/${path}`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String("<metadata>stale</metadata>".length));
  });

  it("an upstream redirect answers 502 without a location", async () => {
    upstream.statuses.set("org/ex/moved/1/moved-1.jar", 302);
    const res = await get("plain/org/ex/moved/1/moved-1.jar");
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
  });

  it("upstream down without cache answers 502", async () => {
    upstream.down = true;
    expect((await get(`plain/${JAR}`)).status).toBe(502);
  });

  it("upstream auth failure answers 502, never a client challenge", async () => {
    for (const status of [401, 403]) {
      upstream.statuses.set("org/ex/auth/1/auth-1.jar", status);
      const res = await get("plain/org/ex/auth/1/auth-1.jar");
      expect(res.status).toBe(502);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("records download with cache result", async () => {
    upstream.files.set("org/ex/used/1/used-1.jar", "used");
    const path = "org/ex/used/1/used-1.jar";
    await (await get(`cached/${path}`)).text();
    await fx.deps.mirror.drain();
    await (await get(`cached/${path}`)).text();
    await (await get(`cached/${path}.sha1`)).text();
    const rows = await fx.deps.db.select().from(usageEvent).where(eq(usageEvent.path, path)).orderBy(asc(usageEvent.id));
    expect(rows.map((r) => [r.action, r.cache])).toEqual([
      ["download", "miss"],
      ["download", "hit"],
    ]);
  });

  it("mirrorMetadataXml returns upstream metadata, null when absent, and throws when down", async () => {
    const xml = "<metadata><groupId>org.ex</groupId><artifactId>lib</artifactId></metadata>";
    upstream.files.set("org/ex/lib/maven-metadata.xml", xml);
    const repo = (await fx.repos.get("plain"))!;
    const ctx: MavenContext = { deps: fx.deps, principal: { kind: "anonymous" }, method: "GET" };
    expect(await mirrorMetadataXml(ctx, repo, "org/ex/lib")).toBe(xml);
    expect(await mirrorMetadataXml(ctx, repo, "org/ex/none")).toBeNull();
    upstream.down = true;
    await expect(mirrorMetadataXml(ctx, repo, "org/ex/lib")).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("mirrorMetadataXml wraps a mid-stream error as upstream_unavailable", async () => {
    const repo = (await fx.repos.get("plain"))!;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<meta"));
        controller.error(new Error("connection reset"));
      },
    });
    const mirror = { ...fx.deps.mirror, fetch: async () => ({ status: 200, headers: new Headers(), body, cache: "bypass" as const, asset: null, upstreamUrl: upstream.url }) };
    const ctx: MavenContext = { deps: { ...fx.deps, mirror }, principal: { kind: "anonymous" }, method: "GET" };
    await expect(mirrorMetadataXml(ctx, repo, "org/ex/lib")).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});

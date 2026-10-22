import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asset } from "@weaver/db";
import type { Repo } from "@weaver/core";
import { digestOf, errorCodeOf, randomBlob, startDockerTestRegistry, type DockerTestRegistry } from "../testing.js";
import { startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

/** An OCI image manifest referencing `config` and `layer`, serialized with unusual spacing so its bytes matter. */
function manifestOf(config: Buffer, layer: Buffer): Buffer {
  const d = (b: Buffer, mediaType: string) => ({ mediaType, digest: digestOf(b), size: b.length });
  return Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: d(config, "application/vnd.oci.image.config.v1+json"),
        layers: [d(layer, "application/vnd.oci.image.layer.v1.tar+gzip")],
      },
      null,
      3,
    ),
  );
}

async function bytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

describe("docker mirrors", () => {
  let reg: DockerTestRegistry;
  let fake: FakeUpstream;
  const repos: Record<string, Repo> = {};
  const config = Buffer.from(JSON.stringify({ os: "linux", architecture: "amd64" }));
  const layer = randomBlob(7, 64 * 1024);
  const manifest = manifestOf(config, layer);
  let manifestDigest = "";
  const alpine = manifestOf(Buffer.from("{}"), randomBlob(8, 10));
  const redirected = randomBlob(9, 4096);
  const bad = randomBlob(10, 5000);
  const otherLayer = randomBlob(11, 3000);

  async function assetRows(repo: string, path?: string) {
    return reg.deps.db
      .select({ path: asset.path, sha256: asset.sha256 })
      .from(asset)
      .where(and(eq(asset.repositoryId, repos[repo]!.id), path === undefined ? undefined : eq(asset.path, path)));
  }

  beforeAll(async () => {
    fake = await startFakeUpstream();
    manifestDigest = fake.addManifest("library/nginx", "latest", manifest, OCI_MANIFEST);
    fake.addManifest("library/nginx", "1.0", manifestOf(config, randomBlob(1, 10)), OCI_MANIFEST);
    fake.addManifest("library/nginx", "1.1", manifestOf(config, randomBlob(2, 10)), OCI_MANIFEST);
    fake.addBlob("library/nginx", config);
    fake.addBlob("library/nginx", layer);
    fake.addBlob("library/nginx", otherLayer);
    fake.addManifest("library/alpine", "3", alpine, OCI_MANIFEST);
    fake.addBlob("library/redir", redirected, { redirect: true });
    fake.addBlob("library/bad", bad);
    fake.tamper(`/v2/library/bad/blobs/${digestOf(bad)}`, Buffer.alloc(bad.length, 1));
    fake.rateLimited.add("library/busy");
    fake.locked.add("library/locked");

    reg = await startDockerTestRegistry();
    const mirror = (name: string, cfg: unknown, visibility: "public" | "private" = "public") =>
      reg.createRepo({ name, format: "docker", kind: "mirror", visibility, upstreams: [{ url: fake.url, authType: "none" }], config: cfg });
    repos.hub = await mirror("hub", { dockerHub: true });
    repos.hubc = await mirror("hubc", { dockerHub: true, cache: { enabled: true, metadataTtlSeconds: 0 } });
    repos.hubdeny = await mirror("hubdeny", { dockerHub: true, rules: { deny: ["library/*"] } });
    repos.priv = await mirror("priv", {}, "private");
  });
  afterAll(async () => {
    await reg?.stop();
    await fake?.close();
  });
  beforeEach(() => fake.reset());

  it("pulls manifest by tag through a dockerHub mirror mapping nginx → library/nginx", async () => {
    const res = await reg.call("GET", "hub/nginx/manifests/latest");
    expect(res.status).toBe(200);
    expect((await bytes(res)).equals(manifest)).toBe(true);
    expect(res.headers.get("content-type")).toBe(OCI_MANIFEST);
    expect(res.headers.get("docker-content-digest")).toBe(manifestDigest);
    expect(res.headers.get("content-length")).toBe(String(manifest.length));
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    expect(res.headers.get("x-upstream-only")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(fake.hits("/v2/library/nginx/manifests/latest")).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.headers.accept?.includes(OCI_MANIFEST))).toBe(true);
  });

  it("HEAD of a manifest answers its digest without a body", async () => {
    const res = await reg.call("HEAD", "hub/nginx/manifests/latest");
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(manifestDigest);
    expect(await res.text()).toBe("");
    expect(fake.requests.every((r) => r.method === "HEAD")).toBe(true);
  });

  it("second manifest request reuses the cached upstream token (one token fetch)", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await reg.call("GET", "hub/alpine/manifests/3");
      expect(res.status).toBe(200);
      expect((await bytes(res)).equals(alpine)).toBe(true);
    }
    expect(fake.tokenRequests).toHaveLength(1);
    expect(fake.hits("/v2/library/alpine/manifests/3")).toBe(3);
  });

  it("cache off: blob streamed, no asset row", async () => {
    const res = await reg.call("GET", `hub/nginx/blobs/${digestOf(layer)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digestOf(layer));
    expect((await bytes(res)).equals(layer)).toBe(true);
    await reg.deps.mirror.drain();
    expect(await assetRows("hub")).toHaveLength(0);
  });

  it("cache on: blob served from cache on the second GET without upstream contact", async () => {
    const path = `hubc/nginx/blobs/${digestOf(layer)}`;
    expect((await bytes(await reg.call("GET", path))).equals(layer)).toBe(true);
    await reg.deps.mirror.drain();
    fake.reset();
    const res = await reg.call("GET", path);
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digestOf(layer));
    expect(res.headers.get("content-length")).toBe(String(layer.length));
    expect((await bytes(res)).equals(layer)).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it("tag manifest is metadata: refetched after ttl", async () => {
    await bytes(await reg.call("GET", "hubc/nginx/manifests/latest"));
    await reg.deps.mirror.drain();
    fake.reset();
    const res = await reg.call("GET", "hubc/nginx/manifests/latest");
    expect((await bytes(res)).equals(manifest)).toBe(true);
    expect(fake.hits("/v2/library/nginx/manifests/latest")).toBeGreaterThan(0);
  });

  it("digest manifest is immutable: not refetched after ttl", async () => {
    await bytes(await reg.call("GET", `hubc/nginx/manifests/${manifestDigest}`));
    await reg.deps.mirror.drain();
    fake.reset();
    const res = await reg.call("GET", `hubc/nginx/manifests/${manifestDigest}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(manifestDigest);
    expect(res.headers.get("content-type")).toBe(OCI_MANIFEST);
    expect((await bytes(res)).equals(manifest)).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it('deny rule "library/*" answers 404 without upstream contact', async () => {
    const res = await reg.call("GET", "hubdeny/nginx/manifests/latest");
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe("MANIFEST_UNKNOWN");
    expect(fake.requests).toHaveLength(0);
  });

  it("follows blob redirect without forwarding authorization", async () => {
    const res = await reg.call("GET", `hub/redir/blobs/${digestOf(redirected)}`);
    expect(res.status).toBe(200);
    expect((await bytes(res)).equals(redirected)).toBe(true);
    expect(fake.cdnRequests).toHaveLength(1);
    expect(fake.cdnRequests[0]!.headers.authorization).toBeUndefined();
    expect(fake.requests.at(-1)!.headers.authorization).toMatch(/^Bearer tok-/);
  });

  it("range request on a cached blob → 206 from the asset", async () => {
    const path = `hubc/nginx/blobs/${digestOf(layer)}`;
    await bytes(await reg.call("GET", path));
    await reg.deps.mirror.drain();
    fake.reset();
    const res = await reg.call("GET", path, { headers: { range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${layer.length}`);
    expect(res.headers.get("content-length")).toBe("10");
    expect((await bytes(res)).equals(layer.subarray(10, 20))).toBe(true);
    expect(fake.requests).toHaveLength(0);
  });

  it("range request uncached → 200 full body", async () => {
    const res = await reg.call("GET", `hub/nginx/blobs/${digestOf(layer)}`, { headers: { range: "bytes=10-19" } });
    expect(res.status).toBe(200);
    expect((await bytes(res)).equals(layer)).toBe(true);
    expect(fake.requests.every((r) => r.headers.range === undefined)).toBe(true);
  });

  it("cached blob with wrong sha256 is deleted and refetched", async () => {
    const digest = digestOf(otherLayer);
    const path = `v2/library/nginx/blobs/${digest}`;
    await bytes(await reg.call("GET", `hubc/nginx/blobs/${digest}`));
    await reg.deps.mirror.drain();
    await reg.deps.db.update(asset).set({ sha256: "0".repeat(64) }).where(and(eq(asset.repositoryId, repos.hubc!.id), eq(asset.path, path)));
    fake.reset();
    const res = await reg.call("GET", `hubc/nginx/blobs/${digest}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digest);
    expect((await bytes(res)).equals(otherLayer)).toBe(true);
    expect(fake.hits(`/v2/library/nginx/blobs/${digest}`)).toBeGreaterThan(0);
    await reg.deps.mirror.drain();
    expect(await assetRows("hubc", path)).toEqual([{ path, sha256: digest.slice("sha256:".length) }]);
  });

  it("upstream bytes that do not match the digest are neither served whole nor cached", async () => {
    const digest = digestOf(bad);
    const res = await reg.call("GET", `hubc/bad/blobs/${digest}`);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
    await reg.deps.mirror.drain();
    expect(await assetRows("hubc", `v2/library/bad/blobs/${digest}`)).toHaveLength(0);
  });

  it("tags/list Link header is rewritten to the weaver name", async () => {
    const res = await reg.call("GET", "hub/nginx/tags/list?n=2");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tags: string[] }).tags).toEqual(["1.0", "1.1"]);
    expect(res.headers.get("link")).toBe('</v2/hub/nginx/tags/list?n=2&last=1.1>; rel="next"');
    expect(fake.hits("/v2/library/nginx/tags/list")).toBeGreaterThan(0);
  });

  it("only the paging parameters of a tags/list query reach the upstream (containerd adds ns=)", async () => {
    const res = await reg.call("GET", "hub/nginx/tags/list?ns=docker.io&n=2");
    expect(res.status).toBe(200);
    await res.body?.cancel();
    const seen = fake.requests.filter((r) => r.url.startsWith("/v2/library/nginx/tags/list"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.url === "/v2/library/nginx/tags/list?n=2")).toBe(true);
  });

  it("upstream referrers 404 → 404", async () => {
    const res = await reg.call("GET", `hub/nginx/referrers/${manifestDigest}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("upstream 429 → 429 TOOMANYREQUESTS", async () => {
    const res = await reg.call("GET", "hub/busy/manifests/latest");
    expect(res.status).toBe(429);
    expect(await errorCodeOf(res)).toBe("TOOMANYREQUESTS");
  });

  it("an upstream 401 is never passed on as a challenge: 502 UNAVAILABLE", async () => {
    const res = await reg.call("GET", "hub/locked/manifests/latest");
    expect(res.status).toBe(502);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await errorCodeOf(res)).toBe("UNAVAILABLE");
  });

  it("a Docker Hub 401 insufficient_scope for a missing image is 404, and the realm is not asked again within 60 s", async () => {
    fake.missing.add("library/ghost");
    const first = await reg.call("GET", "hub/ghost/manifests/latest");
    expect(first.status).toBe(404);
    expect(await errorCodeOf(first)).toBe("MANIFEST_UNKNOWN");
    expect(first.headers.get("www-authenticate")).toBeNull();
    const head = await reg.call("HEAD", "hub/ghost/manifests/latest");
    expect(head.status).toBe(404);
    await head.body?.cancel();
    const blob = await reg.call("GET", `hub/ghost/blobs/sha256:${"d".repeat(64)}`);
    expect(blob.status).toBe(404);
    expect(await errorCodeOf(blob)).toBe("BLOB_UNKNOWN");
    expect(fake.tokenRequests.filter((r) => r.url.includes("library%2Fghost") || r.url.includes("library/ghost"))).toHaveLength(1);
  });

  it("a missing-image 401 serves the cached copy when there is one", async () => {
    const gone = manifestOf(Buffer.from("{}"), randomBlob(12, 10));
    fake.addManifest("library/gone", "latest", gone, OCI_MANIFEST);
    await bytes(await reg.call("GET", "hubc/gone/manifests/latest"));
    await reg.deps.mirror.drain();
    fake.missing.add("library/gone");
    const res = await reg.call("GET", "hubc/gone/manifests/latest");
    expect(res.status).toBe(200);
    expect((await bytes(res)).equals(gone)).toBe(true);
    expect(fake.hits("/v2/library/gone/manifests/latest")).toBeGreaterThan(1);
  });

  it("serves a multi-arch image index from the cache with its content type and digest", async () => {
    const amd = manifestOf(Buffer.from('{"architecture":"amd64","os":"linux"}'), randomBlob(13, 10));
    const arm = manifestOf(Buffer.from('{"architecture":"arm64","os":"linux"}'), randomBlob(14, 10));
    const amdDigest = fake.addManifest("library/multi", null, amd, OCI_MANIFEST);
    const armDigest = fake.addManifest("library/multi", null, arm, OCI_MANIFEST);
    const index = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [
          { mediaType: OCI_MANIFEST, digest: amdDigest, size: amd.length, platform: { os: "linux", architecture: "amd64" } },
          { mediaType: OCI_MANIFEST, digest: armDigest, size: arm.length, platform: { os: "linux", architecture: "arm64" } },
        ],
      }),
    );
    const indexDigest = fake.addManifest("library/multi", "latest", index, OCI_INDEX);

    const byTag = await reg.call("GET", "hubc/multi/manifests/latest");
    expect(byTag.headers.get("content-type")).toBe(OCI_INDEX);
    expect(byTag.headers.get("docker-content-digest")).toBe(indexDigest);
    await bytes(byTag);
    await bytes(await reg.call("GET", `hubc/multi/manifests/${indexDigest}`));
    await bytes(await reg.call("GET", `hubc/multi/manifests/${armDigest}`));
    await reg.deps.mirror.drain();
    fake.reset();

    const cached = await reg.call("GET", `hubc/multi/manifests/${indexDigest}`);
    expect(cached.status).toBe(200);
    expect(cached.headers.get("content-type")).toBe(OCI_INDEX);
    expect(cached.headers.get("docker-content-digest")).toBe(indexDigest);
    expect((await bytes(cached)).equals(index)).toBe(true);
    const head = await reg.call("HEAD", `hubc/multi/manifests/${indexDigest}`);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(OCI_INDEX);
    expect(head.headers.get("docker-content-digest")).toBe(indexDigest);
    expect(head.headers.get("content-length")).toBe(String(index.length));
    const child = await reg.call("GET", `hubc/multi/manifests/${armDigest}`);
    expect((await bytes(child)).equals(arm)).toBe(true);
    expect(fake.requests).toHaveLength(0);

    const tagHead = await reg.call("HEAD", "hubc/multi/manifests/latest");
    expect(tagHead.headers.get("docker-content-digest")).toBe(indexDigest);
    expect(tagHead.headers.get("content-type")).toBe(OCI_INDEX);
  });

  it("a HEAD of a tag on a caching mirror caches the manifest, so the tag resolves while the upstream fails", async () => {
    // docker and containerd resolve a tag with HEAD only and fetch the manifest by digest afterwards.
    const body = manifestOf(Buffer.from('{"architecture":"amd64","os":"linux"}'), randomBlob(15, 10));
    const digest = fake.addManifest("library/headonly", "1", body, OCI_MANIFEST);
    const first = await reg.call("HEAD", "hubc/headonly/manifests/1");
    expect(first.status).toBe(200);
    expect(first.headers.get("docker-content-digest")).toBe(digest);
    expect(first.headers.get("content-length")).toBe(String(body.length));
    expect(await first.text()).toBe("");
    await reg.deps.mirror.drain();
    expect(await assetRows("hubc", "v2/library/headonly/manifests/1")).toHaveLength(1);

    fake.rateLimited.add("library/headonly");
    try {
      const down = await reg.call("HEAD", "hubc/headonly/manifests/1");
      expect(down.status).toBe(200);
      expect(down.headers.get("docker-content-digest")).toBe(digest);
      expect(down.headers.get("content-type")).toBe(OCI_MANIFEST);
      expect(await down.text()).toBe("");
    } finally {
      fake.rateLimited.delete("library/headonly");
    }
  });

  it("referrers through a caching mirror whose upstream is unreachable are an empty index, not 502", async () => {
    // docker (containerd image store) asks for referrers while pulling; a 502 there fails a pull the cache could serve.
    const down = await reg.createRepo({
      name: "hubdown",
      format: "docker",
      kind: "mirror",
      visibility: "public",
      upstreams: [{ url: "http://127.0.0.1:1", authType: "none" }],
      config: { dockerHub: true, cache: { enabled: true } },
    });
    expect(down.name).toBe("hubdown");
    const res = await reg.call("GET", `hubdown/nginx/referrers/sha256:${"a".repeat(64)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(OCI_INDEX);
    expect(JSON.parse(await res.text())).toEqual({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [] });

    const uncached = await reg.call("GET", `hub/locked/referrers/sha256:${"a".repeat(64)}`);
    expect(uncached.status).toBe(502);
    expect(await errorCodeOf(uncached)).toBe("UNAVAILABLE");
  });

  it("an unknown upstream manifest is 404 MANIFEST_UNKNOWN and an unknown blob 404 BLOB_UNKNOWN", async () => {
    const m = await reg.call("GET", "hub/nginx/manifests/missing");
    expect(m.status).toBe(404);
    expect(await errorCodeOf(m)).toBe("MANIFEST_UNKNOWN");
    const b = await reg.call("GET", `hub/nginx/blobs/sha256:${"e".repeat(64)}`);
    expect(b.status).toBe(404);
    expect(await errorCodeOf(b)).toBe("BLOB_UNKNOWN");
  });

  it("the client's authorization never reaches the upstream", async () => {
    const token = reg.tokenFor([{ repo: "priv", access: "read" }]);
    const res = await reg.call("GET", "priv/library/nginx/manifests/latest", { token });
    expect(res.status).toBe(200);
    expect((await bytes(res)).equals(manifest)).toBe(true);
    for (const r of [...fake.requests, ...fake.tokenRequests]) {
      expect(r.headers.authorization ?? "").not.toContain(Buffer.from(`x:${token}`).toString("base64"));
    }
    expect((await reg.call("GET", "priv/library/nginx/manifests/latest")).status).toBe(401);
  });

  it("records downloads with the cache result", async () => {
    reg.usage.length = 0;
    await bytes(await reg.call("GET", `hub/nginx/blobs/${digestOf(config)}`));
    expect(reg.usage).toEqual([
      expect.objectContaining({ repositoryId: repos.hub!.id, action: "download", cache: "bypass", path: `nginx/blobs/${digestOf(config)}` }),
    ]);
  });

  it("push to a mirror → 405 UNSUPPORTED", async () => {
    const token = reg.tokenFor([{ repo: "hub", access: "write" }]);
    const res = await reg.call("POST", "hub/nginx/blobs/uploads/", { token });
    expect(res.status).toBe(405);
    expect(await errorCodeOf(res)).toBe("UNSUPPORTED");
    const put = await reg.call("PUT", "hub/nginx/manifests/latest", { token, body: manifest, headers: { "content-type": OCI_MANIFEST } });
    expect(put.status).toBe(405);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("docker mirror negative cache", () => {
  let reg: DockerTestRegistry;
  let fake: FakeUpstream;
  let clock = new Date("2026-10-22T10:00:00Z");
  const late = manifestOf(Buffer.from("{}"), randomBlob(21, 10));

  beforeAll(async () => {
    fake = await startFakeUpstream();
    fake.addManifest("library/late", "latest", late, OCI_MANIFEST);
    reg = await startDockerTestRegistry({ dockerOptions: { now: () => clock } });
    await reg.createRepo({
      name: "hub",
      format: "docker",
      kind: "mirror",
      visibility: "public",
      upstreams: [{ url: fake.url, authType: "none" }],
      config: { dockerHub: true },
    });
  });
  afterAll(async () => {
    await reg?.stop();
    await fake?.close();
  });

  it("an image that appears upstream is served once the 60 s negative cache ends, despite a token issued while it was missing", async () => {
    fake.missing.add("library/late");
    const first = await reg.call("GET", "hub/late/manifests/latest");
    expect(first.status).toBe(404);
    await first.body?.cancel();
    fake.missing.delete("library/late");

    clock = new Date(clock.getTime() + 30_000);
    const during = await reg.call("GET", "hub/late/manifests/latest");
    expect(during.status).toBe(404);
    await during.body?.cancel();
    expect(fake.tokenRequests).toHaveLength(1);

    clock = new Date(clock.getTime() + 31_000);
    const after = await reg.call("GET", "hub/late/manifests/latest");
    expect(after.status).toBe(200);
    expect((await bytes(after)).equals(late)).toBe(true);
    expect(fake.tokenRequests).toHaveLength(2);
  });
});

describe("docker root mirror", () => {
  let reg: DockerTestRegistry;
  let fake: FakeUpstream;
  const manifest = manifestOf(Buffer.from("{}"), randomBlob(3, 100));
  let digest = "";

  beforeAll(async () => {
    fake = await startFakeUpstream();
    digest = fake.addManifest("library/nginx", "latest", manifest, OCI_MANIFEST);
    reg = await startDockerTestRegistry();
    await reg.createRepo({
      name: "dockerhub",
      format: "docker",
      kind: "mirror",
      visibility: "public",
      dockerRoot: true,
      upstreams: [{ url: fake.url, authType: "none" }],
      config: { dockerHub: true },
    });
  });
  afterAll(async () => {
    await reg?.stop();
    await fake?.close();
  });

  it("GET /v2/library/nginx/manifests/latest is served by the root mirror", async () => {
    const res = await reg.call("GET", "library/nginx/manifests/latest");
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digest);
    expect((await bytes(res)).equals(manifest)).toBe(true);
  });

  it("GET /v2/nginx/manifests/latest maps to library/nginx when the root is a dockerHub mirror", async () => {
    fake.reset();
    const res = await reg.call("GET", "nginx/manifests/latest");
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digest);
    expect((await bytes(res)).equals(manifest)).toBe(true);
    expect(fake.hits("/v2/library/nginx/manifests/latest")).toBeGreaterThan(0);
    expect(fake.hits("/v2/nginx/manifests/latest")).toBe(0);
  });

  it("the Link header of the root mirror keeps the client's unprefixed name", async () => {
    fake.addManifest("library/nginx", "a", manifestOf(Buffer.from("{}"), randomBlob(4, 10)), OCI_MANIFEST);
    const res = await reg.call("GET", "nginx/tags/list?n=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("link")).toBe('</v2/nginx/tags/list?n=1&last=a>; rel="next"');
    await res.body?.cancel();
  });
});

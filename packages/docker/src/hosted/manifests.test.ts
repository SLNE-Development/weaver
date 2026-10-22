import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerManifest, dockerTag } from "@weaver/db";
import {
  descriptorOf,
  digestOf,
  errorCodeOf,
  pushBlob,
  pushManifest,
  randomBlob,
  startDockerTestRegistry,
  type DockerTestRegistry,
} from "../testing.js";
import { findManifest } from "./manifests.js";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_V2 = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

interface Platform {
  os: string;
  architecture: string;
  variant?: string;
}

describe("hosted manifests", () => {
  let reg: DockerTestRegistry;
  let key: string;
  let repoId: string;
  /** Runs inside a manifest PUT's transaction at each step, when set by a test. */
  let hook: ((step: "begin" | "inserted" | "resolved") => Promise<void>) | null = null;
  beforeAll(async () => {
    reg = await startDockerTestRegistry({
      dockerOptions: { onManifestPutStep: (step) => (hook ? hook(step) : Promise.resolve()) },
    });
    const repo = await reg.createRepo({ name: "hosted", format: "docker", kind: "hosted" });
    repoId = repo.id;
    await reg.createRepo({ name: "immut", format: "docker", kind: "hosted", config: { tagImmutable: true } });
    key = reg.tokenFor([
      { repo: "hosted", access: "write" },
      { repo: "immut", access: "write" },
    ]);
  });
  afterAll(async () => {
    await reg?.stop();
  });

  /** Pushes a config and one layer to `name`, resolving to an OCI image manifest referencing them. */
  async function image(name: string, seed: number, platform: Platform = { os: "linux", architecture: "amd64" }) {
    const config = Buffer.from(JSON.stringify({ ...platform, rootfs: { type: "layers", diff_ids: [] }, seed }));
    const layer = randomBlob(seed, 1000);
    expect((await pushBlob(reg, name, config, key)).status).toBe(201);
    expect((await pushBlob(reg, name, layer, key)).status).toBe(201);
    return {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: descriptorOf(config, OCI_CONFIG),
      layers: [descriptorOf(layer, OCI_LAYER)],
    };
  }

  function bytesOf(manifest: unknown): Buffer {
    return Buffer.from(JSON.stringify(manifest));
  }

  async function row(image: string, digest: string) {
    const [r] = await reg.deps.db
      .select()
      .from(dockerManifest)
      .where(and(eq(dockerManifest.repositoryId, repoId), eq(dockerManifest.image, image), eq(dockerManifest.digest, digest)));
    return r;
  }

  it("push image by tag then GET by tag and by digest returns identical bytes and headers", async () => {
    const manifest = await image("hosted/app", 1);
    const body = bytesOf(manifest);
    const digest = digestOf(body);
    const put = await pushManifest(reg, "hosted/app", "v1", manifest, key);
    expect(put.status).toBe(201);
    expect(put.headers.get("location")).toBe(`/v2/hosted/app/manifests/${digest}`);
    expect(put.headers.get("docker-content-digest")).toBe(digest);
    expect(put.headers.get("oci-subject")).toBeNull();
    expect(put.headers.get("docker-distribution-api-version")).toBe("registry/2.0");

    const byTag = await reg.call("GET", "hosted/app/manifests/v1", { token: key });
    const byDigest = await reg.call("GET", `hosted/app/manifests/${digest}`, { token: key });
    for (const res of [byTag, byDigest]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(OCI_MANIFEST);
      expect(res.headers.get("content-length")).toBe(String(body.length));
      expect(res.headers.get("docker-content-digest")).toBe(digest);
      expect(res.headers.get("etag")).toBe(`"${digest}"`);
      expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(body);
    }
    const stored = await row("app", digest);
    expect(stored!.pullCount).toBe(2);
    expect(stored!.lastPulledAt).not.toBeNull();
    const [tag] = await reg.deps.db.select().from(dockerTag).where(eq(dockerTag.tag, "v1"));
    expect(tag!.lastPulledAt).not.toBeNull();
    expect(reg.usage).toContainEqual(
      expect.objectContaining({ action: "download", path: "app/manifests/v1", bytes: body.length }),
    );
  });

  it("stores and serves exact manifest bytes", async () => {
    const manifest = await image("hosted/exact", 2);
    const reordered = { layers: manifest.layers, config: manifest.config, mediaType: manifest.mediaType, schemaVersion: 2 };
    const body = Buffer.from(`${JSON.stringify(reordered, null, 3)}\n`);
    const clientDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const put = await pushManifest(reg, "hosted/exact", "odd", body, key, OCI_MANIFEST);
    expect(put.status).toBe(201);
    expect(put.headers.get("docker-content-digest")).toBe(clientDigest);
    const get = await reg.call("GET", "hosted/exact/manifests/odd", { token: key });
    const served = Buffer.from(await get.arrayBuffer());
    expect(served.equals(body)).toBe(true);
    expect(get.headers.get("docker-content-digest")).toBe(clientDigest);
    expect((await findManifest(reg.deps.db, repoId, "exact", clientDigest))!.content.equals(body)).toBe(true);
  });

  it("manifest referencing an unlinked layer → 400 MANIFEST_BLOB_UNKNOWN", async () => {
    const manifest = await image("hosted/missing", 3);
    manifest.layers.push(descriptorOf(randomBlob(99, 50), OCI_LAYER));
    const res = await pushManifest(reg, "hosted/missing", "v1", manifest, key);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("MANIFEST_BLOB_UNKNOWN");
    // A blob linked in another image of the same repository is not visible either.
    const other = await image("hosted/missing-other", 4);
    const res2 = await pushManifest(reg, "hosted/missing-elsewhere", "v1", other, key);
    expect(res2.status).toBe(400);
    expect(await errorCodeOf(res2)).toBe("MANIFEST_BLOB_UNKNOWN");
  });

  it("foreign layer with urls is not required", async () => {
    const config = Buffer.from(JSON.stringify({ os: "windows", architecture: "amd64" }));
    expect((await pushBlob(reg, "hosted/win", config, key)).status).toBe(201);
    const manifest = {
      schemaVersion: 2,
      mediaType: DOCKER_V2,
      config: descriptorOf(config, "application/vnd.docker.container.image.v1+json"),
      layers: [
        {
          ...descriptorOf(randomBlob(5, 2000), "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip"),
          urls: ["https://mcr.microsoft.com/v2/windows/blobs/x"],
        },
      ],
    };
    const res = await pushManifest(reg, "hosted/win", "ltsc", manifest, key);
    expect(res.status).toBe(201);
  });

  it("multi-arch index whose children were pushed by digest first", async () => {
    const amd = await image("hosted/multi", 6, { os: "linux", architecture: "amd64" });
    const arm = await image("hosted/multi", 7, { os: "linux", architecture: "arm64", variant: "v8" });
    for (const m of [amd, arm]) {
      const res = await pushManifest(reg, "hosted/multi", digestOf(bytesOf(m)), m, key);
      expect(res.status).toBe(201);
    }
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        { ...descriptorOf(bytesOf(amd), OCI_MANIFEST), platform: { os: "linux", architecture: "amd64" } },
        { ...descriptorOf(bytesOf(arm), OCI_MANIFEST), platform: { os: "linux", architecture: "arm64", variant: "v8" } },
      ],
    };
    const put = await pushManifest(reg, "hosted/multi", "latest", index, key);
    expect(put.status).toBe(201);
    const stored = await row("multi", digestOf(bytesOf(index)));
    expect(stored!.platforms).toEqual([
      { os: "linux", architecture: "amd64" },
      { os: "linux", architecture: "arm64", variant: "v8" },
    ]);
    const get = await reg.call("GET", "hosted/multi/manifests/latest", { token: key });
    expect(get.headers.get("content-type")).toBe(OCI_INDEX);
  });

  it("index with a missing child → 400 MANIFEST_UNKNOWN", async () => {
    const child = await image("hosted/orphan", 8);
    const index = { schemaVersion: 2, mediaType: OCI_INDEX, manifests: [descriptorOf(bytesOf(child), OCI_MANIFEST)] };
    const res = await pushManifest(reg, "hosted/orphan", "latest", index, key);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("MANIFEST_UNKNOWN");
  });

  it("platforms are read from the config blob and from index entries", async () => {
    const manifest = await image("hosted/arm", 9, { os: "linux", architecture: "arm64", variant: "v8" });
    expect((await pushManifest(reg, "hosted/arm", "v1", manifest, key)).status).toBe(201);
    const stored = await row("arm", digestOf(bytesOf(manifest)));
    expect(stored!.platforms).toEqual([{ os: "linux", architecture: "arm64", variant: "v8" }]);
    expect(stored!.totalSize).toBe(manifest.config.size + manifest.layers[0]!.size);

    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [{ ...descriptorOf(bytesOf(manifest), OCI_MANIFEST), platform: { os: "linux", architecture: "arm64", variant: "v8" } }],
    };
    expect((await pushManifest(reg, "hosted/arm", "multi", index, key)).status).toBe(201);
    const storedIndex = await row("arm", digestOf(bytesOf(index)));
    expect(storedIndex!.platforms).toEqual([{ os: "linux", architecture: "arm64", variant: "v8" }]);
  });

  it("PUT by digest with mismatching bytes → 400 DIGEST_INVALID", async () => {
    const manifest = await image("hosted/mismatch", 10);
    const res = await pushManifest(reg, "hosted/mismatch", digestOf(Buffer.from("other")), manifest, key);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("DIGEST_INVALID");
  });

  it("over 4 MiB → 413 SIZE_INVALID", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    const res = await pushManifest(reg, "hosted/big", "v1", big, key, OCI_MANIFEST);
    expect(res.status).toBe(413);
    expect(await errorCodeOf(res)).toBe("SIZE_INVALID");
    // Also without a Content-Length, streamed.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    const res2 = await reg.call("PUT", "hosted/big/manifests/v2", {
      token: key,
      body: stream,
      headers: { "content-type": OCI_MANIFEST },
    });
    expect(res2.status).toBe(413);
    expect(res2.headers.get("content-length")).not.toBe("0");
    expect(await errorCodeOf(res2)).toBe("SIZE_INVALID");
  });

  it("tagImmutable rejects moving a tag with 403 DENIED but accepts the same digest", async () => {
    const first = await image("immut/app", 11);
    const second = await image("immut/app", 12);
    expect((await pushManifest(reg, "immut/app", "v1", first, key)).status).toBe(201);
    expect((await pushManifest(reg, "immut/app", "v1", first, key)).status).toBe(201);
    const moved = await pushManifest(reg, "immut/app", "v1", second, key);
    expect(moved.status).toBe(403);
    expect(await errorCodeOf(moved)).toBe("DENIED");
    const get = await reg.call("GET", "immut/app/manifests/v1", { token: key });
    expect(get.headers.get("docker-content-digest")).toBe(digestOf(bytesOf(first)));
    // Mutable repositories move tags.
    const a = await image("hosted/mutable", 13);
    const b = await image("hosted/mutable", 14);
    expect((await pushManifest(reg, "hosted/mutable", "v1", a, key)).status).toBe(201);
    expect((await pushManifest(reg, "hosted/mutable", "v1", b, key)).status).toBe(201);
    const after = await reg.call("GET", "hosted/mutable/manifests/v1", { token: key });
    expect(after.headers.get("docker-content-digest")).toBe(digestOf(bytesOf(b)));
  });

  it("HEAD has no body and the same headers as GET", async () => {
    const manifest = await image("hosted/head", 15);
    expect((await pushManifest(reg, "hosted/head", "v1", manifest, key)).status).toBe(201);
    const usageBefore = reg.usage.length;
    const head = await reg.call("HEAD", "hosted/head/manifests/v1", { token: key });
    expect(reg.usage.length).toBe(usageBefore);
    const get = await reg.call("GET", "hosted/head/manifests/v1", { token: key });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const h of ["content-type", "content-length", "docker-content-digest", "etag", "docker-distribution-api-version"]) {
      expect(head.headers.get(h)).toBe(get.headers.get(h));
    }
  });

  it("HEAD by tag stamps the tag's lastPulledAt only, without pullCount or usage", async () => {
    const manifest = await image("hosted/headtag", 19);
    const digest = digestOf(bytesOf(manifest));
    expect((await pushManifest(reg, "hosted/headtag", "v1", manifest, key)).status).toBe(201);
    const tagRow = () =>
      reg.deps.db
        .select()
        .from(dockerTag)
        .where(and(eq(dockerTag.repositoryId, repoId), eq(dockerTag.image, "headtag"), eq(dockerTag.tag, "v1")))
        .then((rows) => rows[0]!);
    expect((await tagRow()).lastPulledAt).toBeNull();
    const usageBefore = reg.usage.length;
    expect((await reg.call("HEAD", "hosted/headtag/manifests/v1", { token: key })).status).toBe(200);
    expect((await tagRow()).lastPulledAt).not.toBeNull();
    const stored = await row("headtag", digest);
    expect(stored!.pullCount).toBe(0);
    expect(stored!.lastPulledAt).toBeNull();
    expect(reg.usage.length).toBe(usageBefore);
    // HEAD by digest stamps nothing.
    expect((await reg.call("HEAD", `hosted/headtag/manifests/${digest}`, { token: key })).status).toBe(200);
    expect((await row("headtag", digest))!.lastPulledAt).toBeNull();
  });

  it("config with urls must still be a linked blob", async () => {
    const layer = randomBlob(20, 100);
    expect((await pushBlob(reg, "hosted/cfgurls", layer, key)).status).toBe(201);
    const manifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { ...descriptorOf(Buffer.from('{"os":"linux"}'), OCI_CONFIG), urls: ["https://example.com/config"] },
      layers: [descriptorOf(layer, OCI_LAYER)],
    };
    const res = await pushManifest(reg, "hosted/cfgurls", "v1", manifest, key);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("MANIFEST_BLOB_UNKNOWN");
  });

  it("generic Content-Type is accepted when the body declares mediaType", async () => {
    const manifest = await image("hosted/generic", 21);
    for (const type of ["application/json", "application/octet-stream"]) {
      const res = await pushManifest(reg, "hosted/generic", "v1", manifest, key, type);
      expect(res.status).toBe(201);
    }
    const get = await reg.call("GET", "hosted/generic/manifests/v1", { token: key });
    expect(get.headers.get("content-type")).toBe(OCI_MANIFEST);
  });

  /** Deletes manifest `digest` of `image` from a separate connection, as a concurrent DELETE would. */
  function concurrentDelete(img: string, digest: string, at: "inserted" | "resolved") {
    let fired = false;
    return async (step: "begin" | "inserted" | "resolved") => {
      if (fired || step !== at) return;
      fired = true;
      await reg.deps.db
        .delete(dockerManifest)
        .where(and(eq(dockerManifest.repositoryId, repoId), eq(dockerManifest.image, img), eq(dockerManifest.digest, digest)));
    };
  }

  for (const at of ["inserted", "resolved"] as const) {
    it(`re-push racing a DELETE by digest (${at}) still stores the manifest and tag`, async () => {
      const manifest = await image("hosted/race", at === "inserted" ? 22 : 23);
      const digest = digestOf(bytesOf(manifest));
      expect((await pushManifest(reg, "hosted/race", "v1", manifest, key)).status).toBe(201);
      hook = concurrentDelete("race", digest, at);
      try {
        const res = await pushManifest(reg, "hosted/race", "v2", manifest, key);
        expect(res.status).toBe(201);
      } finally {
        hook = null;
      }
      const get = await reg.call("GET", "hosted/race/manifests/v2", { token: key });
      expect(get.status).toBe(200);
      expect(get.headers.get("docker-content-digest")).toBe(digest);
    });
  }

  it("DELETE by tag removes the tag only", async () => {
    const manifest = await image("hosted/deltag", 16);
    const digest = digestOf(bytesOf(manifest));
    expect((await pushManifest(reg, "hosted/deltag", "v1", manifest, key)).status).toBe(201);
    const del = await reg.call("DELETE", "hosted/deltag/manifests/v1", { token: key });
    expect(del.status).toBe(202);
    expect((await reg.call("GET", "hosted/deltag/manifests/v1", { token: key })).status).toBe(404);
    expect((await reg.call("GET", `hosted/deltag/manifests/${digest}`, { token: key })).status).toBe(200);
    expect((await reg.call("DELETE", "hosted/deltag/manifests/v1", { token: key })).status).toBe(404);
  });

  it("DELETE by digest removes manifest and its tags", async () => {
    const manifest = await image("hosted/deldigest", 17);
    const digest = digestOf(bytesOf(manifest));
    expect((await pushManifest(reg, "hosted/deldigest", "v1", manifest, key)).status).toBe(201);
    expect((await pushManifest(reg, "hosted/deldigest", "v2", manifest, key)).status).toBe(201);
    const del = await reg.call("DELETE", `hosted/deldigest/manifests/${digest}`, { token: key });
    expect(del.status).toBe(202);
    for (const ref of ["v1", "v2", digest]) {
      const res = await reg.call("GET", `hosted/deldigest/manifests/${ref}`, { token: key });
      expect(res.status).toBe(404);
    }
    expect(await row("deldigest", digest)).toBeUndefined();
  });

  it("unknown tag → 404 MANIFEST_UNKNOWN", async () => {
    const res = await reg.call("GET", "hosted/app/manifests/nope", { token: key });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe("MANIFEST_UNKNOWN");
    const head = await reg.call("HEAD", `hosted/app/manifests/${digestOf(Buffer.from("x"))}`, { token: key });
    expect(head.status).toBe(404);
  });

  it("invalid manifest body → 400 MANIFEST_INVALID", async () => {
    const res = await pushManifest(reg, "hosted/app", "bad", Buffer.from("{nope"), key, OCI_MANIFEST);
    expect(res.status).toBe(400);
    expect(await errorCodeOf(res)).toBe("MANIFEST_INVALID");
  });

  it("push needs push access and a read-only key gets 403", async () => {
    const reader = reg.tokenFor([{ repo: "hosted", access: "read" }]);
    const manifest = await image("hosted/ro", 18);
    const res = await pushManifest(reg, "hosted/ro", "v1", manifest, reader);
    expect(res.status).toBe(403);
    const anon = await pushManifest(reg, "hosted/ro", "v1", manifest, undefined as unknown as string);
    expect(anon.status).toBe(401);
    const del = await reg.call("DELETE", "hosted/app/manifests/v1", { token: reader });
    expect(del.status).toBe(403);
  });
});

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runRepoCleanup, type CleanupDeps, type CleanupKind, type Repo } from "@weaver/core";
import { cleanupPolicy, dockerBlob, dockerBlobLink, dockerManifest, dockerTag } from "@weaver/db";
import { createDockerCleanup, dockerCleanup, listOrphanManifests, listTags } from "./cleanup.js";
import { DOCKER_GC_GRACE_MS, runDockerGc } from "./gc.js";
import { descriptorOf, digestOf, pushBlob, pushManifest, startDockerTestRegistry, type DockerTestRegistry } from "./testing.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";
const EMPTY = "application/vnd.oci.empty.v1+json";
const SIG = "application/vnd.dev.cosign.artifact.sig.v1+json";

describe("docker cleanup", () => {
  let reg: DockerTestRegistry;
  let key: string;
  let repo: Repo;
  let deps: CleanupDeps;
  let gcRuns = 0;
  /** Runs inside a manifest PUT's transaction at each step, when set by a test. */
  let hook: ((step: "begin" | "inserted" | "resolved") => Promise<void>) | null = null;
  const cleanup = createDockerCleanup({
    collectGarbage: (gcDeps, now) => {
      gcRuns++;
      return runDockerGc({ ...gcDeps, now });
    },
  });
  const registry = { docker: cleanup };

  beforeAll(async () => {
    reg = await startDockerTestRegistry({ dockerOptions: { onManifestPutStep: (step) => (hook ? hook(step) : Promise.resolve()) } });
    repo = await reg.createRepo({ name: "dh", format: "docker", kind: "hosted" });
    await reg.createRepo({ name: "dm", format: "docker", kind: "mirror", upstreams: [{ url: "https://registry.example.test", authType: "none" }] });
    key = reg.tokenFor([{ repo: "dh", access: "write" }]);
    deps = { db: reg.deps.db, stores: reg.deps.stores, assets: reg.deps.assets, repos: reg.deps.repos };
  }, 180_000);
  afterAll(async () => {
    await reg?.stop();
  });
  beforeEach(async () => {
    hook = null;
    gcRuns = 0;
    await reg.deps.db.execute(
      sql`TRUNCATE docker_blob, docker_blob_link, docker_manifest, docker_manifest_ref, docker_tag, docker_upload, cleanup_policy CASCADE`,
    );
  });

  const ago = (ms: number) => new Date(Date.now() - ms);
  const run = (dryRun = false, now = new Date()) => runRepoCleanup(deps, registry, "dh", now, { dryRun });

  async function policy(kind: CleanupKind, value: number, extra: { pattern?: string; groupPrefix?: string } = {}) {
    await reg.deps.db.insert(cleanupPolicy).values({
      repositoryId: repo.id,
      kind,
      value,
      pattern: extra.pattern ?? null,
      groupPrefix: extra.groupPrefix ?? null,
    });
  }

  /** Pushes a config and a layer (`shared` reuses a fixed layer) plus a manifest under `reference`; resolves to its digest and blobs. */
  async function image(name: string, seed: number, reference?: string, opts: { sharedLayer?: Buffer } = {}) {
    const config = Buffer.from(JSON.stringify({ os: "linux", architecture: "amd64", seed }));
    const layer = opts.sharedLayer ?? Buffer.from(`layer-${seed}-${"x".repeat(200)}`);
    expect((await pushBlob(reg, `dh/${name}`, config, key)).status).toBe(201);
    expect((await pushBlob(reg, `dh/${name}`, layer, key)).status).toBe(201);
    const manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST, config: descriptorOf(config, OCI_CONFIG), layers: [descriptorOf(layer, OCI_LAYER)] };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const digest = digestOf(bytes);
    expect((await pushManifest(reg, `dh/${name}`, reference ?? digest, manifest, key)).status).toBe(201);
    return { digest, config, layer, descriptor: descriptorOf(bytes, OCI_MANIFEST) };
  }

  async function tag(name: string, t: string, digest: string) {
    const res = await reg.call("GET", `dh/${name}/manifests/${digest}`, { token: key });
    const body = Buffer.from(await res.arrayBuffer());
    expect((await pushManifest(reg, `dh/${name}`, t, body, key, res.headers.get("content-type")!)).status).toBe(201);
  }

  async function tagsOf(name: string): Promise<string[]> {
    const res = await reg.call("GET", `dh/${name}/tags/list`, { token: key });
    if (res.status === 404) return [];
    return ((await res.json()) as { tags: string[] }).tags;
  }

  const manifestStatus = async (name: string, ref: string) => (await reg.call("GET", `dh/${name}/manifests/${ref}`, { token: key })).status;
  const blobStatus = async (name: string, digest: string) => (await reg.call("GET", `dh/${name}/blobs/${digest}`, { token: key })).status;

  async function setTag(name: string, t: string, values: { updatedAt?: Date; lastPulledAt?: Date | null }) {
    await reg.deps.db
      .update(dockerTag)
      .set(values)
      .where(and(eq(dockerTag.repositoryId, repo.id), eq(dockerTag.image, name), eq(dockerTag.tag, t)));
  }

  async function setManifest(digest: string, values: { createdAt?: Date; lastPulledAt?: Date | null }) {
    await reg.deps.db.update(dockerManifest).set(values).where(eq(dockerManifest.digest, digest));
  }

  /** Moves every manifest `ms` into the past. */
  async function ageManifests(ms: number) {
    await reg.deps.db.update(dockerManifest).set({ createdAt: ago(ms) });
  }

  /** Moves every link and blob past the garbage collection grace period. */
  async function ageBlobs() {
    const old = ago(DOCKER_GC_GRACE_MS + HOUR);
    await reg.deps.db.update(dockerBlobLink).set({ createdAt: old });
    await reg.deps.db.update(dockerBlob).set({ lastLinkedAt: old });
  }

  it("keep_last_tags 2 with pattern \"v*\" keeps the two newest v-tags and ignores others", async () => {
    const pushed = [];
    for (const [i, t] of ["v1", "v2", "v3", "latest"].entries()) pushed.push({ t, ...(await image("app", i + 1, t)) });
    for (const [i, p] of pushed.entries()) await setTag("app", p.t, { updatedAt: ago((10 - i) * DAY) });
    await policy("keep_last_tags", 2, { pattern: "v*" });

    const deleted = await run();

    expect(deleted.map((c) => c.key)).toEqual(["docker:app:v1", `docker:app@${pushed[0]!.digest}`]);
    expect(deleted[0]!.label).toBe("app:v1");
    expect((await tagsOf("app")).sort()).toEqual(["latest", "v2", "v3"]);
  });

  it("keep_last_tags keeps the newest N of each image, scoped by the image name prefix", async () => {
    for (const name of ["team/a", "other"]) {
      for (const [i, t] of ["v1", "v2"].entries()) {
        await image(name, i + (name === "other" ? 10 : 20), t);
        await setTag(name, t, { updatedAt: ago((5 - i) * DAY) });
      }
    }
    await policy("keep_last_tags", 1, { pattern: "v*", groupPrefix: "team/" });

    await run();

    expect(await tagsOf("team/a")).toEqual(["v2"]);
    expect(await tagsOf("other")).toEqual(["v1", "v2"]);
  });

  it("delete_not_downloaded 30 deletes tags not pulled for 30 days", async () => {
    const old = await image("app", 1, "old");
    await image("app", 2, "pulled", {});
    await image("app", 3, "fresh");
    await setTag("app", "old", { updatedAt: ago(40 * DAY), lastPulledAt: ago(35 * DAY) });
    await setTag("app", "pulled", { updatedAt: ago(40 * DAY), lastPulledAt: ago(2 * DAY) });
    await setTag("app", "fresh", { updatedAt: ago(5 * DAY) });
    await reg.deps.db.update(dockerManifest).set({ lastPulledAt: null });
    await policy("delete_not_downloaded", 30);

    const deleted = await run();

    expect(deleted.map((c) => c.key)).toEqual(["docker:app:old", `docker:app@${old.digest}`]);
    expect(deleted[0]!.reason).toBe("not downloaded for 30 days");
    expect((await tagsOf("app")).sort()).toEqual(["fresh", "pulled"]);
  });

  it("digest pulls keep the tag", async () => {
    const img = await image("app", 1, "v1");
    expect(await manifestStatus("app", img.digest)).toBe(200);
    await setTag("app", "v1", { updatedAt: ago(40 * DAY), lastPulledAt: null });
    await setManifest(img.digest, { lastPulledAt: ago(3 * DAY) });
    await policy("delete_not_downloaded", 30);

    expect(await run()).toEqual([]);
    expect(await tagsOf("app")).toEqual(["v1"]);
  });

  it("deleting a tag also removes its now orphaned manifest", async () => {
    const img = await image("app", 1, "old");
    await setTag("app", "old", { updatedAt: ago(40 * DAY) });
    await policy("delete_not_downloaded", 30);

    await run();

    expect(await manifestStatus("app", img.digest)).toBe(404);
  });

  it("a manifest still tagged elsewhere survives", async () => {
    const img = await image("app", 1, "old");
    await tag("app", "keep", img.digest);
    await setTag("app", "old", { updatedAt: ago(40 * DAY) });
    await setManifest(img.digest, { lastPulledAt: null });
    await policy("delete_not_downloaded", 30);

    const deleted = await run();

    expect(deleted.map((c) => c.key)).toEqual(["docker:app:old"]);
    expect(await manifestStatus("app", img.digest)).toBe(200);
    expect(await tagsOf("app")).toEqual(["keep"]);
  });

  it("delete_untagged_manifests 7 keeps index children and live referrers", async () => {
    const amd = await image("app", 1);
    const arm = await image("app", 2);
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        { ...amd.descriptor, platform: { os: "linux", architecture: "amd64" } },
        { ...arm.descriptor, platform: { os: "linux", architecture: "arm64" } },
      ],
    };
    const indexBytes = Buffer.from(JSON.stringify(index));
    const indexDigest = digestOf(indexBytes);
    expect((await pushManifest(reg, "dh/app", "multi", index, key)).status).toBe(201);
    const empty = Buffer.from("{}");
    const sigLayer = Buffer.from('{"critical":{}}');
    for (const blob of [empty, sigLayer]) expect((await pushBlob(reg, "dh/app", blob, key)).status).toBe(201);
    const sig = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      artifactType: SIG,
      config: descriptorOf(empty, EMPTY),
      layers: [descriptorOf(sigLayer, "application/vnd.dev.cosign.simplesigning.v1+json")],
      subject: descriptorOf(indexBytes, OCI_INDEX),
    };
    const sigDigest = digestOf(Buffer.from(JSON.stringify(sig)));
    expect((await pushManifest(reg, "dh/app", sigDigest, sig, key)).status).toBe(201);
    const single = await image("app", 3);
    await ageManifests(10 * DAY);
    await policy("delete_untagged_manifests", 7);

    expect((await listOrphanManifests(deps, repo)).map((m) => m.digest)).toEqual([single.digest]);
    const first = await run();

    expect(first.map((c) => c.key)).toEqual([`docker:app@${single.digest}`]);
    expect(first[0]!.reason).toBe("untagged for 7 days");
    for (const d of [amd.digest, arm.digest, indexDigest, sigDigest]) expect(await manifestStatus("app", d)).toBe(200);

    expect((await reg.call("DELETE", "dh/app/manifests/multi", { token: key })).status).toBe(202);
    const second = await run();

    expect(second.map((c) => c.key).sort()).toEqual([amd.digest, arm.digest, indexDigest, sigDigest].map((d) => `docker:app@${d}`).sort());
    for (const d of [amd.digest, arm.digest, indexDigest, sigDigest]) expect(await manifestStatus("app", d)).toBe(404);
  });

  it("grace period: an untagged manifest 2 days old survives value 7", async () => {
    const img = await image("app", 1);
    await ageManifests(2 * DAY);
    await policy("delete_untagged_manifests", 7);

    expect(await run()).toEqual([]);
    expect(await manifestStatus("app", img.digest)).toBe(200);
  });

  it("garbage collection runs once after deletions and frees unreferenced blobs", async () => {
    const shared = Buffer.from("shared-layer".repeat(20));
    const a = await image("app", 1, "a", { sharedLayer: shared });
    const b = await image("app", 2, "b", { sharedLayer: shared });
    const c = await image("app", 3, "c");
    await setTag("app", "a", { updatedAt: ago(40 * DAY) });
    await setTag("app", "c", { updatedAt: ago(40 * DAY) });
    await ageBlobs();
    await policy("delete_not_downloaded", 30);

    const deleted = await run();

    expect(deleted).toHaveLength(4);
    expect(gcRuns).toBe(1);
    expect(await blobStatus("app", digestOf(c.layer))).toBe(404);
    expect(await blobStatus("app", digestOf(a.config))).toBe(404);
    expect(await blobStatus("app", digestOf(shared))).toBe(200);
    expect(await manifestStatus("app", b.digest)).toBe(200);
  });

  it("does not collect garbage when nothing was deleted", async () => {
    await image("app", 1, "v1");
    await policy("delete_not_downloaded", 30);

    expect(await run()).toEqual([]);
    expect(gcRuns).toBe(0);
  });

  it("dryRun deletes nothing and does not collect", async () => {
    const img = await image("app", 1, "old");
    await setTag("app", "old", { updatedAt: ago(40 * DAY) });
    await ageBlobs();
    await policy("delete_not_downloaded", 30);

    const planned = await run(true);

    expect(planned.map((c) => c.key)).toEqual(["docker:app:old", `docker:app@${img.digest}`]);
    expect(gcRuns).toBe(0);
    expect(await tagsOf("app")).toEqual(["old"]);
    expect(await manifestStatus("app", img.digest)).toBe(200);
    expect(await blobStatus("app", digestOf(img.layer))).toBe(200);
  });

  it("lists tags with the latest pull by tag or by digest", async () => {
    const img = await image("app", 1, "v1");
    await setTag("app", "v1", { lastPulledAt: ago(5 * DAY) });
    await setManifest(img.digest, { lastPulledAt: ago(1 * DAY) });

    const tags = await listTags(deps, repo);

    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ image: "app", tag: "v1", digest: img.digest });
    expect(Math.abs(tags[0]!.lastPulledAt!.getTime() - ago(DAY).getTime())).toBeLessThan(60_000);
  });

  it("never cleans a mirror repository", async () => {
    const mirror = (await reg.deps.repos.get("dm"))!;
    await reg.deps.db.insert(cleanupPolicy).values({ repositoryId: mirror.id, kind: "delete_untagged_manifests", value: 1 });
    expect(await runRepoCleanup(deps, { docker: dockerCleanup }, "dm", new Date(), { dryRun: false })).toEqual([]);
    expect(await dockerCleanup.run(deps, mirror, [], new Date(), { dryRun: false })).toEqual([]);
  });

  it("an index pushed while its child is being cleaned keeps the child", async () => {
    const child = await image("app", 1);
    await ageManifests(10 * DAY);
    await policy("delete_untagged_manifests", 7);
    const index = { schemaVersion: 2, mediaType: OCI_INDEX, manifests: [{ ...child.descriptor, platform: { os: "linux", architecture: "amd64" } }] };
    let reached!: () => void;
    const atInsert = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    hook = async (step) => {
      if (step !== "inserted") return;
      reached();
      await gate;
    };

    const put = pushManifest(reg, "dh/app", "multi", index, key);
    await atInsert;
    const cleaned = run();
    // The cleanup either skips the locked child or waits; give it time to reach its lock before the push commits.
    await new Promise((r) => setTimeout(r, 300));
    release();

    expect((await put).status).toBe(201);
    await cleaned;
    expect(await manifestStatus("app", child.digest)).toBe(200);
    expect(await manifestStatus("app", "multi")).toBe(200);
  });
});

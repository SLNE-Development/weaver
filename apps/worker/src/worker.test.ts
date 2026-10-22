import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValkeyContainer, type StartedValkeyContainer } from "@testcontainers/valkey";
import { asc, eq, sql } from "drizzle-orm";
import {
  asset,
  cleanupPolicy,
  dockerBlob,
  dockerUpload,
  npmLoginSession,
  protoArtifact as artifact,
  protoBuild as build,
  protoVersion as version,
  repository,
  usageDaily,
  usageEvent,
} from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createStoreSetFromEnv, deriveSecretKey, putBuffer, type StoreSet } from "@weaver/core";
import {
  createQueue,
  enqueueCleanup,
  getJobState,
  redisConnection,
  type CleanupJobStatus,
  type CleanupQueue,
} from "@weaver/jobs";
import { loadEnv } from "./env.js";
import { startWorker, type RunningWorker } from "./worker.js";

describe("worker", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let valkey: StartedValkeyContainer;
  let blobDir: string;
  let stores: StoreSet;
  let queue: CleanupQueue;
  const running: RunningWorker[] = [];

  async function start(): Promise<RunningWorker> {
    const w = await startWorker({
      db: testDb.db,
      stores,
      secretKey: deriveSecretKey("worker-test-secret"),
      connection: redisConnection(valkey.getConnectionUrl()),
    });
    running.push(w);
    return w;
  }

  async function waitForFinish(jobId: string): Promise<CleanupJobStatus> {
    // Generous budget: under heavy parallel load (several containers starting) a job can take long to be picked up.
    let last: CleanupJobStatus | undefined;
    for (let i = 0; i < 1000; i++) {
      last = await getJobState(queue, jobId);
      if (last.state === "completed" || last.state === "failed") return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    const counts = await queue.getJobCounts();
    throw new Error(`job ${jobId} did not finish: last state ${JSON.stringify(last)}, queue counts ${JSON.stringify(counts)}`);
  }

  beforeAll(async () => {
    [testDb, valkey] = await Promise.all([
      startTestDb(),
      new ValkeyContainer("valkey/valkey:9.1.2-alpine").start(),
    ]);
    blobDir = await mkdtemp(join(tmpdir(), "weaver-worker-"));
    stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    queue = createQueue(redisConnection(valkey.getConnectionUrl()));
  });

  afterAll(async () => {
    await queue?.close();
    await testDb?.stop();
    await valkey?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await testDb.db.execute(sql`TRUNCATE repository, audit_event, usage_event, docker_blob CASCADE`);
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((w) => w.close()));
  });

  it("runs a repository cleanup job and leaves the newest builds", async () => {
    const [repo] = await testDb.db.insert(repository).values({ name: "snapshots", format: "proto", kind: "hosted" }).returning();
    await testDb.db.insert(cleanupPolicy).values({ repositoryId: repo!.id, kind: "keep_last_snapshot_builds", value: 2 });
    const [art] = await testDb.db
      .insert(artifact)
      .values({ repositoryId: repo!.id, group: "acme", name: "money" })
      .returning();
    const [ver] = await testDb.db
      .insert(version)
      .values({ artifactId: art!.id, version: "1.0.0-SNAPSHOT", isSnapshot: true })
      .returning();
    for (let n = 1; n <= 4; n++) {
      const storageKey = `snapshots/acme/money/1.0.0-SNAPSHOT/${randomUUID()}.tar.gz`;
      await putBuffer(stores.primary, storageKey, Buffer.from(`build ${n}`));
      await testDb.db
        .insert(build)
        .values({ versionId: ver!.id, buildNumber: n, store: stores.primary.id, storageKey, sha256: "0".repeat(64), sizeBytes: 7 });
    }

    await start();
    const jobId = await enqueueCleanup(queue, "snapshots");
    expect(await waitForFinish(jobId)).toEqual({ state: "completed", result: { deleted: 2 }, failedReason: null });

    const remaining = await testDb.db.select({ n: build.buildNumber }).from(build).orderBy(asc(build.buildNumber));
    expect(remaining.map((r) => r.n)).toEqual([3, 4]);
  });

  it("completes a cleanup:repo job for a proto repo with keep_last_snapshot_builds 1 and 3 builds", async () => {
    const [repo] = await testDb.db.insert(repository).values({ name: "protos", format: "proto", kind: "hosted" }).returning();
    await testDb.db.insert(cleanupPolicy).values({ repositoryId: repo!.id, kind: "keep_last_snapshot_builds", value: 1 });
    const [art] = await testDb.db.insert(artifact).values({ repositoryId: repo!.id, group: "acme", name: "order" }).returning();
    const [ver] = await testDb.db
      .insert(version)
      .values({ artifactId: art!.id, version: "2.0.0-SNAPSHOT", isSnapshot: true })
      .returning();
    for (let n = 1; n <= 3; n++) {
      const storageKey = `protos/acme/order/2.0.0-SNAPSHOT/${randomUUID()}.tar.gz`;
      await putBuffer(stores.primary, storageKey, Buffer.from(`build ${n}`));
      await testDb.db
        .insert(build)
        .values({ versionId: ver!.id, buildNumber: n, store: stores.primary.id, storageKey, sha256: "0".repeat(64), sizeBytes: 7 });
    }

    await start();
    const jobId = await enqueueCleanup(queue, "protos");
    expect(await waitForFinish(jobId)).toEqual({ state: "completed", result: { deleted: 2 }, failedReason: null });
    const remaining = await testDb.db.select({ n: build.buildNumber }).from(build);
    expect(remaining.map((r) => r.n)).toEqual([3]);
  });

  it("registers the daily cleanup, hourly eviction, npm login sweep, stats rollup and docker gc schedulers once when started twice", async () => {
    await start();
    await start();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(5);
    expect(schedulers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "cleanup-daily", pattern: "0 3 * * *" }),
        expect.objectContaining({ key: "evict-hourly", pattern: "17 * * * *" }),
        expect.objectContaining({ key: "npm-login-sweep", pattern: "*/5 * * * *" }),
        expect.objectContaining({ key: "stats-hourly", pattern: "41 * * * *" }),
        expect.objectContaining({ key: "docker-gc-daily", pattern: "30 3 * * *" }),
      ]),
    );
  });

  it("startWorker upserts the stats-hourly scheduler with pattern 41 * * * *", async () => {
    await start();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toEqual(expect.arrayContaining([expect.objectContaining({ key: "stats-hourly", pattern: "41 * * * *" })]));
  });

  it("a stats:rollup job completes and writes usage_daily", async () => {
    const [repo] = await testDb.db.insert(repository).values({ name: "releases", format: "maven", kind: "hosted" }).returning();
    await testDb.db.insert(usageEvent).values({ repositoryId: repo!.id, path: "a.jar", action: "download", bytes: 4 });

    await start();
    const job = await queue.add("stats:rollup", { kind: "stats:rollup" });
    const status = await waitForFinish(job.id!);

    expect(status.state).toBe("completed");
    const rows = await testDb.db.select().from(usageDaily).where(eq(usageDaily.repositoryId, repo!.id));
    expect(rows).toEqual([expect.objectContaining({ action: "download", count: 1, bytes: 4 })]);
  });

  it("runs an evict:all job and removes cache assets of mirrors with caching disabled", async () => {
    const [repo] = await testDb.db
      .insert(repository)
      .values({ name: "central", format: "maven", kind: "mirror", config: { cache: { enabled: false } } })
      .returning();
    const storageKey = `${repo!.id}/cache/${randomUUID()}`;
    await putBuffer(stores.primary, storageKey, Buffer.from("jar"));
    await testDb.db.insert(asset).values({
      repositoryId: repo!.id,
      path: "a.jar",
      store: stores.primary.id,
      storageKey,
      size: 3,
      md5: "0",
      sha1: "0",
      sha256: "0",
      sha512: "0",
      origin: "cache",
    });

    await start();
    const job = await queue.add("evict:all", { kind: "evict:all" });
    const status = await waitForFinish(job.id!);

    expect(status).toEqual({ state: "completed", result: { repositories: 1, assetsDeleted: 1, bytesFreed: 3 }, failedReason: null });
    expect(await testDb.db.select().from(asset).where(eq(asset.repositoryId, repo!.id))).toHaveLength(0);
  });

  it("runs an npm:login-sweep job and deletes expired login sessions", async () => {
    const [repo] = await testDb.db.insert(repository).values({ name: "npm", format: "npm", kind: "hosted" }).returning();
    const session = (id: string, offsetMs: number) => ({
      id,
      pollHash: id.padEnd(64, "0"),
      repositoryId: repo!.id,
      expiresAt: new Date(Date.now() + offsetMs),
    });
    await testDb.db.insert(npmLoginSession).values([session("expired", -60_000), session("live", 600_000)]);

    await start();
    const job = await queue.add("npm:login-sweep", { kind: "npm:login-sweep" });
    const status = await waitForFinish(job.id!);

    expect(status).toEqual({ state: "completed", result: { sessions: 1, keys: 0 }, failedReason: null });
    expect((await testDb.db.select({ id: npmLoginSession.id }).from(npmLoginSession)).map((r) => r.id)).toEqual(["live"]);
  });

  it('a docker:gc job runs runDockerGc and docker-gc-daily is scheduled at "30 3 * * *"', async () => {
    const [repo] = await testDb.db.insert(repository).values({ name: "images", format: "docker", kind: "hosted" }).returning();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const storageKey = `docker/blobs/sha256/ab/${randomUUID()}`;
    await putBuffer(stores.primary, storageKey, Buffer.from("layer"));
    await testDb.db
      .insert(dockerBlob)
      .values({ store: stores.primary.id, digest: `sha256:${"ab".repeat(32)}`, size: 5, storageKey, lastLinkedAt: old });
    await testDb.db.insert(dockerUpload).values({ repositoryId: repo!.id, image: "app", updatedAt: old });

    await start();
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toEqual(expect.arrayContaining([expect.objectContaining({ key: "docker-gc-daily", pattern: "30 3 * * *" })]));
    const job = await queue.add("docker:gc", { kind: "docker:gc" });
    const status = await waitForFinish(job.id!);

    expect(status).toEqual({
      state: "completed",
      result: { linksDeleted: 0, blobsDeleted: 1, bytesFreed: 5, uploadsDeleted: 1 },
      failedReason: null,
    });
    expect(await testDb.db.select().from(dockerBlob)).toHaveLength(0);
    expect(await stores.primary.head(storageKey)).toBeNull();
  });

  it("fails a job for an unknown repository at once instead of retrying it", { timeout: 60_000 }, async () => {
    await start();
    const jobId = await enqueueCleanup(queue, "nope");

    const status = await waitForFinish(jobId);
    expect(status.state).toBe("failed");
    expect(status.failedReason).toMatch(/nope was not found/);
    const job = await queue.getJob(jobId);
    expect(job?.opts.attempts).toBe(3);
    expect(job?.attemptsMade).toBe(1);
  });
});

describe("loadEnv", () => {
  const base = {
    DATABASE_URL: "postgres://weaver:weaver@localhost:5432/weaver",
    VALKEY_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "x".repeat(32),
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_PATH: "/data",
  };

  it("accepts a complete environment", () => {
    expect(loadEnv(base)).toMatchObject({ VALKEY_URL: "redis://localhost:6379", STORAGE_DRIVER: "local" });
  });

  it("rejects a missing VALKEY_URL and treats empty strings as unset", () => {
    expect(() => loadEnv({ ...base, VALKEY_URL: "" })).toThrow();
  });

  it("rejects an unknown storage driver", () => {
    expect(() => loadEnv({ ...base, STORAGE_DRIVER: "ftp" })).toThrow();
  });
});

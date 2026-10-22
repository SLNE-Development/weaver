import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
/** The parts of a pg pool client that `runAllCleanups` uses. */
type PoolClient = { query: (...args: never[]) => Promise<unknown>; release: (err?: Error | boolean) => void };
import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditEvent,
  cleanupPolicy,
  protoArtifact as artifact,
  protoBuild as build,
  protoDeletedRelease as deletedRelease,
  protoDependency as dependency,
  protoVersion as version,
  repository,
} from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createAssetService } from "../content/assets.js";
import type { Coordinate } from "../coordinates.js";
import { deriveSecretKey } from "../crypto.js";
import { createRepoService } from "../repos/index.js";
import { createStoreSetFromEnv, getBuffer, putBuffer, type StoreSet } from "../storage/index.js";
import { protoCleanup } from "./proto.js";
import { runAllCleanups, runRepoCleanup } from "./runner.js";
import type { CleanupCandidate, CleanupDeps } from "./types.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-21T03:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const coord = (group: string, name: string, v: string): Coordinate => ({ group, name, version: v });

interface SeedOptions {
  builds?: number;
  createdAt?: Date;
  updatedAt?: Date;
  lastDownloadedAt?: Date | null;
  dependsOn?: Coordinate[];
}

describe("cleanup", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let stores: StoreSet;
  let deps: CleanupDeps;

  const repoIds = new Map<string, string>();

  async function insertRepo(name: string): Promise<void> {
    const [row] = await testDb.db.insert(repository).values({ name, format: "proto", kind: "hosted" }).returning({ id: repository.id });
    repoIds.set(name, row!.id);
  }

  async function addPolicy(repo: string, values: Omit<typeof cleanupPolicy.$inferInsert, "repositoryId">) {
    await testDb.db.insert(cleanupPolicy).values({ repositoryId: repoIds.get(repo)!, ...values });
  }

  /** Inserts a version with `builds` builds (numbered from 1), a blob per build and the given dependencies on every build. */
  async function seed(repo: string, c: Coordinate, opts: SeedOptions = {}): Promise<string[]> {
    const created = opts.createdAt ?? daysAgo(1);
    const [art] = await testDb.db
      .insert(artifact)
      .values({ repositoryId: repoIds.get(repo)!, group: c.group, name: c.name })
      .onConflictDoUpdate({ target: [artifact.repositoryId, artifact.group, artifact.name], set: { name: c.name } })
      .returning({ id: artifact.id });
    const [ver] = await testDb.db
      .insert(version)
      .values({
        artifactId: art!.id,
        version: c.version,
        isSnapshot: c.version.endsWith("-SNAPSHOT"),
        createdAt: created,
        updatedAt: opts.updatedAt ?? created,
      })
      .returning({ id: version.id });
    const keys: string[] = [];
    for (let n = 1; n <= (opts.builds ?? 1); n++) {
      const storageKey = `${repo}/${c.group}/${c.name}/${c.version}/${randomUUID()}.tar.gz`;
      await putBuffer(stores.primary, storageKey, Buffer.from(`build ${n}`));
      keys.push(storageKey);
      const [b] = await testDb.db
        .insert(build)
        .values({
          versionId: ver!.id,
          buildNumber: n,
          store: stores.primary.id,
          storageKey,
          sha256: "0".repeat(64),
          sizeBytes: 7,
          createdAt: created,
          lastDownloadedAt: opts.lastDownloadedAt ?? null,
        })
        .returning({ id: build.id });
      for (const d of opts.dependsOn ?? []) {
        await testDb.db
          .insert(dependency)
          .values({ buildId: b!.id, depGroup: d.group, depName: d.name, depVersion: d.version });
      }
    }
    return keys;
  }

  async function buildNumbers(repo: string, c: Coordinate): Promise<number[]> {
    const rows = await testDb.db
      .select({ n: build.buildNumber })
      .from(build)
      .innerJoin(version, eq(version.id, build.versionId))
      .innerJoin(artifact, eq(artifact.id, version.artifactId))
      .where(
        and(
          eq(artifact.repositoryId, repoIds.get(repo)!),
          eq(artifact.group, c.group),
          eq(artifact.name, c.name),
          eq(version.version, c.version),
        ),
      )
      .orderBy(asc(build.buildNumber));
    return rows.map((r) => r.n);
  }

  /** Resolves once some session is blocked waiting for an advisory lock. */
  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await testDb.db.$client.query(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
      );
      if ((rows[0] as { n: number }).n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no session started waiting for an advisory lock");
  }

  /** `<name>:<version>#<build|all>` of each candidate, from its `proto:<group>:<name>:<version>#<build|all>` key. */
  const summary = (candidates: CleanupCandidate[]) => candidates.map((x) => x.key.split(":").slice(2).join(":"));

  /** Runs the proto cleanup the way the runner does: with the repository's enabled policies in createdAt order. */
  async function runProto(repoName: string, dryRun: boolean): Promise<CleanupCandidate[]> {
    const repo = await deps.repos.get(repoName);
    const policies = await testDb.db
      .select()
      .from(cleanupPolicy)
      .where(and(eq(cleanupPolicy.repositoryId, repo!.id), eq(cleanupPolicy.enabled, true)))
      .orderBy(asc(cleanupPolicy.createdAt), asc(cleanupPolicy.id));
    return protoCleanup.run(deps, repo!, policies, NOW, { dryRun });
  }
  const plan = (repoName: string) => runProto(repoName, true);
  const apply = (repoName: string) => runProto(repoName, false);

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-cleanup-"));
    stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    deps = {
      db: testDb.db,
      stores,
      assets: createAssetService({ db: testDb.db, stores }),
      repos: createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("proto-cleanup-test-secret") }),
    };
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, audit_event CASCADE`);
    repoIds.clear();
    await insertRepo("snapshots");
    await insertRepo("other");
  });

  describe("keep_last_snapshot_builds", () => {
    it("plans every build but the newest N", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 5 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 2 });

      const planned = await plan("snapshots");
      expect(summary(planned)).toEqual(["money:1.0.0-SNAPSHOT#1", "money:1.0.0-SNAPSHOT#2", "money:1.0.0-SNAPSHOT#3"]);
      expect(planned[0]).toMatchObject({
        repository: "snapshots",
        key: "proto:acme:money:1.0.0-SNAPSHOT#1",
        label: "acme:money:1.0.0-SNAPSHOT build 1",
      });
      expect(planned[0]!.reason).toMatch(/keep last 2/);
    });

    it("treats a value below 1 as 1, so the newest build always stays", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 0 });

      expect(summary(await plan("snapshots"))).toEqual([
        "money:1.0.0-SNAPSHOT#1",
        "money:1.0.0-SNAPSHOT#2",
      ]);
    });

    it("never touches releases", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0"));
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
      expect(await plan("snapshots")).toEqual([]);
    });
  });

  describe("delete_stale_snapshots", () => {
    it("plans snapshots not published for X days as whole versions and skips releases", async () => {
      await seed("snapshots", coord("acme", "old", "1.0.0-SNAPSHOT"), { builds: 2, updatedAt: daysAgo(31) });
      await seed("snapshots", coord("acme", "fresh", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(29) });
      await seed("snapshots", coord("acme", "ancient", "1.0.0"), { updatedAt: daysAgo(400) });
      await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

      const planned = await plan("snapshots");
      expect(summary(planned)).toEqual(["old:1.0.0-SNAPSHOT#all"]);
      expect(planned[0]).toMatchObject({ key: "proto:acme:old:1.0.0-SNAPSHOT#all", label: "acme:old:1.0.0-SNAPSHOT" });
    });
  });

  describe("delete_not_downloaded", () => {
    beforeEach(async () => {
      await seed("snapshots", coord("acme", "unused", "1.0.0-SNAPSHOT"), { lastDownloadedAt: daysAgo(91) });
      await seed("snapshots", coord("acme", "used", "1.0.0-SNAPSHOT"), {
        createdAt: daysAgo(200),
        lastDownloadedAt: daysAgo(10),
      });
      await seed("snapshots", coord("acme", "never", "1.0.0-SNAPSHOT"), { createdAt: daysAgo(100) });
      await seed("snapshots", coord("acme", "new", "1.0.0-SNAPSHOT"), { createdAt: daysAgo(5) });
      await seed("snapshots", coord("acme", "release", "1.0.0"), { createdAt: daysAgo(300) });
    });

    it("skips releases unless the rule includes them, and falls back to createdAt when never downloaded", async () => {
      await addPolicy("snapshots", { kind: "delete_not_downloaded", value: 90 });
      expect(summary(await plan("snapshots"))).toEqual([
        "never:1.0.0-SNAPSHOT#all",
        "unused:1.0.0-SNAPSHOT#all",
      ]);
    });

    it("includes releases when the rule says so", async () => {
      await addPolicy("snapshots", { kind: "delete_not_downloaded", value: 90, includeReleases: true });
      expect(summary(await plan("snapshots"))).toEqual([
        "never:1.0.0-SNAPSHOT#all",
        "release:1.0.0#all",
        "unused:1.0.0-SNAPSHOT#all",
      ]);
    });
  });

  it("limits candidates to the rule's group prefix at a dot boundary", async () => {
    await seed("snapshots", coord("dev.surf", "a", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60) });
    await seed("snapshots", coord("dev.surf.economy", "b", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60) });
    await seed("snapshots", coord("dev.surfboard", "c", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60) });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30, groupPrefix: "dev.surf" });

    expect(summary(await plan("snapshots"))).toEqual(["a:1.0.0-SNAPSHOT#all", "b:1.0.0-SNAPSHOT#all"]);
  });

  it("plans nothing for disabled policies", async () => {
    await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3, updatedAt: daysAgo(60) });
    await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1, enabled: false });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30, enabled: false });

    expect(await plan("snapshots")).toEqual([]);
  });

  it("collapses build candidates into a whole-version candidate of the same version", async () => {
    await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3, updatedAt: daysAgo(60) });
    await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

    expect(summary(await plan("snapshots"))).toEqual(["money:1.0.0-SNAPSHOT#all"]);
  });

  it("excludes a candidate that a retained version in any repository depends on", async () => {
    const money = coord("acme", "money", "1.0.0-SNAPSHOT");
    const unused = coord("acme", "unused", "1.0.0-SNAPSHOT");
    await seed("snapshots", money, { updatedAt: daysAgo(60) });
    await seed("snapshots", unused, { updatedAt: daysAgo(60) });
    await seed("other", coord("acme", "order", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60), dependsOn: [money] });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

    expect(summary(await plan("snapshots"))).toEqual(["unused:1.0.0-SNAPSHOT#all"]);
  });

  it("keeps a dependency chain whose head is retained, and deletes a chain that is removed completely", async () => {
    const base = coord("acme", "base", "1.0.0-SNAPSHOT");
    const mid = coord("acme", "mid", "1.0.0-SNAPSHOT");
    // mid -> base, both stale; top -> mid is fresh, so mid stays and therefore base stays.
    await seed("snapshots", base, { updatedAt: daysAgo(60) });
    await seed("snapshots", mid, { updatedAt: daysAgo(60), dependsOn: [base] });
    await seed("snapshots", coord("acme", "top", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(1), dependsOn: [mid] });
    // leaf -> root, both stale and nothing retained depends on them.
    const root = coord("acme", "root", "1.0.0-SNAPSHOT");
    await seed("snapshots", root, { updatedAt: daysAgo(60) });
    await seed("snapshots", coord("acme", "leaf", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60), dependsOn: [root] });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

    expect(summary(await plan("snapshots"))).toEqual([
      "leaf:1.0.0-SNAPSHOT#all",
      "root:1.0.0-SNAPSHOT#all",
    ]);
    const applied = await apply("snapshots");
    expect(summary(applied)).toEqual(["leaf:1.0.0-SNAPSHOT#all", "root:1.0.0-SNAPSHOT#all"]);
    expect(await buildNumbers("snapshots", root)).toEqual([]);
    expect(await buildNumbers("snapshots", base)).toEqual([1]);
  });

  it("throws not_found for an unknown repository", async () => {
    await expect(runRepoCleanup(deps, { proto: protoCleanup }, "nope", NOW, { dryRun: true })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  describe("applying", () => {
    it("deletes rows and blobs and audits each deletion as the system", async () => {
      const money = coord("acme", "money", "1.0.0-SNAPSHOT");
      const stale = coord("acme", "stale", "1.0.0-SNAPSHOT");
      const moneyKeys = await seed("snapshots", money, { builds: 4 });
      const staleKeys = await seed("snapshots", stale, { builds: 2, updatedAt: daysAgo(60) });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 2 });
      await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

      const applied = await apply("snapshots");
      expect(summary(applied)).toEqual([
        "money:1.0.0-SNAPSHOT#1",
        "money:1.0.0-SNAPSHOT#2",
        "stale:1.0.0-SNAPSHOT#all",
      ]);

      expect(await buildNumbers("snapshots", money)).toEqual([3, 4]);
      expect(await buildNumbers("snapshots", stale)).toEqual([]);
      const staleArtifact = await testDb.db.select().from(artifact).where(eq(artifact.name, "stale"));
      expect(staleArtifact).toEqual([]);

      expect(await getBuffer(stores.primary, moneyKeys[0]!)).toBeNull();
      expect(await getBuffer(stores.primary, moneyKeys[1]!)).toBeNull();
      expect(await getBuffer(stores.primary, moneyKeys[2]!)).not.toBeNull();
      expect(await getBuffer(stores.primary, moneyKeys[3]!)).not.toBeNull();
      for (const k of staleKeys) expect(await getBuffer(stores.primary, k)).toBeNull();

      const audits = await testDb.db
        .select({ actorType: auditEvent.actorType, action: auditEvent.action, target: auditEvent.target })
        .from(auditEvent)
        .orderBy(asc(auditEvent.target));
      expect(audits).toEqual([
        { actorType: "system", action: "cleanup.delete", target: "snapshots/acme:money:1.0.0-SNAPSHOT#1" },
        { actorType: "system", action: "cleanup.delete", target: "snapshots/acme:money:1.0.0-SNAPSHOT#2" },
        { actorType: "system", action: "cleanup.delete", target: "snapshots/acme:stale:1.0.0-SNAPSHOT" },
      ]);

      expect(await apply("snapshots")).toEqual([]);
    });

    it("records a tombstone for each release it deletes, and none for snapshots", async () => {
      const release = coord("acme", "release", "1.0.0");
      await seed("snapshots", release, { lastDownloadedAt: daysAgo(120) });
      await seed("snapshots", coord("acme", "unused", "1.0.0-SNAPSHOT"), { lastDownloadedAt: daysAgo(120) });
      await addPolicy("snapshots", { kind: "delete_not_downloaded", value: 90, includeReleases: true });

      expect(summary(await apply("snapshots"))).toEqual([
        "release:1.0.0#all",
        "unused:1.0.0-SNAPSHOT#all",
      ]);
      const tombstones = await testDb.db.select().from(deletedRelease);
      expect(tombstones).toEqual([
        expect.objectContaining({
          repositoryId: repoIds.get("snapshots"),
          group: "acme",
          name: "release",
          version: "1.0.0",
          sha256: "0".repeat(64),
        }),
      ]);
    });

    it("skips a stale version that was published again after planning", async () => {
      const money = coord("acme", "money", "1.0.0-SNAPSHOT");
      await seed("snapshots", money, { updatedAt: daysAgo(60) });
      await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

      // Hold the version's lock (as a concurrent publish would), let cleanup plan and block on it,
      // then "publish" by bumping updatedAt before releasing the lock.
      const holder = await testDb.db.$client.connect();
      try {
        await holder.query("select pg_advisory_lock(hashtext($1))", ["snapshots:acme:money:1.0.0-SNAPSHOT"]);
        const applying = apply("snapshots");
        await waitForLockWaiter();
        await testDb.db.update(version).set({ updatedAt: NOW });
        await holder.query("select pg_advisory_unlock(hashtext($1))", ["snapshots:acme:money:1.0.0-SNAPSHOT"]);
        expect(await applying).toEqual([]);
      } finally {
        holder.release();
      }
      expect(await buildNumbers("snapshots", money)).toEqual([1]);
    });

    it("skips a version that gained a dependent after planning", async () => {
      const money = coord("acme", "money", "1.0.0-SNAPSHOT");
      await seed("snapshots", money, { updatedAt: daysAgo(60) });
      await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

      const holder = await testDb.db.$client.connect();
      try {
        await holder.query("select pg_advisory_lock(hashtext($1))", ["snapshots:acme:money:1.0.0-SNAPSHOT"]);
        const applying = apply("snapshots");
        await waitForLockWaiter();
        await seed("other", coord("acme", "order", "1.0.0"), { dependsOn: [money] });
        await holder.query("select pg_advisory_unlock(hashtext($1))", ["snapshots:acme:money:1.0.0-SNAPSHOT"]);
        expect(await applying).toEqual([]);
      } finally {
        holder.release();
      }
      expect(await buildNumbers("snapshots", money)).toEqual([1]);
    });
  });

  describe("runAllCleanups", () => {
    it("applies every repository's policies and returns the number of deletions", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3 });
      await seed("other", coord("acme", "order", "1.0.0-SNAPSHOT"), { builds: 2 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
      await addPolicy("other", { kind: "keep_last_snapshot_builds", value: 1 });

      expect(await runAllCleanups(deps, { proto: protoCleanup }, NOW)).toBe(3);
      expect(await buildNumbers("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"))).toEqual([3]);
      expect(await buildNumbers("other", coord("acme", "order", "1.0.0-SNAPSHOT"))).toEqual([2]);
    });

    it("returns 0 without deleting when another session holds the cleanup lock", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });

      const holder = await testDb.db.$client.connect();
      try {
        await holder.query("select pg_advisory_lock(727001)");
        expect(await runAllCleanups(deps, { proto: protoCleanup }, NOW)).toBe(0);
        expect(await buildNumbers("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"))).toEqual([1, 2, 3]);
      } finally {
        await holder.query("select pg_advisory_unlock(727001)");
        holder.release();
      }
      expect(await runAllCleanups(deps, { proto: protoCleanup }, NOW)).toBe(2);
    });

    it("destroys the lock connection when unlocking fails, so the session lock cannot leak", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 2 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });

      const pool = testDb.db.$client;
      const realConnect = pool.connect.bind(pool) as () => Promise<PoolClient>;
      const unlockError = new Error("unlock failed");
      let released: unknown = "not released";
      const spy = vi.spyOn(pool, "connect").mockImplementationOnce((async () => {
        const client = await realConnect();
        const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        const realRelease = client.release.bind(client);
        const wrapped = Object.create(client) as PoolClient;
        wrapped.query = ((text: string, values?: unknown[]) =>
          text.includes("pg_advisory_unlock") ? Promise.reject(unlockError) : realQuery(text, values)) as PoolClient["query"];
        wrapped.release = (err?: Error | boolean) => {
          released = err;
          realRelease(err);
        };
        return wrapped;
      }) as typeof pool.connect);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(await runAllCleanups(deps, { proto: protoCleanup }, NOW)).toBe(1);
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        spy.mockRestore();
        warn.mockRestore();
      }
      expect(released).toBe(unlockError);
      // The destroyed connection took its session lock with it: the next run gets the lock.
      await seed("other", coord("acme", "order", "1.0.0-SNAPSHOT"), { builds: 2 });
      await addPolicy("other", { kind: "keep_last_snapshot_builds", value: 1 });
      expect(await runAllCleanups(deps, { proto: protoCleanup }, NOW)).toBe(1);
    });
  });
});

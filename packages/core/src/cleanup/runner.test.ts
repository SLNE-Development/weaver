import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import { auditEvent, cleanupPolicy, repository } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createAssetService } from "../content/assets.js";
import { deriveSecretKey } from "../crypto.js";
import { createRepoService, type Repo } from "../repos/index.js";
import { createStoreSetFromEnv } from "../storage/index.js";
import type { CleanupCandidate, CleanupDeps, CleanupPolicyRow, FormatCleanup } from "./types.js";
import { runAllCleanups, runRepoCleanup } from "./runner.js";

const NOW = new Date("2026-10-21T03:00:00Z");

interface RecordedCall {
  repo: string;
  policies: CleanupPolicyRow[];
  now: Date;
  dryRun: boolean;
}

/** A format cleanup that records its calls and "deletes" one candidate per policy. */
function fakeCleanup(format: FormatCleanup["format"]): FormatCleanup & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    format,
    calls,
    async run(_deps, repo: Repo, policies, now, opts): Promise<CleanupCandidate[]> {
      calls.push({ repo: repo.name, policies, now, dryRun: opts.dryRun });
      return policies.map((p) => ({ repository: repo.name, key: `${format}:${p.id}`, label: p.kind, reason: "fake" }));
    },
  };
}

describe("cleanup runner", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let deps: CleanupDeps;
  const repoIds = new Map<string, string>();

  async function insertRepo(name: string, kind: "hosted" | "mirror" | "group" = "hosted", format: "proto" | "npm" = "proto") {
    const [row] = await testDb.db.insert(repository).values({ name, format, kind }).returning({ id: repository.id });
    repoIds.set(name, row!.id);
  }

  async function addPolicy(repo: string, values: Omit<typeof cleanupPolicy.$inferInsert, "repositoryId">) {
    const [row] = await testDb.db
      .insert(cleanupPolicy)
      .values({ repositoryId: repoIds.get(repo)!, ...values })
      .returning();
    return row!;
  }

  const audits = () =>
    testDb.db
      .select({ actorType: auditEvent.actorType, action: auditEvent.action, target: auditEvent.target, details: auditEvent.details })
      .from(auditEvent)
      .orderBy(asc(auditEvent.at));

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-cleanup-runner-"));
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    deps = {
      db: testDb.db,
      stores,
      assets: createAssetService({ db: testDb.db, stores }),
      repos: createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("cleanup-runner-test-secret") }),
    };
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, audit_event CASCADE`);
    repoIds.clear();
  });

  it("skips mirror and group repos", async () => {
    await insertRepo("cache", "mirror");
    await insertRepo("all", "group");
    await addPolicy("cache", { kind: "keep_last_snapshot_builds", value: 1 });
    await addPolicy("all", { kind: "keep_last_snapshot_builds", value: 1 });
    const fake = fakeCleanup("proto");

    expect(await runRepoCleanup(deps, { proto: fake }, "cache", NOW, { dryRun: false })).toEqual([]);
    expect(await runRepoCleanup(deps, { proto: fake }, "all", NOW, { dryRun: false })).toEqual([]);
    expect(await runAllCleanups(deps, { proto: fake }, NOW)).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("returns [] for repos without enabled policies or formats not in the registry", async () => {
    await insertRepo("empty");
    await insertRepo("off");
    await insertRepo("pkgs", "hosted", "npm");
    await addPolicy("off", { kind: "keep_last_snapshot_builds", value: 1, enabled: false });
    await addPolicy("pkgs", { kind: "keep_last_versions", value: 1 });
    const fake = fakeCleanup("proto");

    expect(await runRepoCleanup(deps, { proto: fake }, "empty", NOW, { dryRun: false })).toEqual([]);
    expect(await runRepoCleanup(deps, { proto: fake }, "off", NOW, { dryRun: false })).toEqual([]);
    expect(await runRepoCleanup(deps, { proto: fake }, "pkgs", NOW, { dryRun: false })).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("passes only enabled policies in createdAt order", async () => {
    await insertRepo("snapshots");
    const second = await addPolicy("snapshots", {
      kind: "delete_stale_snapshots",
      value: 30,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    });
    await addPolicy("snapshots", { kind: "delete_not_downloaded", value: 90, enabled: false });
    const first = await addPolicy("snapshots", {
      kind: "keep_last_snapshot_builds",
      value: 2,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const fake = fakeCleanup("proto");

    await runRepoCleanup(deps, { proto: fake }, "snapshots", NOW, { dryRun: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.repo).toBe("snapshots");
    expect(fake.calls[0]!.now).toBe(NOW);
    expect(fake.calls[0]!.policies.map((p) => p.id)).toEqual([first.id, second.id]);
  });

  it("dryRun true is forwarded and nothing is audited", async () => {
    await insertRepo("snapshots");
    await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
    const fake = fakeCleanup("proto");

    const result = await runRepoCleanup(deps, { proto: fake }, "snapshots", NOW, { dryRun: true });
    expect(result).toHaveLength(1);
    expect(fake.calls.map((c) => c.dryRun)).toEqual([true]);
    expect(await audits()).toEqual([]);
  });

  it("records cleanup.run audit with the deleted count", async () => {
    await insertRepo("snapshots");
    await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });
    const fake = fakeCleanup("proto");

    const result = await runRepoCleanup(deps, { proto: fake }, "snapshots", NOW, { dryRun: false });
    expect(result).toHaveLength(2);
    expect(fake.calls.map((c) => c.dryRun)).toEqual([false]);
    expect(await audits()).toEqual([
      { actorType: "system", action: "cleanup.run", target: "snapshots", details: { format: "proto", deleted: 2 } },
    ]);
  });

  it("does not audit a run that deleted nothing", async () => {
    await insertRepo("snapshots");
    await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
    const none: FormatCleanup = { format: "proto", run: async () => [] };

    expect(await runRepoCleanup(deps, { proto: none }, "snapshots", NOW, { dryRun: false })).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("unknown repo throws not_found", async () => {
    await expect(runRepoCleanup(deps, {}, "nope", NOW, { dryRun: true })).rejects.toMatchObject({ code: "not_found" });
  });

  it("runAllCleanups runs every hosted repo with enabled policies and sums the deletions", async () => {
    await insertRepo("a");
    await insertRepo("b");
    await insertRepo("c");
    await addPolicy("a", { kind: "keep_last_snapshot_builds", value: 1 });
    await addPolicy("b", { kind: "keep_last_snapshot_builds", value: 1 });
    await addPolicy("b", { kind: "delete_stale_snapshots", value: 30 });
    const fake = fakeCleanup("proto");

    expect(await runAllCleanups(deps, { proto: fake }, NOW)).toBe(3);
    expect(fake.calls.map((c) => [c.repo, c.dryRun])).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });

  it("runAllCleanups keeps going when one repo fails and rethrows afterwards", async () => {
    await insertRepo("a");
    await insertRepo("b");
    await addPolicy("a", { kind: "keep_last_snapshot_builds", value: 1 });
    await addPolicy("b", { kind: "keep_last_snapshot_builds", value: 1 });
    const seen: string[] = [];
    const flaky: FormatCleanup = {
      format: "proto",
      async run(_deps, repo) {
        seen.push(repo.name);
        if (repo.name === "a") throw new Error("boom");
        return [{ repository: repo.name, key: "k", label: "l", reason: "r" }];
      },
    };

    await expect(runAllCleanups(deps, { proto: flaky }, NOW)).rejects.toBeInstanceOf(AggregateError);
    expect(seen).toEqual(["a", "b"]);
  });

  it("runAllCleanups returns 0 while the advisory lock is held", async () => {
    await insertRepo("snapshots");
    await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
    const fake = fakeCleanup("proto");

    const holder = await testDb.db.$client.connect();
    try {
      await holder.query("select pg_advisory_lock(727001)");
      expect(await runAllCleanups(deps, { proto: fake }, NOW)).toBe(0);
      expect(fake.calls).toEqual([]);
    } finally {
      await holder.query("select pg_advisory_unlock(727001)");
      holder.release();
    }
    expect(await runAllCleanups(deps, { proto: fake }, NOW)).toBe(1);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import {
  asset,
  component,
  dockerBlob,
  dockerBlobLink,
  dockerManifest,
  dockerManifestRef,
  protoArtifact,
  protoBuild,
  protoVersion,
  repository,
  storageSnapshot,
  usageDaily,
  usageDailyToken,
  usageEvent,
} from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { toRepo, type Format, type Kind, type Repo } from "../repos/index.js";
import { dockerStorageBytes, ROLLUP_MAX_EXPIRING_DAYS, rollupUsage, type StorageProbe } from "./rollup.js";

const NOW = new Date("2026-06-30T12:00:00Z");
const DAY_MS = 86_400_000;
const daysAgo = (days: number, at = NOW): Date => new Date(at.getTime() - days * DAY_MS);
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

describe("rollupUsage", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, usage_event, docker_blob CASCADE`);
  });

  /** Repository listing straight from the table, as the worker wires it. */
  const repos = {
    list: async (): Promise<Repo[]> =>
      (await testDb.db.select().from(repository).orderBy(asc(repository.name))).map(toRepo),
  };

  const run = (now: Date = NOW, storageProbes?: Partial<Record<Format, StorageProbe>>) =>
    rollupUsage({ db: testDb.db, repos, storageProbes }, now);

  async function repo(name: string, format: Format = "maven", kind: Kind = "hosted") {
    const [row] = await testDb.db.insert(repository).values({ name, format, kind }).returning();
    return row!;
  }

  async function pkg(repositoryId: string, namespace: string, name: string, version = "1.0.0") {
    const [row] = await testDb.db.insert(component).values({ repositoryId, namespace, name, version }).returning();
    return row!;
  }

  async function event(values: Partial<typeof usageEvent.$inferInsert> & { repositoryId: string; at: Date }) {
    await testDb.db.insert(usageEvent).values({ path: "x", action: "download", ...values });
  }

  const daily = () =>
    testDb.db
      .select()
      .from(usageDaily)
      .orderBy(asc(usageDaily.day), asc(usageDaily.namespace), asc(usageDaily.name), asc(usageDaily.action));

  it("rolls downloads per package and day in UTC", async () => {
    const r = await repo("releases");
    const lib = await pkg(r.id, "org.acme", "lib");
    await event({ repositoryId: r.id, componentId: lib.id, at: new Date("2026-06-28T23:59:00Z"), bytes: 10 });
    await event({ repositoryId: r.id, componentId: lib.id, at: new Date("2026-06-29T00:01:00Z"), bytes: 5 });
    await event({ repositoryId: r.id, componentId: lib.id, at: new Date("2026-06-29T10:00:00Z"), bytes: 5 });

    const result = await run();

    expect(result.daysRolled).toBe(3);
    expect((await daily()).map((d) => [d.day, d.namespace, d.name, d.action, d.count, d.bytes])).toEqual([
      ["2026-06-28", "org.acme", "lib", "download", 1, 10],
      ["2026-06-29", "org.acme", "lib", "download", 2, 10],
    ]);
  });

  it("counts cache results", async () => {
    const r = await repo("central", "maven", "mirror");
    const at = daysAgo(0);
    const results = [
      ...Array<"hit">(3).fill("hit"),
      "stale" as const,
      ...Array<"miss">(2).fill("miss"),
      ...Array<"bypass">(4).fill("bypass"),
    ];
    for (const cache of results) await event({ repositoryId: r.id, at, cache, path: "a.txt" });

    await run();

    const [row] = await daily();
    expect(row).toMatchObject({ count: 10, cacheHit: 3, cacheStale: 1, cacheMiss: 2, cacheBypass: 4 });
  });

  it("events without a component roll up under namespace '' and name ''", async () => {
    const r = await repo("protos", "proto");
    await event({ repositoryId: r.id, at: daysAgo(0), path: "acme/money/1.0.0" });

    await run();

    expect((await daily()).map((d) => [d.namespace, d.name, d.count])).toEqual([["", "", 1]]);
  });

  it("attributes mirror events without a component by their path", async () => {
    const central = await repo("central", "maven", "mirror");
    const npmjs = await repo("npmjs", "npm", "mirror");
    const hub = await repo("hub", "docker", "mirror");
    const at = daysAgo(0);
    await event({ repositoryId: central.id, at, cache: "miss", path: "org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar" });
    await event({ repositoryId: central.id, at, cache: "bypass", path: "org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.pom" });
    await event({ repositoryId: central.id, at, cache: "miss", path: "odd.txt" });
    await event({ repositoryId: npmjs.id, at, cache: "miss", path: "@acme/ui/-/ui-1.0.0.tgz" });
    await event({ repositoryId: npmjs.id, at, cache: "miss", path: "left-pad/-/left-pad-1.3.0.tgz" });
    await event({ repositoryId: hub.id, at, cache: "miss", path: "library/nginx/blobs/sha256:abc" });
    await event({ repositoryId: hub.id, at, cache: "hit", path: "v2/library/nginx/manifests/latest" });

    await run();

    const rows = await testDb.db
      .select({ repositoryId: usageDaily.repositoryId, namespace: usageDaily.namespace, name: usageDaily.name, count: usageDaily.count })
      .from(usageDaily)
      .orderBy(asc(usageDaily.namespace), asc(usageDaily.name));
    const byRepo = (id: string) => rows.filter((r) => r.repositoryId === id).map((r) => [r.namespace, r.name, r.count]);
    expect(byRepo(central.id)).toEqual([
      ["", "", 1],
      ["org.apache.commons", "commons-lang3", 2],
    ]);
    expect(byRepo(npmjs.id)).toEqual([
      ["", "left-pad", 1],
      ["acme", "ui", 1],
    ]);
    expect(byRepo(hub.id)).toEqual([["", "library/nginx", 2]]);
  });

  it("token rollup only includes events with an apiKeyId", async () => {
    const r = await repo("releases");
    const at = daysAgo(0);
    await event({ repositoryId: r.id, at, apiKeyId: "key-1", userId: "user-1", bytes: 3 });
    await event({ repositoryId: r.id, at, apiKeyId: "key-1", userId: "user-1", bytes: 4 });
    await event({ repositoryId: r.id, at, apiKeyId: "key-1", userId: "user-1", action: "upload", bytes: 9 });
    await event({ repositoryId: r.id, at, userId: "user-1" });
    await event({ repositoryId: r.id, at });

    await run();

    const rows = await testDb.db.select().from(usageDailyToken).orderBy(asc(usageDailyToken.action));
    expect(rows.map((t) => [t.day, t.apiKeyId, t.userId, t.repositoryId, t.action, t.count, t.bytes])).toEqual([
      [dayOf(NOW), "key-1", "user-1", r.id, "download", 2, 7],
      [dayOf(NOW), "key-1", "user-1", r.id, "upload", 1, 9],
    ]);
  });

  it("re-running is idempotent", async () => {
    const r = await repo("releases");
    const lib = await pkg(r.id, "org.acme", "lib");
    await event({ repositoryId: r.id, componentId: lib.id, at: daysAgo(1), apiKeyId: "k", bytes: 2 });
    await event({ repositoryId: r.id, componentId: lib.id, at: daysAgo(0), apiKeyId: "k", bytes: 2 });

    await run();
    const first = { daily: await daily(), tokens: await testDb.db.select().from(usageDailyToken) };
    await run();

    expect(await daily()).toEqual(first.daily);
    expect(await testDb.db.select().from(usageDailyToken)).toEqual(first.tokens);
    expect((await daily()).map((d) => d.count)).toEqual([1, 1]);
  });

  it("back-fills a gap", async () => {
    const r = await repo("releases");
    await testDb.db
      .insert(usageDaily)
      .values({ day: dayOf(daysAgo(5)), repositoryId: r.id, action: "download", count: 99, bytes: 0 });
    for (let d = 5; d >= 0; d--) await event({ repositoryId: r.id, at: daysAgo(d) });

    const result = await run();

    expect(result.daysRolled).toBe(6);
    const rows = await daily();
    expect(rows.map((d) => [d.day, d.count])).toEqual([5, 4, 3, 2, 1, 0].map((d) => [dayOf(daysAgo(d)), 1]));
  });

  it("does not touch days before the newest rolled-up day", async () => {
    const r = await repo("releases");
    await testDb.db
      .insert(usageDaily)
      .values({ day: dayOf(daysAgo(10)), repositoryId: r.id, action: "download", count: 7, bytes: 0 });
    await testDb.db
      .insert(usageDaily)
      .values({ day: dayOf(daysAgo(2)), repositoryId: r.id, action: "download", count: 1, bytes: 0 });
    await event({ repositoryId: r.id, at: daysAgo(2) });

    const result = await run();

    expect(result.daysRolled).toBe(3);
    expect((await daily()).map((d) => [d.day, d.count])).toEqual([
      [dayOf(daysAgo(10)), 7],
      [dayOf(daysAgo(2)), 1],
    ]);
  });

  it("keeps the rollup of an expired day on later runs", async () => {
    const r = await repo("releases");
    await event({ repositoryId: r.id, at: daysAgo(100), bytes: 8 });

    expect((await run()).eventsDeleted).toBe(1);
    await run();
    await run(new Date(NOW.getTime() + DAY_MS));

    expect((await daily()).map((d) => [d.day, d.count, d.bytes])).toEqual([[dayOf(daysAgo(100)), 1, 8]]);
  });

  it("never re-rolls days at or before the retention cutoff, so a long idle gap keeps its history", async () => {
    const r = await repo("releases");
    await event({ repositoryId: r.id, at: daysAgo(95) });
    await run();
    const later = new Date(NOW.getTime() + 30 * DAY_MS);
    expect((await run(later)).daysRolled).toBe(0);
    await event({ repositoryId: r.id, at: later });

    const result = await run(later);

    expect(result.daysRolled).toBe(1);
    expect((await daily()).map((d) => [d.day, d.count])).toEqual([
      [dayOf(daysAgo(95)), 1],
      [dayOf(later), 1],
    ]);
  });

  it("re-rolls at most the retention window of recent days", async () => {
    const r = await repo("releases");
    await testDb.db.insert(usageDaily).values({ day: dayOf(daysAgo(200)), repositoryId: r.id, action: "download", count: 1, bytes: 0 });
    for (let d = 0; d < 89; d++) await event({ repositoryId: r.id, at: daysAgo(d) });
    // An old rollup row (day 200) never pulls the start back: the oldest event (day 88) sets it.

    expect((await run()).daysRolled).toBe(89);
    const rows = await daily();
    expect(rows).toHaveLength(90);
    expect(rows[0]).toMatchObject({ day: dayOf(daysAgo(200)), count: 1 });
  });

  it("rolls a bounded number of expiring days per run and deletes only the rolled ones", async () => {
    const r = await repo("releases");
    for (let d = 0; d < ROLLUP_MAX_EXPIRING_DAYS + 2; d++) await event({ repositoryId: r.id, at: daysAgo(400 - d) });

    const first = await run();

    expect(first.eventsDeleted).toBe(ROLLUP_MAX_EXPIRING_DAYS);
    expect(await testDb.db.select().from(usageEvent)).toHaveLength(2);
    const second = await run();
    expect(second.eventsDeleted).toBe(2);
    expect(await daily()).toHaveLength(ROLLUP_MAX_EXPIRING_DAYS + 2);
  });

  it("retention deletes events older than 90 days only after their day is rolled up", async () => {
    const r = await repo("releases");
    await event({ repositoryId: r.id, at: daysAgo(100), bytes: 8 });
    await event({ repositoryId: r.id, at: daysAgo(89) });
    await testDb.db
      .insert(usageDaily)
      .values({ day: dayOf(daysAgo(1)), repositoryId: r.id, action: "download", count: 0, bytes: 0 });

    const result = await run();

    expect(result.eventsDeleted).toBe(1);
    const remaining = await testDb.db.select({ at: usageEvent.at }).from(usageEvent);
    expect(remaining.map((e) => e.at)).toEqual([daysAgo(89)]);
    const [old] = await testDb.db.select().from(usageDaily).where(eq(usageDaily.day, dayOf(daysAgo(100))));
    expect(old).toMatchObject({ count: 1, bytes: 8 });
  });

  it("deletes storage snapshots older than 400 days", async () => {
    const r = await repo("releases");
    await testDb.db.insert(storageSnapshot).values([
      { day: dayOf(daysAgo(401)), repositoryId: r.id, hostedBytes: 1, cacheBytes: 0, assetCount: 1 },
      { day: dayOf(daysAgo(399)), repositoryId: r.id, hostedBytes: 1, cacheBytes: 0, assetCount: 1 },
    ]);

    await run();

    const days = (await testDb.db.select({ day: storageSnapshot.day }).from(storageSnapshot).orderBy(asc(storageSnapshot.day))).map(
      (s) => s.day,
    );
    expect(days).toEqual([dayOf(daysAgo(399)), dayOf(NOW)]);
  });

  it("storage snapshot sums hosted and cache assets per repo, adds proto build sizes, and uses the docker probe for docker repos", async () => {
    const releases = await repo("releases");
    const central = await repo("central", "maven", "mirror");
    const protos = await repo("protos", "proto");
    const images = await repo("images", "docker");
    const group = await repo("all", "maven", "group");
    const file = (repositoryId: string, path: string, size: number, origin: "hosted" | "cache") => ({
      repositoryId,
      path,
      store: "local" as const,
      storageKey: `${repositoryId}/${path}`,
      size,
      md5: "0",
      sha1: "0",
      sha256: "0",
      sha512: "0",
      origin,
    });
    await testDb.db.insert(asset).values([
      file(releases.id, "a.jar", 100, "hosted"),
      file(releases.id, "b.jar", 50, "hosted"),
      file(central.id, "c.jar", 70, "cache"),
      file(images.id, "d", 5, "cache"),
    ]);
    const [art] = await testDb.db.insert(protoArtifact).values({ repositoryId: protos.id, group: "acme", name: "money" }).returning();
    const [ver] = await testDb.db.insert(protoVersion).values({ artifactId: art!.id, version: "1.0.0", isSnapshot: false }).returning();
    await testDb.db
      .insert(protoBuild)
      .values({ versionId: ver!.id, buildNumber: 1, store: "local", storageKey: "k", sha256: "0".repeat(64), sizeBytes: 33 });
    const probed: string[] = [];
    const docker: StorageProbe = async (repo) => {
      probed.push(repo.name);
      return { hostedBytes: 1234, cacheBytes: 10 };
    };

    const result = await run(NOW, { docker });

    expect(probed).toEqual(["images"]);
    expect(result.repositoriesMeasured).toBe(4);
    const rows = await testDb.db.select().from(storageSnapshot);
    const of = (id: string) => rows.find((s) => s.repositoryId === id);
    expect(of(releases.id)).toMatchObject({ day: dayOf(NOW), hostedBytes: 150, cacheBytes: 0, assetCount: 2 });
    expect(of(central.id)).toMatchObject({ hostedBytes: 0, cacheBytes: 70, assetCount: 1 });
    expect(of(protos.id)).toMatchObject({ hostedBytes: 33, cacheBytes: 0, assetCount: 1 });
    expect(of(images.id)).toMatchObject({ hostedBytes: 1234, cacheBytes: 10, assetCount: 1 });
    expect(of(group.id)).toBeUndefined();
    expect(of(releases.id)?.takenAt).toEqual(NOW);
  });

  it("falls back to the generic sum when a probe returns null, and upserts today's snapshot", async () => {
    const images = await repo("images", "docker", "mirror");
    await testDb.db.insert(asset).values({
      repositoryId: images.id,
      path: "x",
      store: "local",
      storageKey: "x",
      size: 9,
      md5: "0",
      sha1: "0",
      sha256: "0",
      sha512: "0",
      origin: "cache",
    });

    await run(NOW, { docker: async () => null });
    const later = new Date(NOW.getTime() + 3_600_000);
    await run(later, { docker: async () => null });

    const rows = await testDb.db.select().from(storageSnapshot);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostedBytes: 0, cacheBytes: 9, assetCount: 1, takenAt: later });
  });

  it("skips with daysRolled 0 while the lock is held", async () => {
    const r = await repo("releases");
    await event({ repositoryId: r.id, at: daysAgo(0) });

    const holder = await testDb.db.$client.connect();
    try {
      await holder.query("select pg_advisory_lock(727002)");
      expect(await run()).toEqual({ daysRolled: 0, eventsDeleted: 0, repositoriesMeasured: 0 });
      expect(await daily()).toEqual([]);
    } finally {
      await holder.query("select pg_advisory_unlock(727002)");
      holder.release();
    }
    expect((await run()).daysRolled).toBe(1);
  });
});

describe("dockerStorageBytes", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("counts each blob linked into a hosted repository once by digest, at its stored size, plus the manifests", async () => {
    const [row] = await testDb.db.insert(repository).values({ name: "images", format: "docker", kind: "hosted" }).returning();
    const repo = toRepo(row!);
    const [other] = await testDb.db.insert(repository).values({ name: "other", format: "docker", kind: "hosted" }).returning();
    const blobs = await testDb.db
      .insert(dockerBlob)
      .values([
        { store: "local", digest: "sha256:l1", size: 1000, storageKey: "l1" },
        { store: "local", digest: "sha256:c1", size: 10, storageKey: "c1" },
        { store: "local", digest: "sha256:x1", size: 7777, storageKey: "x1" },
      ])
      .returning();
    const id = (digest: string) => blobs.find((b) => b.digest === digest)!.id;
    await testDb.db.insert(dockerBlobLink).values([
      { repositoryId: repo.id, image: "app", blobId: id("sha256:l1"), digest: "sha256:l1" },
      { repositoryId: repo.id, image: "app", blobId: id("sha256:c1"), digest: "sha256:c1" },
      { repositoryId: repo.id, image: "tool", blobId: id("sha256:l1"), digest: "sha256:l1" },
      { repositoryId: other!.id, image: "x", blobId: id("sha256:x1"), digest: "sha256:x1" },
    ]);
    const manifest = async (image: string, digest: string, size: number) => {
      const [m] = await testDb.db
        .insert(dockerManifest)
        .values({ repositoryId: repo.id, image, digest, mediaType: "application/vnd.oci.image.manifest.v1+json", size, totalSize: 0, content: Buffer.from("{}") })
        .returning();
      return m!;
    };
    const a = await manifest("app", "sha256:m1", 200);
    await manifest("tool", "sha256:m2", 300);
    // A manifest-declared size that disagrees with the stored blob is ignored.
    await testDb.db.insert(dockerManifestRef).values([
      { manifestId: a.id, digest: "sha256:l1", kind: "blob", mediaType: "layer", size: 5, position: 0 },
    ]);

    expect(await dockerStorageBytes(testDb.db)(repo)).toEqual({ hostedBytes: 1510, cacheBytes: 0 });
  });

  it("returns null for docker mirrors, whose caches are assets", async () => {
    const [row] = await testDb.db.insert(repository).values({ name: "hub", format: "docker", kind: "mirror" }).returning();
    expect(await dockerStorageBytes(testDb.db)(toRepo(row!))).toBeNull();
  });
});

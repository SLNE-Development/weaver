import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { component, repository, storageSnapshot, usageDaily, usageDailyToken, usageEvent } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import type { Format, Kind } from "../repos/index.js";
import {
  cacheHitRates,
  downloadsSeries,
  latestStorage,
  packageLabel,
  tokenEvents,
  tokenSeries,
  tokenSummaries,
  topPackages,
} from "./queries.js";

const range = { from: "2026-06-01", to: "2026-06-05" };

describe("stats queries", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, usage_event, usage_daily_token CASCADE`);
  });

  async function repo(name: string, format: Format = "maven", kind: Kind = "hosted") {
    const [row] = await testDb.db.insert(repository).values({ name, format, kind }).returning();
    return row!;
  }

  type DailyInput = Partial<typeof usageDaily.$inferInsert> & { day: string; repositoryId: string };
  const daily = (rows: DailyInput[]) =>
    testDb.db.insert(usageDaily).values(rows.map((r) => ({ action: "download" as const, count: 1, bytes: 0, ...r })));

  it("series is zero-filled for days without rows", async () => {
    const a = await repo("a");
    const b = await repo("b");
    await daily([
      { day: "2026-06-02", repositoryId: a.id, name: "lib", count: 3, bytes: 30 },
      { day: "2026-06-02", repositoryId: a.id, name: "app", count: 1, bytes: 5 },
      { day: "2026-06-04", repositoryId: a.id, action: "upload", count: 2, bytes: 7 },
      { day: "2026-06-04", repositoryId: b.id, count: 10, bytes: 100 },
      { day: "2026-06-04", repositoryId: a.id, action: "delete", count: 4, bytes: 0 },
      { day: "2026-05-31", repositoryId: a.id, count: 50 },
    ]);

    expect(await downloadsSeries(testDb.db, range, [a.id])).toEqual([
      { day: "2026-06-01", downloads: 0, uploads: 0, bytes: 0 },
      { day: "2026-06-02", downloads: 4, uploads: 0, bytes: 35 },
      { day: "2026-06-03", downloads: 0, uploads: 0, bytes: 0 },
      { day: "2026-06-04", downloads: 0, uploads: 2, bytes: 7 },
      { day: "2026-06-05", downloads: 0, uploads: 0, bytes: 0 },
    ]);
    expect((await downloadsSeries(testDb.db, range)).map((p) => p.downloads)).toEqual([0, 4, 0, 10, 0]);
    expect((await downloadsSeries(testDb.db, range, [])).map((p) => p.downloads)).toEqual([0, 0, 0, 0, 0]);
  });

  it("top packages rank downloads in range and skip events without a package", async () => {
    const a = await repo("a");
    await daily([
      { day: "2026-06-01", repositoryId: a.id, namespace: "org.x", name: "lib", count: 3 },
      { day: "2026-06-03", repositoryId: a.id, namespace: "org.x", name: "lib", count: 4 },
      { day: "2026-06-03", repositoryId: a.id, namespace: "org.x", name: "app", count: 5 },
      { day: "2026-06-03", repositoryId: a.id, namespace: "org.x", name: "lib", action: "upload", count: 100 },
      { day: "2026-06-03", repositoryId: a.id, count: 99 },
      { day: "2026-07-01", repositoryId: a.id, namespace: "org.x", name: "app", count: 50 },
    ]);

    expect(await topPackages(testDb.db, range, { limit: 10 })).toEqual([
      { repositoryId: a.id, namespace: "org.x", name: "lib", downloads: 7 },
      { repositoryId: a.id, namespace: "org.x", name: "app", downloads: 5 },
    ]);
    expect(await topPackages(testDb.db, range, { limit: 1, repositoryIds: [a.id] })).toHaveLength(1);
    expect(await topPackages(testDb.db, range, { limit: 10, repositoryIds: [] })).toEqual([]);
  });

  it("latest storage takes each repository's newest snapshot", async () => {
    const a = await repo("a");
    const b = await repo("b");
    const takenAt = new Date("2026-06-05T10:00:00Z");
    await testDb.db.insert(storageSnapshot).values([
      { day: "2026-06-04", repositoryId: a.id, hostedBytes: 1, cacheBytes: 0, assetCount: 1, takenAt },
      { day: "2026-06-05", repositoryId: a.id, hostedBytes: 2, cacheBytes: 3, assetCount: 4, takenAt },
      { day: "2026-06-01", repositoryId: b.id, hostedBytes: 9, cacheBytes: 9, assetCount: 9, takenAt },
    ]);

    const rows = await latestStorage(testDb.db, [a.id]);
    expect(rows).toEqual([{ repositoryId: a.id, hostedBytes: 2, cacheBytes: 3, assetCount: 4, takenAt }]);
    expect(await latestStorage(testDb.db)).toHaveLength(2);
  });

  it("hit rate counts stale as hit and excludes bypass", async () => {
    const m = await repo("central", "maven", "mirror");
    await daily([
      { day: "2026-06-01", repositoryId: m.id, name: "a", count: 9, cacheHit: 2, cacheMiss: 4, cacheBypass: 3 },
      { day: "2026-06-02", repositoryId: m.id, name: "b", count: 8, cacheHit: 1, cacheStale: 1, cacheBypass: 6 },
    ]);

    expect(await cacheHitRates(testDb.db, range, [m.id])).toEqual([
      { repositoryId: m.id, hits: 3, stale: 1, misses: 4, bypass: 9, hitRate: 0.5 },
    ]);
  });

  it("hit rate is null without hits or misses", async () => {
    const m = await repo("central", "maven", "mirror");
    await daily([{ day: "2026-06-01", repositoryId: m.id, count: 2, cacheBypass: 2 }]);

    expect(await cacheHitRates(testDb.db, range)).toEqual([
      { repositoryId: m.id, hits: 0, stale: 0, misses: 0, bypass: 2, hitRate: null },
    ]);
  });

  it("token summaries total actions per key, newest activity first", async () => {
    const a = await repo("a");
    const b = await repo("b");
    await testDb.db.insert(usageDailyToken).values([
      { day: "2026-06-01", apiKeyId: "k1", userId: "u1", repositoryId: a.id, action: "download", count: 3, bytes: 0 },
      { day: "2026-06-02", apiKeyId: "k1", userId: "u1", repositoryId: b.id, action: "download", count: 2, bytes: 0 },
      { day: "2026-06-02", apiKeyId: "k1", userId: "u1", repositoryId: b.id, action: "upload", count: 1, bytes: 0 },
      { day: "2026-06-04", apiKeyId: "k2", userId: null, repositoryId: a.id, action: "delete", count: 1, bytes: 0 },
      { day: "2026-07-01", apiKeyId: "k3", userId: null, repositoryId: a.id, action: "download", count: 1, bytes: 0 },
    ]);

    expect(await tokenSummaries(testDb.db, range, 10)).toEqual([
      { apiKeyId: "k2", userId: null, downloads: 0, uploads: 0, deletes: 1, lastDay: "2026-06-04" },
      { apiKeyId: "k1", userId: "u1", downloads: 5, uploads: 1, deletes: 0, lastDay: "2026-06-02" },
    ]);
    expect((await tokenSeries(testDb.db, "k1", range)).map((p) => [p.downloads, p.uploads])).toEqual([
      [3, 0],
      [2, 1],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it("tokenEvents orders and pages by time, then id", async () => {
    const a = await repo("a");
    const at = (h: number) => new Date(Date.UTC(2026, 5, 1, h));
    // Inserted out of time order: ids do not follow time.
    for (const [path, h] of [["late", 5], ["early", 1], ["tie-a", 3], ["tie-b", 3], ["middle", 2]] as const) {
      await testDb.db.insert(usageEvent).values({ repositoryId: a.id, path, action: "download", apiKeyId: "k1", at: at(h) });
    }

    const pages: string[][] = [];
    let before: number | undefined;
    for (;;) {
      const page = await tokenEvents(testDb.db, "k1", { limit: 2, before });
      if (page.length === 0) break;
      pages.push(page.map((e) => e.path));
      before = page.at(-1)!.id;
    }

    expect(pages).toEqual([["late", "tie-b"], ["tie-a", "middle"], ["early"]]);
  });

  it("tokenEvents pages with before", async () => {
    const a = await repo("a", "npm");
    const [pkg] = await testDb.db.insert(component).values({ repositoryId: a.id, namespace: "acme", name: "ui", version: "1.0.0" }).returning();
    for (let i = 0; i < 5; i++) {
      await testDb.db.insert(usageEvent).values({
        repositoryId: a.id,
        componentId: i === 4 ? pkg!.id : null,
        path: `p${i}`,
        action: i === 0 ? "upload" : "download",
        bytes: i,
        apiKeyId: "k1",
        at: new Date(Date.UTC(2026, 5, 1, i)),
      });
    }
    await testDb.db.insert(usageEvent).values({ repositoryId: a.id, path: "other", action: "download", apiKeyId: "k2" });

    const first = await tokenEvents(testDb.db, "k1", { limit: 2 });
    expect(first.map((e) => e.path)).toEqual(["p4", "p3"]);
    expect(first[0]).toMatchObject({ action: "download", repository: "a", label: "@acme/ui", bytes: 4, at: new Date(Date.UTC(2026, 5, 1, 4)) });
    expect(first[1]?.label).toBeNull();
    const second = await tokenEvents(testDb.db, "k1", { limit: 2, before: first[1]!.id });
    expect(second.map((e) => e.path)).toEqual(["p2", "p1"]);
    const last = await tokenEvents(testDb.db, "k1", { limit: 2, before: second[1]!.id });
    expect(last.map((e) => [e.path, e.action])).toEqual([["p0", "upload"]]);
  });
});

describe("packageLabel", () => {
  it("labels packages the way each format names them", () => {
    expect(packageLabel("maven", "org.x", "lib")).toBe("org.x:lib");
    expect(packageLabel("proto", "acme", "money")).toBe("acme:money");
    expect(packageLabel("npm", "acme", "ui")).toBe("@acme/ui");
    expect(packageLabel("npm", "@acme", "ui")).toBe("@acme/ui");
    expect(packageLabel("npm", "", "left-pad")).toBe("left-pad");
    expect(packageLabel("docker", "", "team/app")).toBe("team/app");
    expect(packageLabel("maven", "", "")).toBe("");
  });
});

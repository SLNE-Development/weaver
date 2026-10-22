import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupPolicy, component, repository, storageSnapshot, usageDaily, usageDailyToken } from "./index.js";
import { startTestDb } from "./testing.js";

describe("extras schema", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let repositoryId: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    const [repo] = await testDb.db
      .insert(repository)
      .values({ name: "extras", format: "maven", kind: "hosted" })
      .returning();
    repositoryId = repo!.id;
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it("inserting a policy with kind keep_last_tags and pattern 'v*' succeeds", async () => {
    const [policy] = await testDb.db
      .insert(cleanupPolicy)
      .values({ repositoryId, kind: "keep_last_tags", value: 5, pattern: "v*" })
      .returning();
    expect(policy!.pattern).toBe("v*");
    const [plain] = await testDb.db
      .insert(cleanupPolicy)
      .values({ repositoryId, kind: "keep_last_versions", value: 3 })
      .returning();
    expect(plain!.pattern).toBeNull();
    await testDb.db.insert(cleanupPolicy).values({ repositoryId, kind: "delete_untagged_manifests", value: 7 });
  });

  it("component.search_text is generated from namespace and name", async () => {
    const [row] = await testDb.db
      .insert(component)
      .values({ repositoryId, namespace: "Org.Apache", name: "Commons:Lang3", version: "3.14" })
      .returning();
    expect(row!.searchText).toBe("org.apache commons lang3");
    const [docker] = await testDb.db
      .insert(component)
      .values({ repositoryId, namespace: "", name: "Team/App", version: "1" })
      .returning();
    expect(docker!.searchText).toBe("team app");
  });

  it("has a GIN trigram index on component.search_text", async () => {
    const { rows } = await testDb.db.$client.query(
      "select indexdef from pg_indexes where indexname = 'component_search_text_trgm'",
    );
    expect(rows).toHaveLength(1);
    const def = (rows[0] as { indexdef: string }).indexdef;
    expect(def).toContain("USING gin");
    expect(def).toContain("gin_trgm_ops");
  });

  it("indexes asset.component_id for the per-component asset checks", async () => {
    const { rows } = await testDb.db.$client.query("select indexdef from pg_indexes where indexname = 'asset_component_idx'");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { indexdef: string }).indexdef).toContain("(component_id)");
  });

  it("stats tables accept rows and apply defaults", async () => {
    await testDb.db.insert(usageDaily).values({
      day: "2026-10-21",
      repositoryId,
      action: "download",
      count: 3,
      bytes: 1024,
    });
    const [daily] = await testDb.db.select().from(usageDaily);
    expect(daily!.namespace).toBe("");
    expect(daily!.name).toBe("");
    expect(daily!.cacheHit).toBe(0);
    expect(daily!.cacheBypass).toBe(0);

    await testDb.db.insert(usageDailyToken).values({
      day: "2026-10-21",
      apiKeyId: "key-1",
      repositoryId,
      action: "download",
      count: 1,
      bytes: 10,
    });
    const [token] = await testDb.db.select().from(usageDailyToken);
    expect(token!.userId).toBeNull();

    await testDb.db
      .insert(storageSnapshot)
      .values({ day: "2026-10-21", repositoryId, hostedBytes: 5, cacheBytes: 6, assetCount: 7 });
    const [snap] = await testDb.db.select().from(storageSnapshot);
    expect(snap!.takenAt).toBeInstanceOf(Date);

    await expect(
      testDb.db.insert(usageDaily).values({ day: "2026-10-21", repositoryId, action: "download", count: 1, bytes: 1 }),
    ).rejects.toThrow();

    await testDb.db.$client.query("delete from repository where id = $1", [repositoryId]);
    for (const table of ["usage_daily", "usage_daily_token", "storage_snapshot"]) {
      const { rows } = await testDb.db.$client.query(`select count(*)::int as n from ${table}`);
      expect((rows[0] as { n: number }).n).toBe(0);
    }
  });
});

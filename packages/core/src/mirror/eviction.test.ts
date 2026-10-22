import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { asset, repository } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createAssetService, type AssetService } from "../content/assets.js";
import { createStoreSetFromEnv, getBuffer, putBuffer, type StoreSet } from "../storage/index.js";
import { evictCaches } from "./eviction.js";

const NOW = new Date("2026-06-30T12:00:00Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

describe("evictCaches", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let stores: StoreSet;
  let assets: AssetService;

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-evict-"));
    stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    assets = createAssetService({ db: testDb.db, stores });
  });

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository CASCADE`);
  });

  async function repo(name: string, cache: Record<string, unknown> | null) {
    const [row] = await testDb.db
      .insert(repository)
      .values({ name, format: "maven", kind: cache ? "mirror" : "hosted", config: cache ? { cache } : {} })
      .returning();
    return row!;
  }

  async function put(repoId: string, path: string, origin: "hosted" | "cache", size: number, accessed: Date | null) {
    const storageKey = `${repoId}/${origin}/${path.replace(/\//g, "_")}`;
    await putBuffer(stores.primary, storageKey, Buffer.alloc(size, 1));
    await testDb.db.insert(asset).values({
      repositoryId: repoId,
      path,
      store: stores.primary.id,
      storageKey,
      size,
      md5: "0",
      sha1: "0",
      sha256: "0",
      sha512: "0",
      origin,
      lastAccessedAt: accessed,
      createdAt: accessed ?? daysAgo(100),
    });
    return storageKey;
  }

  async function paths(repoId: string): Promise<string[]> {
    return (await assets.list(repoId, "")).map((a) => a.path);
  }

  it("evicts cache assets idle longer than maxAgeDays", async () => {
    const mirror = await repo("central", { enabled: true, maxAgeDays: 30 });
    const oldKey = await put(mirror.id, "old.jar", "cache", 10, daysAgo(31));
    await put(mirror.id, "fresh.jar", "cache", 10, daysAgo(29));

    const result = await evictCaches({ db: testDb.db, assets, now: NOW });

    expect(result).toEqual({ repositories: 1, assetsDeleted: 1, bytesFreed: 10 });
    expect(await paths(mirror.id)).toEqual(["fresh.jar"]);
    expect(await getBuffer(stores.primary, oldKey)).toBeNull();
  });

  it("evicts the least recently accessed assets until the total fits maxSizeBytes", async () => {
    const mirror = await repo("central", { enabled: true, maxSizeBytes: 25 });
    await put(mirror.id, "a.jar", "cache", 10, daysAgo(3));
    await put(mirror.id, "b.jar", "cache", 10, daysAgo(1));
    await put(mirror.id, "c.jar", "cache", 10, daysAgo(2));

    const result = await evictCaches({ db: testDb.db, assets, now: NOW });

    expect(result).toEqual({ repositories: 1, assetsDeleted: 1, bytesFreed: 10 });
    expect(await paths(mirror.id)).toEqual(["b.jar", "c.jar"]);
  });

  it("deletes every cache asset of a mirror whose caching is disabled", async () => {
    const mirror = await repo("central", { enabled: false });
    await put(mirror.id, "a.jar", "cache", 7, daysAgo(0));
    await put(mirror.id, "b.jar", "cache", 5, null);

    const result = await evictCaches({ db: testDb.db, assets, now: NOW });

    expect(result).toEqual({ repositories: 1, assetsDeleted: 2, bytesFreed: 12 });
    expect(await paths(mirror.id)).toEqual([]);
  });

  it("never touches hosted assets, and keeps enabled mirrors without limits as they are", async () => {
    const hosted = await repo("releases", null);
    await put(hosted.id, "h.jar", "hosted", 10, daysAgo(900));
    const unlimited = await repo("central", { enabled: true });
    await put(unlimited.id, "c.jar", "cache", 10, daysAgo(900));
    const limited = await repo("limited", { enabled: true, maxAgeDays: 1, maxSizeBytes: 1 });
    await put(limited.id, "kept-hosted.jar", "hosted", 50, daysAgo(900));
    await put(limited.id, "gone.jar", "cache", 10, daysAgo(900));

    const result = await evictCaches({ db: testDb.db, assets, now: NOW });

    expect(result).toEqual({ repositories: 1, assetsDeleted: 1, bytesFreed: 10 });
    expect(await paths(hosted.id)).toEqual(["h.jar"]);
    expect(await paths(unlimited.id)).toEqual(["c.jar"]);
    expect(await paths(limited.id)).toEqual(["kept-hosted.jar"]);
  });

  it("works through more rows than one batch", async () => {
    const aged = await repo("aged", { enabled: true, maxAgeDays: 10 });
    const sized = await repo("sized", { enabled: true, maxSizeBytes: 20 });
    const off = await repo("off", { enabled: false });
    for (let n = 0; n < 7; n++) {
      await put(aged.id, `old-${n}.jar`, "cache", 1, daysAgo(20 + n));
      await put(sized.id, `s-${n}.jar`, "cache", 10, daysAgo(n + 1));
      await put(off.id, `o-${n}.jar`, "cache", 1, daysAgo(n));
    }
    await put(aged.id, "fresh.jar", "cache", 1, daysAgo(1));

    const result = await evictCaches({ db: testDb.db, assets, now: NOW, batchSize: 3 });

    expect(result).toEqual({ repositories: 3, assetsDeleted: 7 + 5 + 7, bytesFreed: 7 + 50 + 7 });
    expect(await paths(aged.id)).toEqual(["fresh.jar"]);
    expect(await paths(sized.id)).toEqual(["s-0.jar", "s-1.jar"]);
    expect(await paths(off.id)).toEqual([]);
  });

  it("logs and skips a repository whose eviction fails, and still evicts the others", async () => {
    const bad = await repo("a-bad", { enabled: false });
    const good = await repo("b-good", { enabled: false });
    await put(bad.id, "x.jar", "cache", 1, daysAgo(1));
    await put(good.id, "y.jar", "cache", 2, daysAgo(1));
    const failing: AssetService = {
      ...assets,
      delete: (row) => (row.path === "x.jar" ? Promise.reject(new Error("boom")) : assets.delete(row)),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await evictCaches({ db: testDb.db, assets: failing, now: NOW });
    warn.mockRestore();

    expect(result).toEqual({ repositories: 1, assetsDeleted: 1, bytesFreed: 2 });
    expect(await paths(bad.id)).toEqual(["x.jar"]);
    expect(await paths(good.id)).toEqual([]);
  });
});

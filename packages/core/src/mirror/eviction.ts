import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { asset, repository, type Db } from "@weaver/db";
import type { AssetRow, AssetService } from "../content/assets.js";
import { readRepositoryConfig, type MirrorConfig } from "../repos/config.js";

/** What one eviction run removed: repositories that lost assets, deleted asset count, and bytes freed. */
export interface EvictionResult {
  repositories: number;
  assetsDeleted: number;
  bytesFreed: number;
}

/** Default number of rows read and deleted per round trip. */
export const EVICTION_BATCH_SIZE = 1000;

/** The columns eviction needs of a cache asset. */
const evictable = {
  id: asset.id,
  path: asset.path,
  size: asset.size,
  store: asset.store,
  storageKey: asset.storageKey,
  lastAccessedAt: asset.lastAccessedAt,
  createdAt: asset.createdAt,
};

/** When an asset was last used; one that was never read counts from its creation. */
const lastUsedSql = sql`coalesce(${asset.lastAccessedAt}, ${asset.createdAt})`;

/**
 * For each mirror with caching enabled: deletes cache assets idle longer than `maxAgeDays`, then the
 * least recently accessed ones until the total size is at most `maxSizeBytes`. Also deletes all cache
 * assets of mirrors whose caching is disabled. Hosted assets are never touched. Rows are read and
 * deleted `batchSize` at a time, and a failing repository is logged and skipped.
 */
export async function evictCaches(deps: {
  db: Db;
  assets: AssetService;
  now?: Date;
  batchSize?: number;
}): Promise<EvictionResult> {
  const { db, assets } = deps;
  const now = deps.now ?? new Date();
  const batchSize = deps.batchSize ?? EVICTION_BATCH_SIZE;
  const result: EvictionResult = { repositories: 0, assetsDeleted: 0, bytesFreed: 0 };

  const mirrors = await db
    .select()
    .from(repository)
    .where(eq(repository.kind, "mirror"))
    .orderBy(asc(repository.name));
  for (const repo of mirrors) {
    const { cache } = readRepositoryConfig({
      name: repo.name,
      format: repo.format,
      kind: "mirror",
      config: repo.config,
    }) as MirrorConfig;
    const isCache = and(eq(asset.repositoryId, repo.id), eq(asset.origin, "cache"));
    let deleted = 0;

    /** Deletes the rows `where` selects (oldest first), batch by batch, until none is left or `stop` says so. */
    async function drain(where: SQL | undefined, stop: () => boolean = () => false): Promise<void> {
      while (!stop()) {
        const rows = await db.select(evictable).from(asset).where(where).orderBy(lastUsedSql, asc(asset.id)).limit(batchSize);
        if (rows.length === 0) return;
        for (const row of rows) {
          if (stop()) return;
          await assets.delete(row as AssetRow);
          deleted++;
          result.assetsDeleted++;
          result.bytesFreed += row.size;
          remaining -= row.size;
        }
      }
    }
    let remaining = 0;

    try {
      if (!cache.enabled) {
        await drain(isCache);
      } else {
        if (cache.maxAgeDays !== null) {
          const cutoff = new Date(now.getTime() - cache.maxAgeDays * 86_400_000);
          await drain(and(isCache, sql`${lastUsedSql} < ${cutoff.toISOString()}::timestamptz`));
        }
        if (cache.maxSizeBytes !== null) {
          const [sum] = await db
            .select({ total: sql<string>`coalesce(sum(${asset.size}), 0)` })
            .from(asset)
            .where(isCache);
          remaining = Number(sum?.total ?? 0);
          const limit = cache.maxSizeBytes;
          await drain(isCache, () => remaining <= limit);
        }
      }
    } catch (error) {
      console.warn(`weaver: failed to evict the cache of repository ${repo.name}`, error);
    }
    if (deleted > 0) result.repositories++;
  }
  return result;
}

import { sql } from "drizzle-orm";
import type { StoreId, StoreSet } from "@weaver/core";
import type { Db } from "@weaver/db";

/** How long links, blobs and uploads are kept after their last activity before garbage collection may remove them. */
export const DOCKER_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/** What one garbage collection run removed. */
export interface DockerGcResult {
  /** Blob links removed because no manifest of their image references them. */
  linksDeleted: number;
  /** Blob rows removed (their objects are deleted afterwards). */
  blobsDeleted: number;
  /** Total size of the removed blobs, in bytes. */
  bytesFreed: number;
  /** Upload rows removed after being idle for the grace period. */
  uploadsDeleted: number;
  /** Set when another run held the lock and this one did nothing. */
  skipped?: true;
}

/** What {@link runDockerGc} works with. */
export interface DockerGcDeps {
  db: Db;
  stores: StoreSet;
  /** The time the run treats as now (default: the current time); the grace period counts back from it. */
  now?: Date;
  /** Test hook: runs after the link step committed and before the blob step starts. */
  beforeBlobDelete?: () => Promise<void>;
}

/** The rows of a raw query result. */
function rowsOf<T>(result: { rows?: unknown[] } | unknown[]): T[] {
  return (Array.isArray(result) ? result : (result.rows ?? [])) as T[];
}

/** A link no manifest of its repository/image references, created before `cutoff` (alias `l`). */
const staleLink = (cutoff: Date) => sql`
  l.created_at < ${cutoff}
  AND NOT EXISTS (
    SELECT 1 FROM docker_manifest_ref r
    JOIN docker_manifest m ON m.id = r.manifest_id
    WHERE m.repository_id = l.repository_id AND m.image = l.image AND r.digest = l.digest AND r.kind = 'blob'
  )`;

/** A blob with no link, referenced by no manifest, last linked before `cutoff` (alias `b`). */
const unusedBlob = (cutoff: Date) => sql`
  b.last_linked_at < ${cutoff}
  AND NOT EXISTS (SELECT 1 FROM docker_blob_link l WHERE l.blob_id = b.id)
  AND NOT EXISTS (SELECT 1 FROM docker_manifest_ref r WHERE r.digest = b.digest AND r.kind = 'blob')`;

/** Step 2 in one transaction: locks the stale links (skipping locked ones), then deletes those still stale. */
function deleteStaleLinks(db: Db, cutoff: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const keys = rowsOf<{ repository_id: string; image: string; digest: string }>(
      await tx.execute(sql`
        SELECT l.repository_id, l.image, l.digest FROM docker_blob_link l
        WHERE ${staleLink(cutoff)}
        FOR UPDATE OF l SKIP LOCKED`),
    );
    if (keys.length === 0) return 0;
    const deleted = await tx.execute(sql`
      DELETE FROM docker_blob_link l
      USING unnest(${sql.param(keys.map((k) => k.repository_id))}::uuid[], ${sql.param(keys.map((k) => k.image))}::text[],
        ${sql.param(keys.map((k) => k.digest))}::text[]) AS k(repository_id, image, digest)
      WHERE l.repository_id = k.repository_id AND l.image = k.image AND l.digest = k.digest AND ${staleLink(cutoff)}
      RETURNING l.digest`);
    return rowsOf(deleted).length;
  });
}

/** Step 3 in one transaction: locks the unused blobs (skipping locked ones), then deletes those still unused. */
function deleteUnusedBlobs(db: Db, cutoff: Date): Promise<Array<{ store: StoreId; storage_key: string; size: string | number }>> {
  return db.transaction(async (tx) => {
    const ids = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT b.id FROM docker_blob b WHERE ${unusedBlob(cutoff)} FOR UPDATE OF b SKIP LOCKED`),
    ).map((r) => r.id);
    if (ids.length === 0) return [];
    return rowsOf(
      await tx.execute(sql`
        DELETE FROM docker_blob b
        WHERE b.id = ANY(${sql.param(ids)}::uuid[]) AND ${unusedBlob(cutoff)}
        RETURNING b.store, b.storage_key, b.size`),
    );
  });
}

/** Deletes the objects of removed blobs per store; a failing store is logged and leaves orphaned objects only. */
async function deleteObjects(stores: StoreSet, blobs: Array<{ store: StoreId; storage_key: string }>): Promise<void> {
  const byStore = new Map<StoreId, string[]>();
  for (const b of blobs) byStore.set(b.store, [...(byStore.get(b.store) ?? []), b.storage_key]);
  for (const [id, keys] of byStore) {
    const store = stores.get(id);
    if (!store) {
      console.warn(`weaver: docker gc left ${keys.length} object(s) in unconfigured store ${id}`);
      continue;
    }
    try {
      await store.deleteMany(keys);
    } catch (err) {
      console.warn(`weaver: docker gc could not delete ${keys.length} object(s) from store ${id}; they stay as orphans`, err);
    }
  }
}

/**
 * Garbage-collects docker storage: 1) deletes upload rows idle longer than {@link DOCKER_GC_GRACE_MS};
 * 2) deletes blob links older than the grace period whose digest no manifest of the same repository/image
 * references (config, layers, and so the layers of an index's child manifests, which are manifests themselves);
 * 3) deletes blob rows with no link left, referenced by no manifest anywhere and last linked before the grace
 * period, then their objects. Steps 2 and 3 each run in one transaction that locks the candidates with
 * `FOR UPDATE SKIP LOCKED` and re-checks the conditions when deleting, so a concurrent link, mount or manifest
 * push (which touch the same rows) either wins and keeps the blob or fails cleanly. Objects are deleted only
 * after the rows are gone, so a crash leaves orphaned objects but never rows pointing at missing bytes.
 * The whole run holds a Postgres advisory lock; when another run holds it, nothing is done and `skipped` is set.
 * Manifests are never deleted here.
 */
export async function runDockerGc(deps: DockerGcDeps): Promise<DockerGcResult> {
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - DOCKER_GC_GRACE_MS);
  // Session-level lock on a dedicated connection, released on the same one.
  const lockClient = await deps.db.$client.connect();
  try {
    const locked = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('weaver-docker-gc', 0)) AS ok");
    if (!locked.rows[0]?.ok) return { linksDeleted: 0, blobsDeleted: 0, bytesFreed: 0, uploadsDeleted: 0, skipped: true };
    try {
      const uploads = rowsOf(await deps.db.execute(sql`DELETE FROM docker_upload WHERE updated_at < ${cutoff} RETURNING id`));
      const linksDeleted = await deleteStaleLinks(deps.db, cutoff);
      await deps.beforeBlobDelete?.();
      const blobs = await deleteUnusedBlobs(deps.db, cutoff);
      await deleteObjects(deps.stores, blobs);
      return {
        linksDeleted,
        blobsDeleted: blobs.length,
        bytesFreed: blobs.reduce((sum, b) => sum + Number(b.size), 0),
        uploadsDeleted: uploads.length,
      };
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended('weaver-docker-gc', 0))");
    }
  } finally {
    lockClient.release();
  }
}

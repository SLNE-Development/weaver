import { eq, inArray, lt, sql } from "drizzle-orm";
import {
  asset,
  protoArtifact,
  protoBuild,
  protoVersion,
  storageSnapshot,
  type Db,
} from "@weaver/db";
import type { Format, Repo, RepoService } from "../repos/index.js";

/** Advisory lock key held by {@link rollupUsage} so overlapping runs skip instead of racing. */
const STATS_LOCK_KEY = 727002;
const DAY_MS = 86_400_000;

/** Raw usage events older than this many days are deleted once their day is rolled up. */
export const USAGE_RETENTION_DAYS = 90;

/** Storage snapshots older than this many days are deleted. */
export const STORAGE_SNAPSHOT_RETENTION_DAYS = 400;

/** Raw usage events deleted per statement by the retention sweep. */
const EVENT_DELETE_BATCH = 10_000;

/** What one rollup run did: UTC days recomputed, raw events deleted by retention, and repositories measured. */
export interface RollupResult {
  daysRolled: number;
  eventsDeleted: number;
  repositoriesMeasured: number;
}

/**
 * Measures a repository's stored bytes in a format-specific way, for formats whose content does not live
 * (only) in `asset`. Returns null to use the generic asset sum instead.
 */
export type StorageProbe = (repo: Repo) => Promise<{ hostedBytes: number; cacheBytes: number } | null>;

/** The "YYYY-MM-DD" UTC day of `d`. */
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The UTC day `days` after `day` ("YYYY-MM-DD"). */
const addDays = (day: string, days: number): string => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

/**
 * The namespace and name of an event's package: its component's when it has one, otherwise derived from the
 * path by the repository's format (mirror misses and bypasses, and Docker, record no component), otherwise ''.
 * Maven `g/r/o/u/p/artifact/version/artifact-...` → (`g.r.o.u.p`, `artifact`); npm `[@scope/]name/-/file` →
 * (`scope`, `name`), matching the npm component convention; Docker `[v2/]image/(blobs|manifests)/ref` → ('', `image`).
 */
const packageKeySql = sql`
  CROSS JOIN LATERAL (SELECT string_to_array(e.path, '/') AS seg) s
  CROSS JOIN LATERAL (SELECT cardinality(s.seg) AS n, split_part(e.path, '/-/', 1) AS npm_full,
                             substring(e.path from '^(?:v2/)?(.+)/(?:blobs|manifests)/[^/]+$') AS docker_image) p
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN c.id IS NOT NULL THEN c.namespace
        WHEN r.format = 'maven' AND p.n >= 4 AND starts_with(s.seg[p.n], s.seg[p.n - 2] || '-')
          THEN array_to_string(s.seg[1:p.n - 3], '.')
        WHEN r.format = 'npm' AND position('/-/' in e.path) > 0 AND p.npm_full LIKE '@%/%'
          THEN substr(split_part(p.npm_full, '/', 1), 2)
        ELSE ''
      END AS namespace,
      CASE
        WHEN c.id IS NOT NULL THEN c.name
        WHEN r.format = 'maven' AND p.n >= 4 AND starts_with(s.seg[p.n], s.seg[p.n - 2] || '-') THEN s.seg[p.n - 2]
        WHEN r.format = 'npm' AND position('/-/' in e.path) > 0 AND p.npm_full LIKE '@%/%' THEN split_part(p.npm_full, '/', 2)
        WHEN r.format = 'npm' AND position('/-/' in e.path) > 0 THEN p.npm_full
        WHEN r.format = 'docker' AND p.docker_image IS NOT NULL THEN p.docker_image
        ELSE ''
      END AS name
  ) k`;

/** Recomputes `usage_daily` and `usage_daily_token` of one UTC day from the raw events, in one transaction. */
async function rollDay(db: Db, day: string): Promise<void> {
  const inDay = sql`e.at >= (${day}::date)::timestamp AT TIME ZONE 'UTC' AND e.at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM usage_daily WHERE day = ${day}::date`);
    await tx.execute(sql`DELETE FROM usage_daily_token WHERE day = ${day}::date`);
    await tx.execute(sql`
      INSERT INTO usage_daily (day, repository_id, namespace, name, action, count, bytes, cache_hit, cache_miss, cache_stale, cache_bypass)
      SELECT ${day}::date, e.repository_id, k.namespace, k.name, e.action, count(*), coalesce(sum(e.bytes), 0),
             count(*) FILTER (WHERE e.cache = 'hit'), count(*) FILTER (WHERE e.cache = 'miss'),
             count(*) FILTER (WHERE e.cache = 'stale'), count(*) FILTER (WHERE e.cache = 'bypass')
      FROM usage_event e
      JOIN repository r ON r.id = e.repository_id
      LEFT JOIN component c ON c.id = e.component_id
      ${packageKeySql}
      WHERE ${inDay}
      GROUP BY e.repository_id, k.namespace, k.name, e.action`);
    await tx.execute(sql`
      INSERT INTO usage_daily_token (day, api_key_id, user_id, repository_id, action, count, bytes)
      SELECT ${day}::date, e.api_key_id, max(e.user_id), e.repository_id, e.action, count(*), coalesce(sum(e.bytes), 0)
      FROM usage_event e
      JOIN repository r ON r.id = e.repository_id
      WHERE ${inDay} AND e.api_key_id IS NOT NULL
      GROUP BY e.api_key_id, e.repository_id, e.action`);
  });
}

/** Most expiring, never rolled-up days one run rolls up before retention deletes their events. */
export const ROLLUP_MAX_EXPIRING_DAYS = 31;

/** The days one run recomputes, oldest first, and how far back retention may delete raw events afterwards. */
interface RollPlan {
  days: string[];
  /** Events before this instant are deleted: the retention cutoff, or earlier while expiring days still wait for their rollup. */
  deleteBefore: Date;
}

/**
 * Plans a run. Recent days: from the newest rolled-up day (or the oldest event, whichever is later, since days
 * without events have nothing to recompute) through `today`, but never at or before the day of the retention
 * cutoff, whose raw events may already be gone; re-rolling such a day would erase its history. That bounds
 * the range to {@link USAGE_RETENTION_DAYS} days. Expiring days: the oldest {@link ROLLUP_MAX_EXPIRING_DAYS}
 * days with events older than the cutoff and no rollup yet; when more remain, deletion stops at the first
 * day left over so it waits for a later run.
 *
 * Days before the newest rolled-up day are not recomputed, so an event recorded late on such a day is not
 * counted. Live recording stamps events with the current time, so this only affects hand-inserted rows.
 */
async function planRollup(db: Db, today: string, retentionCutoff: Date): Promise<RollPlan> {
  const [bounds] = (
    await db.execute<{ newest: string | null; oldest: string | null }>(sql`
      SELECT (SELECT max(day)::text FROM usage_daily) AS newest,
             (SELECT (min(at) AT TIME ZONE 'UTC')::date::text FROM usage_event WHERE repository_id IS NOT NULL) AS oldest`)
  ).rows;
  const newest = bounds?.newest ?? null;
  const oldest = bounds?.oldest ?? null;
  const days = new Set<string>();
  if (oldest !== null) {
    const base = newest === null || oldest > newest ? oldest : newest;
    const firstAfterCutoff = addDays(utcDay(retentionCutoff), 1);
    for (let d = base > firstAfterCutoff ? base : firstAfterCutoff; d <= today; d = addDays(d, 1)) days.add(d);
  }
  const expiring = (
    await db.execute<{ day: string }>(sql`
      SELECT DISTINCT (e.at AT TIME ZONE 'UTC')::date::text AS day
      FROM usage_event e
      WHERE e.at < ${retentionCutoff.toISOString()}::timestamptz AND e.repository_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM usage_daily d WHERE d.day = (e.at AT TIME ZONE 'UTC')::date)
      ORDER BY day
      LIMIT ${ROLLUP_MAX_EXPIRING_DAYS + 1}`)
  ).rows.map((r) => r.day);
  for (const day of expiring.slice(0, ROLLUP_MAX_EXPIRING_DAYS)) days.add(day);
  const leftover = expiring[ROLLUP_MAX_EXPIRING_DAYS];
  const deleteBefore = leftover === undefined ? retentionCutoff : new Date(`${leftover}T00:00:00Z`);
  return { days: [...days].sort(), deleteBefore };
}

/** Generic stored bytes and file counts per repository id: assets by origin, plus proto build archives as hosted. */
async function genericStorage(db: Db, ids: string[]): Promise<Map<string, { hostedBytes: number; cacheBytes: number; assetCount: number }>> {
  const out = new Map<string, { hostedBytes: number; cacheBytes: number; assetCount: number }>();
  if (ids.length === 0) return out;
  const entry = (id: string) => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { hostedBytes: 0, cacheBytes: 0, assetCount: 0 }));
    return e;
  };
  const assets = await db
    .select({
      repositoryId: asset.repositoryId,
      origin: asset.origin,
      files: sql<string>`count(*)`,
      bytes: sql<string>`coalesce(sum(${asset.size}), 0)`,
    })
    .from(asset)
    .where(inArray(asset.repositoryId, ids))
    .groupBy(asset.repositoryId, asset.origin);
  for (const row of assets) {
    const e = entry(row.repositoryId);
    e.assetCount += Number(row.files);
    if (row.origin === "cache") e.cacheBytes += Number(row.bytes);
    else e.hostedBytes += Number(row.bytes);
  }
  const builds = await db
    .select({
      repositoryId: protoArtifact.repositoryId,
      files: sql<string>`count(*)`,
      bytes: sql<string>`coalesce(sum(${protoBuild.sizeBytes}), 0)`,
    })
    .from(protoBuild)
    .innerJoin(protoVersion, eq(protoVersion.id, protoBuild.versionId))
    .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
    .where(inArray(protoArtifact.repositoryId, ids))
    .groupBy(protoArtifact.repositoryId);
  for (const row of builds) {
    const e = entry(row.repositoryId);
    e.assetCount += Number(row.files);
    e.hostedBytes += Number(row.bytes);
  }
  return out;
}

/** Upserts today's storage snapshot of every hosted and mirror repository and returns how many were measured. */
async function snapshotStorage(
  deps: { db: Db; repos: Pick<RepoService, "list">; storageProbes?: Partial<Record<Format, StorageProbe>> },
  today: string,
  now: Date,
): Promise<number> {
  const repos = (await deps.repos.list()).filter((r) => r.kind !== "group");
  const generic = await genericStorage(
    deps.db,
    repos.map((r) => r.id),
  );
  let measured = 0;
  for (const repo of repos) {
    const base = generic.get(repo.id) ?? { hostedBytes: 0, cacheBytes: 0, assetCount: 0 };
    let bytes: { hostedBytes: number; cacheBytes: number } | null = null;
    const probe = deps.storageProbes?.[repo.format];
    if (probe) {
      try {
        bytes = await probe(repo);
      } catch (error) {
        console.warn(`weaver: measuring the storage of repository ${repo.name} failed; using the asset sum`, error);
      }
    }
    const values = { hostedBytes: bytes?.hostedBytes ?? base.hostedBytes, cacheBytes: bytes?.cacheBytes ?? base.cacheBytes, assetCount: base.assetCount, takenAt: now };
    await deps.db
      .insert(storageSnapshot)
      .values({ day: today, repositoryId: repo.id, ...values })
      .onConflictDoUpdate({ target: [storageSnapshot.day, storageSnapshot.repositoryId], set: values });
    measured++;
  }
  return measured;
}

/** Deletes raw events older than `cutoff` in batches of {@link EVENT_DELETE_BATCH} and returns how many went. */
async function deleteOldEvents(db: Db, cutoff: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM usage_event WHERE id IN (
        SELECT id FROM usage_event WHERE at < ${cutoff.toISOString()}::timestamptz LIMIT ${EVENT_DELETE_BATCH})`);
    const n = result.rowCount ?? 0;
    deleted += n;
    if (n < EVENT_DELETE_BATCH) return deleted;
  }
}

/**
 * Under advisory lock 727002: recomputes usage_daily and usage_daily_token for every UTC day from the newest
 * rolled-up day (or the oldest event) through today, never at or before the retention cutoff's day, upserts
 * today's storage_snapshot per repo, then deletes events older than 90 days (batches of 10 000) and snapshots
 * older than 400 days. Expiring events of a day that has no rollup yet are rolled up before they are deleted,
 * at most {@link ROLLUP_MAX_EXPIRING_DAYS} such days per run. See {@link planRollup} for late events. Returns all zeros at once when another run
 * holds the lock. Group repositories store nothing and get no snapshot.
 */
export async function rollupUsage(
  deps: { db: Db; repos: Pick<RepoService, "list">; storageProbes?: Partial<Record<Format, StorageProbe>> },
  now: Date = new Date(),
): Promise<RollupResult> {
  const { db } = deps;
  const lockClient = await db.$client.connect();
  // Set when unlocking fails: releasing with it destroys the connection, which drops the session lock.
  let unlockError: Error | undefined;
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [STATS_LOCK_KEY]);
    if (!rows[0]?.locked) return { daysRolled: 0, eventsDeleted: 0, repositoriesMeasured: 0 };
    try {
      const today = utcDay(now);
      const retentionCutoff = new Date(now.getTime() - USAGE_RETENTION_DAYS * DAY_MS);
      const { days, deleteBefore } = await planRollup(db, today, retentionCutoff);
      for (const day of days) await rollDay(db, day);
      const repositoriesMeasured = await snapshotStorage(deps, today, now);
      const eventsDeleted = await deleteOldEvents(db, deleteBefore);
      await db.delete(storageSnapshot).where(lt(storageSnapshot.day, addDays(today, -STORAGE_SNAPSHOT_RETENTION_DAYS)));
      return { daysRolled: days.length, eventsDeleted, repositoriesMeasured };
    } finally {
      try {
        await lockClient.query("select pg_advisory_unlock($1)", [STATS_LOCK_KEY]);
      } catch (error) {
        unlockError = error instanceof Error ? error : new Error(String(error));
        console.warn("weaver: releasing the stats lock failed; discarding its connection", unlockError);
      }
    }
  } finally {
    lockClient.release(unlockError);
  }
}

/**
 * A {@link StorageProbe} for Docker: the logical bytes of a hosted repository are each blob linked into it,
 * counted once per digest at its stored size, plus its manifests. Mirrors (whose cache is assets) and groups
 * get null, so the generic asset sum applies.
 */
export function dockerStorageBytes(db: Db): StorageProbe {
  return async (repo) => {
    if (repo.kind !== "hosted") return null;
    const { rows } = await db.execute<{ blobs: string; manifests: string }>(sql`
      SELECT
        (SELECT coalesce(sum(size), 0) FROM (
           SELECT DISTINCT ON (b.digest) b.size
           FROM docker_blob_link l JOIN docker_blob b ON b.id = l.blob_id
           WHERE l.repository_id = ${repo.id}
           ORDER BY b.digest, b.size DESC) linked) AS blobs,
        (SELECT coalesce(sum(size), 0) FROM docker_manifest WHERE repository_id = ${repo.id}) AS manifests`);
    return { hostedBytes: Number(rows[0]?.blobs ?? 0) + Number(rows[0]?.manifests ?? 0), cacheBytes: 0 };
  };
}

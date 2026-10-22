import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@weaver/db";
import type { Format } from "../repos/index.js";

/** An inclusive range of UTC days, both ends as "YYYY-MM-DD". */
export interface DayRange {
  from: string;
  to: string;
}

/** One day of a usage series: download and upload counts, and the bytes they moved. */
export interface SeriesPoint {
  day: string;
  downloads: number;
  uploads: number;
  bytes: number;
}

/** How a package is written in each format: `group:name` (Maven, proto), `@scope/name` or `name` (npm), `image` (Docker). */
export function packageLabel(format: Format, namespace: string, name: string): string {
  if (namespace === "") return name;
  switch (format) {
    case "npm":
      return `${namespace.startsWith("@") ? namespace : `@${namespace}`}/${name}`;
    case "docker":
      return `${namespace}/${name}`;
    default:
      return `${namespace}:${name}`;
  }
}

/** `AND <column> = ANY(ids)` for a repository filter, nothing when `ids` is undefined. */
function inRepos(column: SQL, ids: string[] | undefined): SQL {
  if (ids === undefined) return sql``;
  return sql` AND ${column} = ANY(${toUuidArray(ids)})`;
}

/** A `uuid[]` literal of `ids`, bound as one parameter. */
function toUuidArray(ids: string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

const inRange = (column: SQL, range: DayRange): SQL => sql`${column} BETWEEN ${range.from}::date AND ${range.to}::date`;

/** Zero-filled per-day sums of `table` (usage_daily or usage_daily_token) for rows matching `where`. */
async function series(db: Db, table: SQL, range: DayRange, where: SQL): Promise<SeriesPoint[]> {
  const { rows } = await db.execute<{ day: string; downloads: string; uploads: string; bytes: string }>(sql`
    SELECT g.day::date::text AS day,
           coalesce(sum(u.count) FILTER (WHERE u.action = 'download'), 0) AS downloads,
           coalesce(sum(u.count) FILTER (WHERE u.action = 'upload'), 0) AS uploads,
           coalesce(sum(u.bytes) FILTER (WHERE u.action IN ('download', 'upload')), 0) AS bytes
    FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS g(day)
    LEFT JOIN ${table} u ON u.day = g.day::date ${where}
    GROUP BY g.day
    ORDER BY g.day`);
  return rows.map((r) => ({ day: r.day, downloads: Number(r.downloads), uploads: Number(r.uploads), bytes: Number(r.bytes) }));
}

/** Downloads, uploads and bytes per day of the range (all repositories, or only `repositoryIds`), one point per day, zero-filled. */
export function downloadsSeries(db: Db, range: DayRange, repositoryIds?: string[]): Promise<SeriesPoint[]> {
  return series(db, sql`usage_daily`, range, inRepos(sql`u.repository_id`, repositoryIds));
}

/** The most downloaded packages in the range, most first; usage that no package could be attributed to (name '') is left out. */
export async function topPackages(
  db: Db,
  range: DayRange,
  opts: { repositoryIds?: string[]; limit: number },
): Promise<Array<{ repositoryId: string; namespace: string; name: string; downloads: number }>> {
  const { rows } = await db.execute<{ repository_id: string; namespace: string; name: string; downloads: string }>(sql`
    SELECT repository_id, namespace, name, sum(count) AS downloads
    FROM usage_daily
    WHERE action = 'download' AND name <> '' AND ${inRange(sql`day`, range)}${inRepos(sql`repository_id`, opts.repositoryIds)}
    GROUP BY repository_id, namespace, name
    ORDER BY downloads DESC, namespace, name, repository_id
    LIMIT ${opts.limit}`);
  return rows.map((r) => ({ repositoryId: r.repository_id, namespace: r.namespace, name: r.name, downloads: Number(r.downloads) }));
}

/** The newest storage snapshot of each repository (all, or only `repositoryIds`) that has one. */
export async function latestStorage(
  db: Db,
  repositoryIds?: string[],
): Promise<Array<{ repositoryId: string; hostedBytes: number; cacheBytes: number; assetCount: number; takenAt: Date }>> {
  const { rows } = await db.execute<{ repository_id: string; hosted_bytes: string; cache_bytes: string; asset_count: string; taken_at: string | Date }>(sql`
    SELECT DISTINCT ON (repository_id) repository_id, hosted_bytes, cache_bytes, asset_count, taken_at
    FROM storage_snapshot
    WHERE true${inRepos(sql`repository_id`, repositoryIds)}
    ORDER BY repository_id, day DESC`);
  return rows.map((r) => ({
    repositoryId: r.repository_id,
    hostedBytes: Number(r.hosted_bytes),
    cacheBytes: Number(r.cache_bytes),
    assetCount: Number(r.asset_count),
    takenAt: new Date(r.taken_at),
  }));
}

/** The share of cache lookups served from the cache: stale serves count as hits, bypasses are not lookups. Null without any lookup. */
export function hitRateOf(c: { hits: number; stale: number; misses: number }): number | null {
  const lookups = c.hits + c.stale + c.misses;
  return lookups === 0 ? null : (c.hits + c.stale) / lookups;
}

/** Cache results per repository with usage in the range (all, or only `repositoryIds`), with {@link hitRateOf}. */
export async function cacheHitRates(
  db: Db,
  range: DayRange,
  repositoryIds?: string[],
): Promise<Array<{ repositoryId: string; hits: number; stale: number; misses: number; bypass: number; hitRate: number | null }>> {
  const { rows } = await db.execute<{ repository_id: string; hits: string; stale: string; misses: string; bypass: string }>(sql`
    SELECT repository_id, sum(cache_hit) AS hits, sum(cache_stale) AS stale, sum(cache_miss) AS misses, sum(cache_bypass) AS bypass
    FROM usage_daily
    WHERE ${inRange(sql`day`, range)}${inRepos(sql`repository_id`, repositoryIds)}
    GROUP BY repository_id
    ORDER BY repository_id`);
  return rows.map((r) => {
    const counts = { hits: Number(r.hits), stale: Number(r.stale), misses: Number(r.misses), bypass: Number(r.bypass) };
    return { repositoryId: r.repository_id, ...counts, hitRate: hitRateOf(counts) };
  });
}

/** Per API key: downloads, uploads and deletes in the range and the last active day, most recently active first. */
export async function tokenSummaries(
  db: Db,
  range: DayRange,
  limit: number,
): Promise<Array<{ apiKeyId: string; userId: string | null; downloads: number; uploads: number; deletes: number; lastDay: string }>> {
  const { rows } = await db.execute<{
    api_key_id: string;
    user_id: string | null;
    downloads: string;
    uploads: string;
    deletes: string;
    last_day: string;
  }>(sql`
    SELECT api_key_id, max(user_id) AS user_id,
           coalesce(sum(count) FILTER (WHERE action = 'download'), 0) AS downloads,
           coalesce(sum(count) FILTER (WHERE action = 'upload'), 0) AS uploads,
           coalesce(sum(count) FILTER (WHERE action = 'delete'), 0) AS deletes,
           max(day)::text AS last_day
    FROM usage_daily_token
    WHERE ${inRange(sql`day`, range)}
    GROUP BY api_key_id
    ORDER BY last_day DESC, sum(count) DESC, api_key_id
    LIMIT ${limit}`);
  return rows.map((r) => ({
    apiKeyId: r.api_key_id,
    userId: r.user_id,
    downloads: Number(r.downloads),
    uploads: Number(r.uploads),
    deletes: Number(r.deletes),
    lastDay: r.last_day,
  }));
}

/** Downloads, uploads and bytes of one API key per day of the range, zero-filled. */
export function tokenSeries(db: Db, apiKeyId: string, range: DayRange): Promise<SeriesPoint[]> {
  return series(db, sql`usage_daily_token`, range, sql` AND u.api_key_id = ${apiKeyId}`);
}

/**
 * The raw usage events of one API key, newest first by time (then id), `limit` at a time; `before` (an event id)
 * continues after that event, keyset on (at, id) so the (api_key_id, at) index serves it. A `before` event that
 * retention already deleted ends the listing.
 * `repository` is null once the repository was deleted, `label` null when the event has no component.
 */
export async function tokenEvents(
  db: Db,
  apiKeyId: string,
  opts: { before?: number; limit: number },
): Promise<
  Array<{ id: number; at: Date; action: "download" | "upload" | "delete"; repository: string | null; label: string | null; path: string; bytes: number }>
> {
  const { rows } = await db.execute<{
    id: string;
    at: string | Date;
    action: "download" | "upload" | "delete";
    repository: string | null;
    format: Format | null;
    namespace: string | null;
    name: string | null;
    path: string;
    bytes: string;
  }>(sql`
    SELECT e.id, e.at, e.action, r.name AS repository, r.format, c.namespace, c.name, e.path, e.bytes
    FROM usage_event e
    LEFT JOIN repository r ON r.id = e.repository_id
    LEFT JOIN component c ON c.id = e.component_id
    WHERE e.api_key_id = ${apiKeyId}${
      opts.before === undefined ? sql`` : sql` AND (e.at, e.id) < (SELECT b.at, b.id FROM usage_event b WHERE b.id = ${opts.before})`
    }
    ORDER BY e.at DESC, e.id DESC
    LIMIT ${opts.limit}`);
  return rows.map((r) => ({
    id: Number(r.id),
    at: new Date(r.at),
    action: r.action,
    repository: r.repository,
    label: r.name !== null && r.format !== null ? packageLabel(r.format, r.namespace ?? "", r.name) : null,
    path: r.path,
    bytes: Number(r.bytes),
  }));
}

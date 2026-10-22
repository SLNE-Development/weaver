import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  cacheHitRates,
  canAccess,
  canReadThroughGroup,
  downloadsSeries,
  hitRateOf,
  latestStorage,
  packageLabel,
  tokenEvents,
  tokenSeries,
  tokenSummaries,
  topPackages,
  type DayRange,
  type Format,
  type Kind,
  type Repo,
  type SeriesPoint,
} from "@weaver/core";
import { apikey, user, type Db } from "@weaver/db";
import { adminProcedure, authedProcedure, browseProcedure, router } from "../init";
import { notFound, repositoryName } from "../helpers";

/** Name shown for a key whose row no longer exists; its usage history outlives it. */
export const DELETED_KEY_NAME = "Deleted key";

/** The lengths of history the stats views offer, in days. */
const daysInput = z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]).default(30);

/** The last `days` UTC days through today. */
function rangeOf(days: number, now: Date = new Date()): DayRange {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return { from: day(new Date(now.getTime() - (days - 1) * 86_400_000)), to: day(now) };
}

/** One of the most downloaded packages, with its repository's name and its format's label. */
export interface TopPackage {
  repositoryId: string;
  repository: string;
  namespace: string;
  name: string;
  label: string;
  downloads: number;
}

/** The latest measured storage of one repository; zeros and a null `takenAt` before the first measurement. */
export interface RepositoryStorage {
  repositoryId: string;
  repository: string;
  format: Format;
  kind: Kind;
  hostedBytes: number;
  cacheBytes: number;
  assetCount: number;
  takenAt: Date | null;
}

/** The cache results of one mirror over the range. */
export interface MirrorHitRate {
  repositoryId: string;
  repository: string;
  hits: number;
  stale: number;
  misses: number;
  bypass: number;
  hitRate: number | null;
}

/** One API key's activity over the range, with its name (or {@link DELETED_KEY_NAME}) and its owner's name. */
export interface TokenSummary {
  apiKeyId: string;
  keyName: string;
  userId: string | null;
  ownerName: string | null;
  downloads: number;
  uploads: number;
  deletes: number;
  lastDay: string;
}

/** Everything the admin stats page shows. */
export interface StatsOverview {
  series: SeriesPoint[];
  topPackages: TopPackage[];
  storage: RepositoryStorage[];
  hitRates: MirrorHitRate[];
  tokens: TokenSummary[];
}

/** The stats of one repository, or of a group's members together. */
export interface RepositoryStats {
  series: SeriesPoint[];
  topPackages: TopPackage[];
  /** Summed over a group's members; null before the first measurement. */
  storage: { hostedBytes: number; cacheBytes: number; assetCount: number; takenAt: Date } | null;
  /** Over the mirror (a group's mirror members); null for hosted repositories and without cache lookups. */
  hitRate: number | null;
}

/** Top packages with the repository name and label added; packages of repositories not in `byId` are dropped. */
async function labelled(db: Db, range: DayRange, byId: Map<string, Repo>, ids: string[] | undefined, limit: number): Promise<TopPackage[]> {
  const rows = await topPackages(db, range, { repositoryIds: ids, limit });
  return rows.flatMap((row) => {
    const repo = byId.get(row.repositoryId);
    if (!repo) return [];
    return [{ ...row, repository: repo.name, label: packageLabel(repo.format, row.namespace, row.name) }];
  });
}

/** Key names and owner names for `summaries`. */
async function namedTokens(db: Db, summaries: Awaited<ReturnType<typeof tokenSummaries>>): Promise<TokenSummary[]> {
  const keyIds = summaries.map((s) => s.apiKeyId);
  const userIds = [...new Set(summaries.flatMap((s) => (s.userId ? [s.userId] : [])))];
  const [keys, users] = await Promise.all([
    keyIds.length === 0 ? [] : db.select({ id: apikey.id, name: apikey.name }).from(apikey).where(inArray(apikey.id, keyIds)),
    userIds.length === 0 ? [] : db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds)),
  ]);
  const keyName = new Map(keys.map((k) => [k.id, k.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  return summaries.map((s) => ({
    ...s,
    keyName: keyName.has(s.apiKeyId) ? (keyName.get(s.apiKeyId) ?? "") : DELETED_KEY_NAME,
    ownerName: s.userId ? (userName.get(s.userId) ?? null) : null,
  }));
}

export const statsRouter = router({
  /** Admins: downloads over time, the 20 most downloaded packages, storage per repository, mirror hit rates and the 20 most active keys. */
  overview: adminProcedure.input(z.object({ days: daysInput }).default({ days: 30 })).query(async ({ ctx, input }): Promise<StatsOverview> => {
    const range = rangeOf(input.days);
    const all = await ctx.repos.list();
    const byId = new Map(all.map((r) => [r.id, r]));
    const [series, top, storage, rates, tokens] = await Promise.all([
      downloadsSeries(ctx.db, range),
      labelled(ctx.db, range, byId, undefined, 20),
      latestStorage(ctx.db),
      cacheHitRates(ctx.db, range),
      tokenSummaries(ctx.db, range, 20).then((rows) => namedTokens(ctx.db, rows)),
    ]);
    const storageById = new Map(storage.map((s) => [s.repositoryId, s]));
    const ratesById = new Map(rates.map((r) => [r.repositoryId, r]));
    return {
      series,
      topPackages: top,
      storage: all
        .filter((r) => r.kind !== "group")
        .map((r) => {
          const s = storageById.get(r.id);
          return {
            repositoryId: r.id,
            repository: r.name,
            format: r.format,
            kind: r.kind,
            hostedBytes: s?.hostedBytes ?? 0,
            cacheBytes: s?.cacheBytes ?? 0,
            assetCount: s?.assetCount ?? 0,
            takenAt: s?.takenAt ?? null,
          };
        }),
      hitRates: all
        .filter((r) => r.kind === "mirror")
        .map((r) => {
          const rate = ratesById.get(r.id) ?? { hits: 0, stale: 0, misses: 0, bypass: 0, hitRate: null };
          return { ...rate, repositoryId: r.id, repository: r.name };
        }),
      tokens,
    };
  }),

  /**
   * The stats of one repository the caller may read (`NOT_FOUND` otherwise, as for a missing one): downloads over time,
   * its 10 most downloaded packages, its latest storage and its cache hit rate. A group reports its members together.
   */
  repository: browseProcedure
    .input(z.object({ repository: repositoryName, days: daysInput }))
    .query(async ({ ctx, input }): Promise<RepositoryStats> => {
      const repo = await ctx.repos.get(input.repository);
      const readable = repo && (repo.kind === "group" ? canReadThroughGroup(ctx.principal, repo) : canAccess(ctx.principal, repo, "", "read"));
      if (!repo || !readable) throw notFound(`Repository ${input.repository} was not found`);
      const sources = repo.kind === "group" ? await ctx.repos.members(repo.id) : [repo];
      const ids = sources.map((r) => r.id);
      const byId = new Map(sources.map((r) => [r.id, r]));
      const mirrorIds = sources.filter((r) => r.kind === "mirror").map((r) => r.id);
      const range = rangeOf(input.days);
      const [series, top, storage, rates] = await Promise.all([
        downloadsSeries(ctx.db, range, ids),
        labelled(ctx.db, range, byId, ids, 10),
        latestStorage(ctx.db, ids),
        mirrorIds.length === 0 ? Promise.resolve([]) : cacheHitRates(ctx.db, range, mirrorIds),
      ]);
      const totals = rates.reduce((sum, r) => ({ hits: sum.hits + r.hits, stale: sum.stale + r.stale, misses: sum.misses + r.misses }), {
        hits: 0,
        stale: 0,
        misses: 0,
      });
      return {
        series,
        topPackages: top,
        storage:
          storage.length === 0
            ? null
            : storage.reduce<NonNullable<RepositoryStats["storage"]>>(
                (sum, s) => ({
                  hostedBytes: sum.hostedBytes + s.hostedBytes,
                  cacheBytes: sum.cacheBytes + s.cacheBytes,
                  assetCount: sum.assetCount + s.assetCount,
                  takenAt: s.takenAt > sum.takenAt ? s.takenAt : sum.takenAt,
                }),
                { hostedBytes: 0, cacheBytes: 0, assetCount: 0, takenAt: new Date(0) },
              ),
        hitRate: hitRateOf(totals),
      };
    }),

  /**
   * One API key's activity: downloads and uploads per day and its raw events, newest first, `limit` at a time
   * (`nextBefore` continues). Only the key's owner and admins see it; everyone else gets `NOT_FOUND`.
   * Admins also see the history of deleted keys.
   */
  tokenActivity: authedProcedure
    .input(
      z.object({
        keyId: z.string().min(1).max(200),
        days: daysInput,
        before: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [key] = await ctx.db
        .select({ id: apikey.id, name: apikey.name, owner: apikey.referenceId })
        .from(apikey)
        .where(eq(apikey.id, input.keyId));
      const isAdmin = ctx.principal.role === "admin";
      if (!isAdmin && key?.owner !== ctx.principal.userId) throw notFound(`Key ${input.keyId} was not found`);
      const [series, rows] = await Promise.all([
        tokenSeries(ctx.db, input.keyId, rangeOf(input.days)),
        tokenEvents(ctx.db, input.keyId, { before: input.before, limit: input.limit + 1 }),
      ]);
      const events = rows.slice(0, input.limit);
      return {
        key: { id: input.keyId, name: key ? (key.name ?? "") : DELETED_KEY_NAME },
        series,
        events,
        nextBefore: rows.length > input.limit ? events.at(-1)!.id : null,
      };
    }),
});

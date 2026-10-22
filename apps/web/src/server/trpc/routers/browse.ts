import { TRPCError } from "@trpc/server";
import { and, asc, count, countDistinct, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { compareVersions, isValidGroup, isValidName, parseCoordinate, type Format, type Kind, type Principal, type RepositoryConfig } from "@weaver/core";
import { asset, protoArtifact, protoVersion, repository, type Db } from "@weaver/db";
import { browseProcedure, router } from "../init";
import {
  browsableRepositories,
  canBrowseRepository,
  canReadGroup,
  coordinateString,
  coordinateText,
  escapeLike,
  notFound,
  repositoryName,
  requireBrowsableRepository,
  type RepositoryRow,
} from "../helpers";

/** A repository as browsers see it: no config or upstreams, which only admins also receive. */
export interface BrowseRepo {
  name: string;
  format: Format;
  kind: Kind;
  description: string | null;
  visibility: "public" | "private";
  dockerRoot: boolean;
  /** Mirrors only: whether caching is on. */
  cacheEnabled: boolean | null;
  /** Admins only. */
  id?: string;
  /** Admins only. */
  config?: RepositoryConfig;
}

/** One artifact of a repository as `browse.artifacts` lists it. */
export interface ArtifactSummary {
  group: string;
  name: string;
  latestVersion: string;
  versionCount: number;
  updatedAt: Date;
}

/** Most cached archives `browse.protoCache` lists. */
export const PROTO_CACHE_LIMIT = 500;

/** One archive a proto mirror has cached, as `browse.protoCache` lists it. */
export interface ProtoCacheItem {
  /** `group:name:version`. */
  coordinate: string;
  /** The build the archive was fetched for; null when it was fetched as the newest build. */
  buildNumber: number | null;
  size: number;
  lastAccessedAt: Date | null;
  /** Releases never change once cached; snapshots are revalidated after the metadata TTL. */
  cache: "immutable" | "metadata";
}

/** What a proto mirror keeps, as `browse.protoCache` reports it. */
export interface ProtoCache {
  caching: boolean;
  /** The first upstream URL, for admins only and only while caching is off; null otherwise. */
  upstream: string | null;
  /** Cached archives, newest access first, at most {@link PROTO_CACHE_LIMIT}. */
  items: ProtoCacheItem[];
}

/** One member of a proto group as `browse.protoMembers` lists it. */
export interface ProtoMember {
  name: string;
  kind: "hosted" | "mirror";
  visibility: "public" | "private";
}

/** Whether the principal is an admin user, who alone sees mirror config such as upstream URLs. */
function isAdminUser(p: Principal): boolean {
  return p.kind === "user" && p.role === "admin";
}

/** `BAD_REQUEST` unless `repo` has the kind a procedure needs. */
function requireKind(repo: RepositoryRow, kind: Kind): void {
  if (repo.kind !== kind) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Repository ${repo.name} is a ${repo.kind} repository, not ${kind}` });
  }
}

/**
 * A browsable repository whose own content listings (artifacts, versions, files) exist: hosted
 * ones only. Mirrors and groups are `NOT_FOUND`, like hidden or missing repositories.
 */
async function requireHostedListing(db: Db, p: Principal, name: string, opts: { format?: Format } = {}): Promise<RepositoryRow> {
  const repo = await requireBrowsableRepository(db, p, name, opts);
  if (repo.kind !== "hosted") throw notFound(`Repository ${name} has no artifacts of its own to browse`);
  return repo;
}

/**
 * The coordinate and build of a cached proto archive path
 * (`artifacts/<group>/<name>/<version>/archive[?build=<n>]`), or null for any other cached path.
 */
export function parseCachedArchivePath(path: string): { group: string; name: string; version: string; buildNumber: number | null } | null {
  const match = /^artifacts\/([^/?]+)\/([^/?]+)\/([^/?]+)\/archive(?:\?build=(\d+))?$/.exec(path);
  if (!match) return null;
  try {
    const [group, name, version] = [match[1]!, match[2]!, match[3]!].map(decodeURIComponent) as [string, string, string];
    return { group, name, version, buildNumber: match[4] === undefined ? null : Number(match[4]) };
  } catch {
    return null;
  }
}

/** The newest of `versions` by version order, or `null` for none. */
function newest(versions: string[]): string | null {
  return versions.reduce<string | null>((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

/**
 * Artifact and version counts per repository id, counting only the groups the principal may read
 * (API keys can be limited to group prefixes).
 */
async function countsByRepository(db: Db, p: Principal, repos: RepositoryRow[]) {
  const out = new Map<string, { artifactCount: number; versionCount: number }>();
  if (repos.length === 0) return out;
  const byId = new Map(repos.map((r) => [r.id, r]));
  const rows = await db
    .select({
      repositoryId: protoArtifact.repositoryId,
      group: protoArtifact.group,
      artifactCount: countDistinct(protoArtifact.id),
      versionCount: count(protoVersion.id),
    })
    .from(protoArtifact)
    .leftJoin(protoVersion, eq(protoVersion.artifactId, protoArtifact.id))
    .where(inArray(protoArtifact.repositoryId, [...byId.keys()]))
    .groupBy(protoArtifact.repositoryId, protoArtifact.group);
  for (const row of rows) {
    if (!canReadGroup(p, byId.get(row.repositoryId)!, row.group)) continue;
    const sum = out.get(row.repositoryId) ?? { artifactCount: 0, versionCount: 0 };
    sum.artifactCount += row.artifactCount;
    sum.versionCount += row.versionCount;
    out.set(row.repositoryId, sum);
  }
  return out;
}

/** The versions of the given artifacts, grouped by artifact id. */
async function versionsByArtifact(db: Db, artifactIds: string[]) {
  const out = new Map<string, { version: string; updatedAt: Date }[]>();
  if (artifactIds.length === 0) return out;
  const rows = await db
    .select({ artifactId: protoVersion.artifactId, version: protoVersion.version, updatedAt: protoVersion.updatedAt })
    .from(protoVersion)
    .where(inArray(protoVersion.artifactId, artifactIds));
  for (const row of rows) {
    const list = out.get(row.artifactId) ?? [];
    list.push({ version: row.version, updatedAt: row.updatedAt });
    out.set(row.artifactId, list);
  }
  return out;
}

/** Read-only browsing of repositories, artifacts, versions and files, scoped to what the caller may read. */
export const browseRouter = router({
  /** Repositories the caller may browse, by name, with format, kind and (proto) artifact and version counts. */
  repositories: browseProcedure.query(async ({ ctx }) => {
    const repos = await browsableRepositories(ctx.db, ctx.principal);
    const counts = await countsByRepository(ctx.db, ctx.principal, repos);
    return repos.map((repo) => ({
      name: repo.name,
      format: repo.format,
      kind: repo.kind,
      description: repo.description,
      visibility: repo.visibility,
      artifactCount: counts.get(repo.id)?.artifactCount ?? 0,
      versionCount: counts.get(repo.id)?.versionCount ?? 0,
      createdAt: repo.createdAt,
    }));
  }),

  /**
   * One repository the caller may browse, for the per-format browse views; `NOT_FOUND` when hidden
   * or missing. Admins get the full repository including its config; everyone else a reduced view
   * without mirror rules or cache settings.
   */
  repository: browseProcedure.input(z.object({ name: repositoryName })).query(async ({ ctx, input }): Promise<BrowseRepo> => {
    await requireBrowsableRepository(ctx.db, ctx.principal, input.name);
    const repo = await ctx.repos.get(input.name);
    if (!repo) throw notFound(`Repository ${input.name} was not found`);
    const cache = (repo.config as { cache?: { enabled?: boolean } }).cache;
    const reduced: BrowseRepo = {
      name: repo.name,
      format: repo.format,
      kind: repo.kind,
      description: repo.description,
      visibility: repo.visibility,
      dockerRoot: repo.dockerRoot,
      cacheEnabled: repo.kind === "mirror" ? cache?.enabled === true : null,
    };
    const isAdmin = ctx.principal.kind === "user" && ctx.principal.role === "admin";
    return isAdmin ? { ...reduced, id: repo.id, config: repo.config } : reduced;
  }),

  /**
   * The artifacts of a hosted proto repository (`BAD_REQUEST` for other formats, `NOT_FOUND` for
   * mirrors and groups), optionally filtered by a case-insensitive `search` on group or name.
   */
  artifacts: browseProcedure
    .input(z.object({ repository: repositoryName, search: z.string().trim().max(200).optional() }))
    .query(async ({ ctx, input }): Promise<ArtifactSummary[]> => {
      const repo = await requireHostedListing(ctx.db, ctx.principal, input.repository, { format: "proto" });
      const pattern = input.search ? `%${escapeLike(input.search)}%` : null;
      const rows = await ctx.db
        .select({ id: protoArtifact.id, group: protoArtifact.group, name: protoArtifact.name })
        .from(protoArtifact)
        .where(
          and(
            eq(protoArtifact.repositoryId, repo.id),
            pattern
              ? or(
                  ilike(protoArtifact.group, pattern),
                  ilike(protoArtifact.name, pattern),
                  ilike(sql`${protoArtifact.group} || ':' || ${protoArtifact.name}`, pattern),
                )
              : undefined,
          ),
        )
        .orderBy(asc(protoArtifact.group), asc(protoArtifact.name));
      const readable = rows.filter((row) => canReadGroup(ctx.principal, repo, row.group));
      const versions = await versionsByArtifact(ctx.db, readable.map((row) => row.id));
      return readable.flatMap((row) => {
        const list = versions.get(row.id) ?? [];
        const latestVersion = newest(list.map((v) => v.version));
        if (latestVersion === null) return [];
        const updatedAt = new Date(Math.max(...list.map((v) => v.updatedAt.getTime())));
        return [{ group: row.group, name: row.name, latestVersion, versionCount: list.length, updatedAt }];
      });
    }),

  /** The versions of an artifact of a hosted repository, newest first; `NOT_FOUND` for mirrors and groups. */
  versions: browseProcedure
    .input(
      z.object({
        repository: repositoryName,
        group: z.string().refine(isValidGroup, "Invalid group"),
        name: z.string().refine(isValidName, "Invalid artifact name"),
      }),
    )
    .query(async ({ ctx, input }) => {
      await requireHostedListing(ctx.db, ctx.principal, input.repository);
      return ctx.registry.listVersions(ctx.principal, input.repository, input.group, input.name);
    }),

  /**
   * A version's metadata (its newest build) with the coordinate, dependencies and dependents as
   * `group:name:version` strings. Dependents in repositories the caller can't read are left out.
   * Hosted repositories only; `NOT_FOUND` for mirrors and groups.
   */
  version: browseProcedure
    .input(z.object({ repository: repositoryName, coordinate: coordinateString }))
    .query(async ({ ctx, input }) => {
      const c = parseCoordinate(input.coordinate);
      await requireHostedListing(ctx.db, ctx.principal, input.repository);
      const info = await ctx.registry.getManifest(ctx.principal, input.repository, c);
      const dependents = await ctx.registry.listDependents(c);
      const names = [...new Set(dependents.map((d) => d.repository))];
      const repos =
        names.length === 0
          ? []
          : await ctx.db
              .select({ id: repository.id, name: repository.name, visibility: repository.visibility })
              .from(repository)
              .where(inArray(repository.name, names));
      const byName = new Map(repos.map((r) => [r.name, r]));
      return {
        ...info,
        coordinate: coordinateText(info.coordinate),
        dependencies: info.dependencies.map(coordinateText),
        dependents: dependents
          .filter((d) => {
            const repo = byName.get(d.repository);
            return repo !== undefined && canReadGroup(ctx.principal, repo, d.coordinate.group);
          })
          .map((d) => ({ repository: d.repository, coordinate: coordinateText(d.coordinate) })),
      };
    }),

  /** One proto file of a version's newest build in a hosted repository; `NOT_FOUND` for mirrors and groups. */
  file: browseProcedure
    .input(z.object({ repository: repositoryName, coordinate: coordinateString, path: z.string().min(1).max(1024) }))
    .query(async ({ ctx, input }) => {
      const c = parseCoordinate(input.coordinate);
      await requireHostedListing(ctx.db, ctx.principal, input.repository);
      const content = await ctx.registry.getFile(ctx.principal, input.repository, c, input.path);
      return { path: input.path, content };
    }),

  /**
   * What a proto mirror (`BAD_REQUEST` for other repositories) has cached: its archives in groups
   * the caller may read, newest access first, at most {@link PROTO_CACHE_LIMIT}. While caching is
   * off, admins also get the first upstream URL; nobody else is ever sent an upstream.
   */
  protoCache: browseProcedure.input(z.object({ repository: repositoryName })).query(async ({ ctx, input }): Promise<ProtoCache> => {
    const repo = await requireBrowsableRepository(ctx.db, ctx.principal, input.repository, { format: "proto" });
    requireKind(repo, "mirror");
    const caching = (repo.config as { cache?: { enabled?: boolean } }).cache?.enabled === true;
    const upstream = !caching && isAdminUser(ctx.principal) ? ((await ctx.repos.upstreams(repo.id))[0]?.url ?? null) : null;
    const rows = await ctx.db
      .select({ path: asset.path, size: asset.size, lastAccessedAt: asset.lastAccessedAt, expiresAt: asset.expiresAt })
      .from(asset)
      .where(
        and(
          eq(asset.repositoryId, repo.id),
          eq(asset.origin, "cache"),
          or(like(asset.path, "artifacts/%/archive"), like(asset.path, "artifacts/%/archive?build=%")),
        ),
      )
      .orderBy(sql`${asset.lastAccessedAt} desc nulls last`, desc(asset.updatedAt), asc(asset.path))
      .limit(PROTO_CACHE_LIMIT);
    const items = rows.flatMap((row): ProtoCacheItem[] => {
      const parsed = parseCachedArchivePath(row.path);
      if (!parsed || !canReadGroup(ctx.principal, repo, parsed.group)) return [];
      return [
        {
          coordinate: `${parsed.group}:${parsed.name}:${parsed.version}`,
          buildNumber: parsed.buildNumber,
          size: row.size,
          lastAccessedAt: row.lastAccessedAt,
          cache: row.expiresAt === null ? "immutable" : "metadata",
        },
      ];
    });
    return { caching, upstream, items };
  }),

  /**
   * The members of a proto group (`BAD_REQUEST` for other repositories) in the order the group
   * searches them, leaving out members the caller could not browse on their own.
   */
  protoMembers: browseProcedure.input(z.object({ repository: repositoryName })).query(async ({ ctx, input }): Promise<ProtoMember[]> => {
    const repo = await requireBrowsableRepository(ctx.db, ctx.principal, input.repository, { format: "proto" });
    requireKind(repo, "group");
    const members = await ctx.repos.members(repo.id);
    return members
      .filter((member) => canBrowseRepository(ctx.principal, member))
      .map((member) => ({ name: member.name, kind: member.kind === "mirror" ? "mirror" : "hosted", visibility: member.visibility }));
  }),
});

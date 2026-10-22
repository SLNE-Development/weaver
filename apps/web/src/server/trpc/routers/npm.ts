import { and, asc, eq, ilike, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Principal, RepoService } from "@weaver/core";
import { asset, component, npmPackage, type Db } from "@weaver/db";
import { compareSemver } from "@weaver/npm";
import { browseProcedure, router } from "../init";
import { canBrowseRepository, canReadGroup, escapeLike, notFound, repositoryName, requireBrowsableRepository, type RepositoryRow } from "../helpers";

/** Packages per page of `npm.packages`. */
export const NPM_PAGE_SIZE = 25;

/** Most packages one source repository contributes to a listing; keeps a huge mirror cache from being read whole. */
const SOURCE_LIMIT = 5000;

/** Longest README returned by `npm.package`. */
const README_MAX = 512 * 1024;

/** One package of a listing. */
export interface NpmPackageSummary {
  name: string;
  latest: string | null;
  description: string | null;
  updatedAt: Date;
}

/** One version of a package page. */
export interface NpmVersionSummary {
  version: string;
  publishedAt: string | null;
  deprecated: string | null;
  size: number | null;
  downloads: number;
}

/** A source repository of a browse: the repository itself or one member of a group. */
interface Source {
  id: string;
  kind: RepositoryRow["kind"];
}

/** `@scope/name` for a stored component, plain `name` for an unscoped one. */
function fullName(namespace: string, name: string): string {
  return namespace === "" ? name : `@${namespace}/${name}`;
}

/** Splits a full package name into the stored `component.namespace` (scope without `@`) and name. */
function splitName(full: string): { namespace: string; name: string } {
  if (!full.startsWith("@")) return { namespace: "", name: full };
  const slash = full.indexOf("/");
  return slash < 0 ? { namespace: "", name: full } : { namespace: full.slice(1, slash), name: full.slice(slash + 1) };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The highest of `versions` by semver order, or null for none. */
function highest(versions: string[]): string | null {
  return versions.reduce<string | null>((best, v) => (best === null || compareSemver(v, best) > 0 ? v : best), null);
}

/**
 * The repositories whose stored content a browse of `name` shows, in group order: the repository itself, or the members
 * the principal may browse. Throws `NOT_FOUND` unless the principal may read the repository.
 */
async function sourcesOf(
  ctx: { db: Db; principal: Principal; repos: RepoService },
  name: string,
): Promise<{ repo: RepositoryRow; sources: Source[]; members: string[] }> {
  const repo = await requireBrowsableRepository(ctx.db, ctx.principal, name, { format: "npm" });
  if (!canReadGroup(ctx.principal, repo, "")) throw notFound(`Repository ${name} was not found`);
  if (repo.kind !== "group") return { repo, sources: [{ id: repo.id, kind: repo.kind }], members: [] };
  const members = (await ctx.repos.members(repo.id)).filter((m) => canBrowseRepository(ctx.principal, m));
  return { repo, sources: members.map((m) => ({ id: m.id, kind: m.kind })), members: members.map((m) => m.name) };
}

/**
 * Read-only browsing of npm repositories. Only what Weaver stores is shown: hosted packuments, and the components a
 * mirror cached. Mirror settings (rules, upstreams) are never returned.
 */
export const npmRouter = router({
  /** Packages of the repository (the members' for a group), by name, 25 per page, optionally filtered by a name substring. */
  packages: browseProcedure
    .input(z.object({ repo: repositoryName, query: z.string().trim().max(200).optional(), cursor: z.number().int().min(0).max(1_000_000).optional() }))
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ items: NpmPackageSummary[]; nextCursor: number | null; source: "hosted" | "cache" | "group"; members?: string[] }> => {
        const { repo, sources, members } = await sourcesOf(ctx, input.repo);
        const pattern = input.query ? `%${escapeLike(input.query)}%` : null;
        const byName = new Map<string, NpmPackageSummary>();
        for (const source of sources) {
          if (source.kind === "hosted") {
            const rows = await ctx.db
              .select({
                name: npmPackage.name,
                latest: sql<string | null>`${npmPackage.document}->'dist-tags'->>'latest'`,
                description: sql<string | null>`${npmPackage.document}->>'description'`,
                updatedAt: npmPackage.updatedAt,
              })
              .from(npmPackage)
              .where(and(eq(npmPackage.repositoryId, source.id), pattern ? ilike(npmPackage.name, pattern) : undefined))
              .orderBy(asc(npmPackage.name))
              .limit(SOURCE_LIMIT);
            for (const r of rows) {
              if (!byName.has(r.name)) byName.set(r.name, { name: r.name, latest: str(r.latest), description: str(r.description), updatedAt: r.updatedAt });
            }
          } else if (source.kind === "mirror") {
            const full = sql<string>`CASE WHEN ${component.namespace} = '' THEN ${component.name} ELSE '@' || ${component.namespace} || '/' || ${component.name} END`;
            const rows = await ctx.db
              .select({
                namespace: component.namespace,
                name: component.name,
                versions: sql<string[]>`array_agg(${component.version})`,
                updatedAt: sql<string>`max(${component.updatedAt})`,
              })
              .from(component)
              .where(and(eq(component.repositoryId, source.id), pattern ? sql`${full} ILIKE ${pattern}` : undefined))
              .groupBy(component.namespace, component.name)
              .orderBy(asc(component.namespace), asc(component.name))
              .limit(SOURCE_LIMIT);
            for (const r of rows) {
              const name = fullName(r.namespace, r.name);
              if (!byName.has(name)) byName.set(name, { name, latest: highest(r.versions), description: null, updatedAt: new Date(r.updatedAt) });
            }
          }
        }
        const all = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const from = input.cursor ?? 0;
        return {
          items: all.slice(from, from + NPM_PAGE_SIZE),
          nextCursor: from + NPM_PAGE_SIZE < all.length ? from + NPM_PAGE_SIZE : null,
          source: repo.kind === "hosted" ? "hosted" : repo.kind === "mirror" ? "cache" : "group",
          ...(repo.kind === "group" ? { members } : {}),
        };
      },
    ),

  /** One package: dist-tags, versions newest first, README. Null when no source stores it; the first source that has it wins. */
  package: browseProcedure
    .input(z.object({ repo: repositoryName, name: z.string().min(1).max(214) }))
    .query(
      async ({
        ctx,
        input,
      }): Promise<{
        name: string;
        distTags: Record<string, string>;
        versions: NpmVersionSummary[];
        readme: string | null;
        description: string | null;
      } | null> => {
        const { sources } = await sourcesOf(ctx, input.repo);
        const { namespace, name } = splitName(input.name);
        const ids = sources.map((s) => s.id);
        if (ids.length === 0) return null;

        // Sizes and download counts of the stored tarballs, per source repository and version.
        const stored = await ctx.db
          .select({
            repositoryId: component.repositoryId,
            version: component.version,
            downloads: component.downloadCount,
            size: sql<string | null>`max(${asset.size})`,
          })
          .from(component)
          .leftJoin(asset, eq(asset.componentId, component.id))
          .where(and(inArray(component.repositoryId, ids), eq(component.namespace, namespace), eq(component.name, name)))
          .groupBy(component.id);

        for (const source of sources) {
          const own = stored.filter((s) => s.repositoryId === source.id);
          if (source.kind === "hosted") {
            const [row] = await ctx.db
              .select({ document: npmPackage.document })
              .from(npmPackage)
              .where(and(eq(npmPackage.repositoryId, source.id), eq(npmPackage.name, input.name)));
            if (!row) continue;
            const doc = row.document;
            const time = isRecord(doc["time"]) ? doc["time"] : {};
            const versionsDoc = isRecord(doc["versions"]) ? doc["versions"] : {};
            const versions = Object.keys(versionsDoc).map((version): NpmVersionSummary => {
              const manifest = versionsDoc[version];
              const extra = own.find((o) => o.version === version);
              return {
                version,
                publishedAt: str(time[version]),
                deprecated: isRecord(manifest) ? str(manifest["deprecated"]) : null,
                size: extra?.size == null ? null : Number(extra.size),
                downloads: extra?.downloads ?? 0,
              };
            });
            const tags = isRecord(doc["dist-tags"]) ? doc["dist-tags"] : {};
            const readme = str(doc["readme"]);
            return {
              name: input.name,
              distTags: Object.fromEntries(Object.entries(tags).filter((e): e is [string, string] => typeof e[1] === "string")),
              versions: versions.sort((a, b) => compareSemver(b.version, a.version)),
              readme: readme === null ? null : readme.slice(0, README_MAX),
              description: str(doc["description"]),
            };
          }
          if (source.kind === "mirror" && own.length > 0) {
            const versions = own.map(
              (o): NpmVersionSummary => ({ version: o.version, publishedAt: null, deprecated: null, size: o.size == null ? null : Number(o.size), downloads: o.downloads }),
            );
            return { name: input.name, distTags: {}, versions: versions.sort((a, b) => compareSemver(b.version, a.version)), readme: null, description: null };
          }
        }
        return null;
      },
    ),
});

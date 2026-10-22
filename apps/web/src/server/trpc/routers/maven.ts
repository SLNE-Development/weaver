import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import type { Kind } from "@weaver/core";
import { asset, component, type Db } from "@weaver/db";
import { compareMavenVersions, isSnapshotVersion } from "@weaver/maven";
import { browseProcedure, router } from "../init";
import { canBrowseRepository, canReadGroup, escapeLike, notFound, repositoryName, requireBrowsableRepository, type RepositoryRow } from "../helpers";

/** Most artifacts `maven.artifacts` returns. */
export const MAVEN_ARTIFACTS_MAX = 500;

/** One artifact of a Maven repository as `maven.artifacts` lists it. */
export interface MavenArtifactSummary {
  groupId: string;
  artifactId: string;
  latestVersion: string;
  versionCount: number;
  updatedAt: Date;
}

/** The newest of `versions` by Maven version order. */
function newestVersion(versions: string[]): string {
  return versions.reduce((best, v) => (compareMavenVersions(v, best) > 0 ? v : best));
}

/**
 * The ids of the repositories whose components a browse of `repo` shows: the repository itself, or
 * for a group its members in order (reading a group grants reading what is served through it).
 */
async function sourceIds(ctx: { repos: { members(id: string): Promise<{ id: string }[]> } }, repo: RepositoryRow): Promise<string[]> {
  if (repo.kind !== "group") return [repo.id];
  return (await ctx.repos.members(repo.id)).map((m) => m.id);
}

const artifactInput = z.object({
  repository: repositoryName,
  groupId: z.string().min(1).max(300),
  artifactId: z.string().min(1).max(300),
});

/** Components of the sources for one artifact, newest first, one row per version. */
async function versionRows(db: Db, ids: string[], groupId: string, artifactId: string) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ version: component.version, updatedAt: component.updatedAt, downloadCount: component.downloadCount })
    .from(component)
    .where(and(inArray(component.repositoryId, ids), eq(component.namespace, groupId), eq(component.name, artifactId)));
  const byVersion = new Map<string, { version: string; updatedAt: Date; downloadCount: number }>();
  for (const row of rows) {
    const seen = byVersion.get(row.version);
    if (!seen) byVersion.set(row.version, row);
    else
      byVersion.set(row.version, {
        version: row.version,
        updatedAt: row.updatedAt > seen.updatedAt ? row.updatedAt : seen.updatedAt,
        downloadCount: seen.downloadCount + row.downloadCount,
      });
  }
  return [...byVersion.values()].sort((a, b) => compareMavenVersions(b.version, a.version));
}

/**
 * Read-only browsing of Maven repositories. Mirror settings (rules, upstreams) are never returned
 * here: the overview exposes only whether caching is on.
 */
export const mavenRouter = router({
  /** Kind, group members in order, and the few settings the view needs; `BAD_REQUEST` for other formats. */
  overview: browseProcedure
    .input(z.object({ repository: repositoryName }))
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ kind: Kind; members: string[]; cacheEnabled: boolean | null; versionPolicy: "release" | "snapshot" | "mixed" | null }> => {
        const row = await requireBrowsableRepository(ctx.db, ctx.principal, input.repository, { format: "maven" });
        const repo = await ctx.repos.get(input.repository);
        if (!repo) throw notFound(`Repository ${input.repository} was not found`);
        const members = repo.kind === "group" ? (await ctx.repos.members(row.id)).filter((m) => canBrowseRepository(ctx.principal, m)).map((m) => m.name) : [];
        const config = repo.config as { cache?: { enabled?: boolean }; versionPolicy?: "release" | "snapshot" | "mixed" };
        return {
          kind: repo.kind,
          members,
          cacheEnabled: repo.kind === "mirror" ? config.cache?.enabled === true : null,
          versionPolicy: repo.kind === "hosted" ? (config.versionPolicy ?? "mixed") : null,
        };
      },
    ),

  /** Artifacts of the repository (members' for a group), by groupId and artifactId, at most 500, optionally under a groupId prefix. */
  artifacts: browseProcedure
    .input(z.object({ repository: repositoryName, groupPrefix: z.string().trim().max(300).optional() }))
    .query(async ({ ctx, input }): Promise<MavenArtifactSummary[]> => {
      const repo = await requireBrowsableRepository(ctx.db, ctx.principal, input.repository, { format: "maven" });
      const ids = await sourceIds(ctx, repo);
      if (ids.length === 0) return [];
      const prefix = input.groupPrefix ? like(component.namespace, `${escapeLike(input.groupPrefix)}%`) : undefined;
      const out: MavenArtifactSummary[] = [];
      // Page through the groups so the permission filter applies before the limit: a restricted key
      // must not get an empty first page just because other groups sort first.
      for (let offset = 0; out.length < MAVEN_ARTIFACTS_MAX; offset += MAVEN_ARTIFACTS_MAX) {
        const rows = await ctx.db
          .select({
            groupId: component.namespace,
            artifactId: component.name,
            versions: sql<string[]>`array_agg(${component.version})`,
            updatedAt: sql<string>`max(${component.updatedAt})`,
          })
          .from(component)
          .where(and(inArray(component.repositoryId, ids), prefix))
          .groupBy(component.namespace, component.name)
          .orderBy(asc(component.namespace), asc(component.name))
          .limit(MAVEN_ARTIFACTS_MAX)
          .offset(offset);
        for (const row of rows) {
          if (out.length === MAVEN_ARTIFACTS_MAX) break;
          if (!canReadGroup(ctx.principal, repo, row.groupId)) continue;
          const versions = [...new Set(row.versions)];
          out.push({
            groupId: row.groupId,
            artifactId: row.artifactId,
            latestVersion: newestVersion(versions),
            versionCount: versions.length,
            updatedAt: new Date(row.updatedAt),
          });
        }
        if (rows.length < MAVEN_ARTIFACTS_MAX) break;
      }
      return out;
    }),

  /** The versions of an artifact, newest first by Maven version order. */
  versions: browseProcedure.input(artifactInput).query(async ({ ctx, input }) => {
    const repo = await requireBrowsableRepository(ctx.db, ctx.principal, input.repository, { format: "maven" });
    if (!canReadGroup(ctx.principal, repo, input.groupId)) throw notFound(`Repository ${input.repository} was not found`);
    const rows = await versionRows(ctx.db, await sourceIds(ctx, repo), input.groupId, input.artifactId);
    return rows.map((r) => ({ version: r.version, snapshot: isSnapshotVersion(r.version), updatedAt: r.updatedAt, downloadCount: r.downloadCount }));
  }),

  /** The stored files of one version with their public download URLs; the first member wins a path in a group. */
  files: browseProcedure.input(artifactInput.extend({ version: z.string().min(1).max(300) })).query(async ({ ctx, input }) => {
    const repo = await requireBrowsableRepository(ctx.db, ctx.principal, input.repository, { format: "maven" });
    if (!canReadGroup(ctx.principal, repo, input.groupId)) throw notFound(`Repository ${input.repository} was not found`);
    const ids = await sourceIds(ctx, repo);
    if (ids.length === 0) return [];
    const rows = await ctx.db
      .select({
        repositoryId: asset.repositoryId,
        path: asset.path,
        size: asset.size,
        sha1: asset.sha1,
        contentType: asset.contentType,
        updatedAt: asset.updatedAt,
      })
      .from(asset)
      .innerJoin(component, eq(component.id, asset.componentId))
      .where(
        and(
          inArray(asset.repositoryId, ids),
          eq(component.namespace, input.groupId),
          eq(component.name, input.artifactId),
          eq(component.version, input.version),
        ),
      )
      .orderBy(asc(asset.path));
    const order = new Map(ids.map((id, i) => [id, i]));
    const byPath = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const seen = byPath.get(row.path);
      if (!seen || order.get(row.repositoryId)! < order.get(seen.repositoryId)!) byPath.set(row.path, row);
    }
    return [...byPath.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((r) => ({
        name: r.path.slice(r.path.lastIndexOf("/") + 1),
        path: r.path,
        size: r.size,
        sha1: r.sha1,
        contentType: r.contentType,
        updatedAt: r.updatedAt,
        url: `${ctx.publicUrl}/maven/${input.repository}/${r.path}`,
      }));
  }),
});

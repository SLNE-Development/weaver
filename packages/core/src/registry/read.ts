import { and, asc, eq, max, sql } from "drizzle-orm";
import { component, protoArtifact, protoBuild, protoBuildFile, protoDependency, protoVersion, repository, user } from "@weaver/db";
import { recordUsage } from "../content/usage.js";
import { compareVersions, formatCoordinate, type Coordinate } from "../coordinates.js";
import { RegistryError } from "../errors.js";
import { canAccess, canForce, type Principal } from "../permissions.js";
import type { Repo, RepoService } from "../repos/service.js";
import type { ResolvedNode } from "../resolution.js";
import { getBuffer } from "../storage/index.js";
import { findLatestBuild, loadDependencies, nodeOf, type BuildRow, type Queryable, type RegistryContext } from "./lookup.js";

/** Summary of one version of an artifact. */
export interface VersionSummary {
  version: string;
  isSnapshot: boolean;
  latestBuild: number;
  updatedAt: Date;
}

/** Full metadata of a version, describing its newest build. */
export interface VersionInfo {
  repository: string;
  coordinate: Coordinate;
  buildNumber: number;
  sha256: string;
  sizeBytes: number;
  dependencies: Coordinate[];
  files: string[];
  publishedBy: string | null;
  downloadCount: number;
  createdAt: Date;
  builds: { buildNumber: number; createdAt: Date; sha256: string }[];
}

/** A version that declares a dependency on some coordinate. */
export interface Dependent {
  repository: string;
  coordinate: Coordinate;
}

/** Selects one build of a version: `buildNumber` when given, otherwise the newest. */
export interface BuildSelector {
  buildNumber?: number;
}

/** The archive of one build, with the id of the build it was served from. */
export interface HostedArchive {
  data: Buffer;
  sha256: string;
  filename: string;
  buildId: string;
  /** The version's `component` row, for usage records; null for builds published before components were kept. */
  componentId: string | null;
}

/** Unchecked reads of one hosted proto repo; the caller has already authorised the read. */
export interface HostedReader {
  /** The newest build of `c` (or build `buildNumber`) as a resolved node naming `repo`; null when absent. */
  node(repo: Repo, c: Coordinate, buildNumber?: number): Promise<ResolvedNode | null>;
  /** The versions of an artifact, newest version first; `[]` when the artifact is absent. */
  versions(repo: Repo, group: string, name: string): Promise<VersionSummary[]>;
  /** Metadata of the newest build or of `select.buildNumber`; null when absent. */
  manifest(repo: Repo, c: Coordinate, select?: BuildSelector): Promise<VersionInfo | null>;
  /** Archive bytes of the newest build or `select.buildNumber`; counts a download on the build. */
  archive(repo: Repo, c: Coordinate, select?: BuildSelector): Promise<HostedArchive | null>;
}

/** Which write a repository is loaded for; mirrors and groups accept neither. */
export type WriteAction = "publish" | "delete";

function notFound(what: string): RegistryError {
  return new RegistryError("not_found", `${what} was not found`);
}

function missingBuild(c: Coordinate, buildNumber: number | undefined): RegistryError {
  return notFound(buildNumber === undefined ? `Version ${formatCoordinate(c)}` : `Build ${buildNumber} of ${formatCoordinate(c)}`);
}

/**
 * Loads a proto repository the principal may read for `group`. Missing, non-proto and unreadable
 * repositories all throw the same `not_found`, so private repositories are not disclosed. For a
 * write (`action`), a readable mirror or group then throws `method_not_allowed`, before the
 * caller's write permission check.
 */
export async function readableRepository(
  repos: RepoService,
  p: Principal,
  name: string,
  group: string,
  action?: WriteAction,
): Promise<Repo> {
  const repo = await repos.get(name);
  if (!repo || repo.format !== "proto" || !canAccess(p, repo, group, "read")) throw notFound(`Repository ${name}`);
  if (action && repo.kind !== "hosted") {
    const hint = action === "publish" ? "publish to a hosted repository" : "delete from a hosted repository";
    throw new RegistryError("method_not_allowed", `Repository ${repo.name} is a ${repo.kind}; ${hint}`);
  }
  return repo;
}

/** Creates the unchecked reads of hosted proto repositories over the registry's database and stores. */
export function createHostedReader(ctx: Pick<RegistryContext, "db" | "stores">): HostedReader {
  const { db, stores } = ctx;
  return {
    async node(repo, c, buildNumber) {
      const found = await findLatestBuild(db, repo.id, c, buildNumber);
      return found ? nodeOf(db, repo, c, found) : null;
    },

    async versions(repo, group, name) {
      const rows = await db
        .select({
          version: protoVersion.version,
          isSnapshot: protoVersion.isSnapshot,
          updatedAt: protoVersion.updatedAt,
          latestBuild: max(protoBuild.buildNumber),
        })
        .from(protoVersion)
        .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
        .innerJoin(protoBuild, eq(protoBuild.versionId, protoVersion.id))
        .where(and(eq(protoArtifact.repositoryId, repo.id), eq(protoArtifact.group, group), eq(protoArtifact.name, name)))
        .groupBy(protoVersion.id);
      return rows
        .map((r) => ({ ...r, latestBuild: r.latestBuild ?? 0 }))
        .sort((a, b) => compareVersions(b.version, a.version));
    },

    async manifest(repo, c, { buildNumber } = {}) {
      const latest = await findLatestBuild(db, repo.id, c, buildNumber);
      return latest ? describeBuild(db, repo, c, latest) : null;
    },

    async archive(repo, c, { buildNumber } = {}) {
      const served = await findLatestBuild(db, repo.id, c, buildNumber);
      if (!served) return null;
      const store = stores.get(served.store);
      if (!store) throw new Error(`Archive blob ${served.storageKey} is in store ${served.store}, which is not configured`);
      const data = await getBuffer(store, served.storageKey);
      if (!data) throw new Error(`Archive blob ${served.storageKey} is missing from storage`);
      await db
        .update(protoBuild)
        .set({ downloadCount: sql`${protoBuild.downloadCount} + 1`, lastDownloadedAt: new Date() })
        .where(eq(protoBuild.id, served.id));
      const [row] = await db
        .select({ id: component.id })
        .from(component)
        .where(
          and(
            eq(component.repositoryId, repo.id),
            eq(component.namespace, c.group),
            eq(component.name, c.name),
            eq(component.version, c.version),
          ),
        );
      return { data, sha256: served.sha256, filename: `${c.name}-${c.version}.tar.gz`, buildId: served.id, componentId: row?.id ?? null };
    },
  };
}

/** The {@link VersionInfo} of build `latest` of `c` in `repo`. */
async function describeBuild(db: Queryable, repo: Repo, c: Coordinate, latest: BuildRow): Promise<VersionInfo> {
  const [files, dependencies, builds, publisher] = await Promise.all([
    db
      .select({ path: protoBuildFile.path })
      .from(protoBuildFile)
      .where(eq(protoBuildFile.buildId, latest.id))
      .orderBy(asc(protoBuildFile.path)),
    loadDependencies(db, latest.id),
    db
      .select({ buildNumber: protoBuild.buildNumber, createdAt: protoBuild.createdAt, sha256: protoBuild.sha256 })
      .from(protoBuild)
      .where(eq(protoBuild.versionId, latest.versionId))
      .orderBy(asc(protoBuild.buildNumber)),
    latest.publishedByUserId
      ? db.select({ name: user.name }).from(user).where(eq(user.id, latest.publishedByUserId))
      : Promise.resolve([]),
  ]);
  return {
    repository: repo.name,
    coordinate: { group: c.group, name: c.name, version: c.version },
    buildNumber: latest.buildNumber,
    sha256: latest.sha256,
    sizeBytes: latest.sizeBytes,
    dependencies,
    files: files.map((f) => f.path),
    // A deleted publisher shows as null, never as a raw user id.
    publishedBy: publisher[0]?.name ?? null,
    downloadCount: latest.downloadCount,
    createdAt: latest.createdAt,
    builds,
  };
}

/** Lists the versions of an artifact in a readable repository, newest version first; `not_found` when it has none. */
export async function listVersions(
  ctx: RegistryContext,
  hosted: HostedReader,
  p: Principal,
  repositoryName: string,
  group: string,
  name: string,
): Promise<VersionSummary[]> {
  const repo = await readableRepository(ctx.repos, p, repositoryName, group);
  const versions = await hosted.versions(repo, group, name);
  if (versions.length === 0) throw notFound(`Artifact ${group}:${name}`);
  return versions;
}

/** Metadata of a version; snapshots describe their newest build unless `select` names one. */
export async function getManifest(
  ctx: RegistryContext,
  hosted: HostedReader,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
  select: BuildSelector = {},
): Promise<VersionInfo> {
  const repo = await readableRepository(ctx.repos, p, repositoryName, c.group);
  const info = await hosted.manifest(repo, c, select);
  if (!info) throw missingBuild(c, select.buildNumber);
  return info;
}

/**
 * Returns the archive of a version's newest build (or the build `select` names, `not_found` once
 * it is gone), counts the download on that build and records it with {@link recordUsage}, which
 * also counts it on the version's component.
 */
export async function download(
  ctx: RegistryContext,
  hosted: HostedReader,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
  select: BuildSelector = {},
): Promise<{ data: Buffer; sha256: string; filename: string }> {
  const repo = await readableRepository(ctx.repos, p, repositoryName, c.group);
  const archive = await hosted.archive(repo, c, select);
  if (!archive) throw missingBuild(c, select.buildNumber);
  await recordUsage(ctx.db, {
    repositoryId: repo.id,
    componentId: archive.componentId,
    path: `${c.group}/${c.name}/${c.version}`,
    action: "download",
    bytes: archive.data.length,
    principal: p,
  });
  return { data: archive.data, sha256: archive.sha256, filename: archive.filename };
}

/** Returns one proto file of a version's newest build. */
export async function getFile(
  ctx: RegistryContext,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
  path: string,
): Promise<string> {
  const repo = await readableRepository(ctx.repos, p, repositoryName, c.group);
  const latest = await findLatestBuild(ctx.db, repo.id, c);
  if (!latest) throw missingBuild(c, undefined);
  const [row] = await ctx.db
    .select({ content: protoBuildFile.content })
    .from(protoBuildFile)
    .where(and(eq(protoBuildFile.buildId, latest.id), eq(protoBuildFile.path, path)));
  if (!row) throw notFound(`File ${path}`);
  return row.content;
}

/** A dependent plus its repository's visibility, so callers can filter by read access. */
export interface DependentRow extends Dependent {
  repositoryId: string;
  visibility: "public" | "private";
}

/** Every version, in any repository, whose builds declare a dependency on `c`. */
export async function listDependents(db: Queryable, c: Coordinate): Promise<Dependent[]> {
  return (await findDependents(db, c)).map(({ repository, coordinate }) => ({ repository, coordinate }));
}

/** Like {@link listDependents}, also carrying each dependent repository's visibility. */
export async function findDependents(db: Queryable, c: Coordinate): Promise<DependentRow[]> {
  const rows = await db
    .selectDistinct({
      repositoryId: repository.id,
      repository: repository.name,
      visibility: repository.visibility,
      group: protoArtifact.group,
      name: protoArtifact.name,
      version: protoVersion.version,
    })
    .from(protoDependency)
    .innerJoin(protoBuild, eq(protoBuild.id, protoDependency.buildId))
    .innerJoin(protoVersion, eq(protoVersion.id, protoBuild.versionId))
    .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
    .innerJoin(repository, eq(repository.id, protoArtifact.repositoryId))
    .where(
      and(eq(protoDependency.depGroup, c.group), eq(protoDependency.depName, c.name), eq(protoDependency.depVersion, c.version)),
    )
    .orderBy(asc(repository.name), asc(protoArtifact.group), asc(protoArtifact.name), asc(protoVersion.version));
  return rows.map((r) => ({
    repositoryId: r.repositoryId,
    repository: r.repository,
    visibility: r.visibility,
    coordinate: { group: r.group, name: r.name, version: r.version },
  }));
}

/**
 * Allows removing or replacing a version only when nothing depends on it, or when an admin forces
 * it. Throws `has_dependents` without `force`, and `forbidden` when a non-admin forces. The error
 * lists only the dependents the caller can read; the others are counted in `hiddenDependents`.
 * Returns whether the action is forced past existing dependents.
 */
export function assertNoDependents(
  p: Principal,
  c: Coordinate,
  dependents: DependentRow[],
  force: boolean | undefined,
): boolean {
  if (dependents.length === 0) return false;
  if (!force) {
    const visible = dependents
      .filter((d) => canAccess(p, { id: d.repositoryId, name: d.repository, visibility: d.visibility }, d.coordinate.group, "read"))
      .map(({ repository: repo, coordinate }) => ({ repository: repo, coordinate }));
    throw new RegistryError(
      "has_dependents",
      `${formatCoordinate(c)} is depended on by ${dependents.length} version(s)`,
      { dependents: visible, hiddenDependents: dependents.length - visible.length },
    );
  }
  if (!canForce(p)) throw new RegistryError("forbidden", "Only admins can force past dependents");
  return true;
}

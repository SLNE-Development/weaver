import { and, desc, eq, sql } from "drizzle-orm";
import { component, protoArtifact, protoBuild, protoDeletedRelease, protoVersion } from "@weaver/db";
import { recordAudit } from "../audit.js";
import { formatCoordinate, type Coordinate } from "../coordinates.js";
import { RegistryError } from "../errors.js";
import { canDeleteVersions, type Principal } from "../permissions.js";
import { deleteBlobLogged, versionLockKey, type BlobRef, type Queryable, type RegistryContext } from "./lookup.js";
import { assertNoDependents, findDependents, readableRepository } from "./read.js";

/** The rows identifying one version of an artifact. */
export interface VersionTarget {
  versionId: string;
  artifactId: string;
  repositoryId: string;
  coordinate: Coordinate;
  isSnapshot: boolean;
  updatedAt: Date;
}

/** Takes the transaction-scoped advisory lock that serializes every mutation of one version. */
export async function lockVersion(tx: Queryable, repositoryName: string, c: Coordinate): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${versionLockKey(repositoryName, c)}))`);
}

/** Deletes the `component` row of version `c` in the repository. */
async function deleteComponent(tx: Queryable, repositoryId: string, c: Coordinate): Promise<void> {
  await tx
    .delete(component)
    .where(
      and(
        eq(component.repositoryId, repositoryId),
        eq(component.namespace, c.group),
        eq(component.name, c.name),
        eq(component.version, c.version),
      ),
    );
}

/** Finds a version in a repository by coordinate; null when it does not exist. */
export async function findVersionTarget(
  db: Queryable,
  repositoryId: string,
  c: Coordinate,
): Promise<VersionTarget | null> {
  const [target] = await db
    .select({
      versionId: protoVersion.id,
      artifactId: protoArtifact.id,
      isSnapshot: protoVersion.isSnapshot,
      updatedAt: protoVersion.updatedAt,
    })
    .from(protoVersion)
    .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
    .where(
      and(
        eq(protoArtifact.repositoryId, repositoryId),
        eq(protoArtifact.group, c.group),
        eq(protoArtifact.name, c.name),
        eq(protoVersion.version, c.version),
      ),
    );
  if (!target) return null;
  return { ...target, repositoryId, coordinate: { group: c.group, name: c.name, version: c.version } };
}

/**
 * Deletes a version with all its builds, files, dependency edges and its `component` row, and the
 * artifact row once its last version is gone. Deleting a release records a {@link deletedRelease} tombstone with
 * the deleted archive's sha256, so a repository without redeploy only accepts it back unchanged.
 * Returns the blobs of the deleted builds; the caller removes them with
 * {@link deleteBlobLogged} after the transaction commits.
 */
export async function deleteVersionRows(tx: Queryable, target: VersionTarget): Promise<BlobRef[]> {
  const builds = await tx
    .select({ store: protoBuild.store, storageKey: protoBuild.storageKey, sha256: protoBuild.sha256 })
    .from(protoBuild)
    .where(eq(protoBuild.versionId, target.versionId))
    .orderBy(desc(protoBuild.buildNumber));
  const latest = builds[0];
  if (!target.isSnapshot && latest) {
    const { group, name, version: v } = target.coordinate;
    await tx
      .insert(protoDeletedRelease)
      .values({ repositoryId: target.repositoryId, group, name, version: v, sha256: latest.sha256 })
      .onConflictDoUpdate({
        target: [protoDeletedRelease.repositoryId, protoDeletedRelease.group, protoDeletedRelease.name, protoDeletedRelease.version],
        set: { sha256: latest.sha256, deletedAt: new Date() },
      });
  }
  await tx.delete(protoVersion).where(eq(protoVersion.id, target.versionId));
  await deleteComponent(tx, target.repositoryId, target.coordinate);
  const [remaining] = await tx
    .select({ id: protoVersion.id })
    .from(protoVersion)
    .where(eq(protoVersion.artifactId, target.artifactId))
    .limit(1);
  if (!remaining) await tx.delete(protoArtifact).where(eq(protoArtifact.id, target.artifactId));
  return builds.map(({ store, storageKey }) => ({ store, storageKey }));
}

/**
 * Deletes one build (with its files and dependency edges) of a version, and the version's
 * `component` row once no build remains. Returns its blob for removal after commit, or null when
 * the build does not exist.
 */
export async function deleteBuildRow(tx: Queryable, versionId: string, buildNumber: number): Promise<BlobRef | null> {
  const [deleted] = await tx
    .delete(protoBuild)
    .where(and(eq(protoBuild.versionId, versionId), eq(protoBuild.buildNumber, buildNumber)))
    .returning({ store: protoBuild.store, storageKey: protoBuild.storageKey });
  if (!deleted) return null;
  const [remaining] = await tx.select({ id: protoBuild.id }).from(protoBuild).where(eq(protoBuild.versionId, versionId)).limit(1);
  if (!remaining) {
    const [version] = await tx
      .select({ repositoryId: protoArtifact.repositoryId, group: protoArtifact.group, name: protoArtifact.name, version: protoVersion.version })
      .from(protoVersion)
      .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
      .where(eq(protoVersion.id, versionId));
    if (version) await deleteComponent(tx, version.repositoryId, version);
  }
  return deleted;
}

/**
 * Deletes a version with all its builds, files and dependency edges, then removes the archive
 * blobs after commit. Blocked by dependents in any repository unless an admin passes `force`.
 * The artifact row goes too once its last version is gone. Mirrors and groups answer
 * `method_not_allowed`.
 */
export async function deleteVersion(
  ctx: RegistryContext,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (p.kind === "anonymous") throw new RegistryError("unauthorized", "Deleting requires authentication");
  const repo = await readableRepository(ctx.repos, p, repositoryName, c.group, "delete");
  if (!canDeleteVersions(p, repo, c.group)) {
    throw new RegistryError("forbidden", `Not allowed to delete versions of ${c.group} in ${repo.name}`);
  }

  const blobs = await ctx.db.transaction(async (tx) => {
    await lockVersion(tx, repo.name, c);
    const target = await findVersionTarget(tx, repo.id, c);
    if (!target) throw new RegistryError("not_found", `Version ${formatCoordinate(c)} was not found`);
    const dependents = await findDependents(tx, c);
    const forced = assertNoDependents(p, c, dependents, opts.force);

    const keys = await deleteVersionRows(tx, target);

    await recordAudit(tx, {
      actor: p,
      action: "delete",
      target: `${repo.name}/${formatCoordinate(c)}`,
      details: forced
        ? { builds: keys.length, dependents: dependents.map(({ repository, coordinate }) => ({ repository, coordinate })) }
        : { builds: keys.length },
      forced,
    });
    return keys;
  });

  await Promise.all(blobs.map((blob) => deleteBlobLogged(ctx.stores, blob)));
}

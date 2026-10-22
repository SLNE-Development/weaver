import { randomUUID } from "node:crypto";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import { component, protoArtifact, protoBuild, protoBuildFile, protoDeletedRelease, protoDependency, protoVersion } from "@weaver/db";
import { recordAudit } from "../audit.js";
import { extractArchive, sha256 } from "../archive.js";
import {
  formatCoordinate,
  isSnapshot,
  isValidGroup,
  isValidName,
  isValidVersion,
  parseCoordinate,
  type Coordinate,
} from "../coordinates.js";
import { RegistryError } from "../errors.js";
import { canAccess, type Principal } from "../permissions.js";
import type { Repo } from "../repos/service.js";
import { findPathCollisions, resolveGraph, type Resolution } from "../resolution.js";
import { putBuffer } from "../storage/index.js";
import {
  createLookup,
  deleteBlobLogged,
  findLatestBuild,
  loadFiles,
  hostedProtoConfig,
  publishSources,
  versionLockKey,
  type BlobRef,
  type BuildRow,
  type Queryable,
  type RegistryContext,
} from "./lookup.js";
import { assertNoDependents, findDependents, readableRepository, type Dependent } from "./read.js";

function isCoordinateString(s: string): boolean {
  try {
    parseCoordinate(s);
    return true;
  } catch {
    return false;
  }
}

/** The publish manifest: the artifact's coordinate and its declared direct dependencies. */
export const manifestSchema = z
  .object({
    group: z.string().refine(isValidGroup, "Invalid group"),
    name: z.string().refine(isValidName, "Invalid name"),
    version: z.string().refine(isValidVersion, "Invalid version"),
    dependencies: z.array(z.string().refine(isCoordinateString, "Expected group:name:version")),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.dependencies.forEach((dep, i) => {
      if (!isCoordinateString(dep)) return;
      const { group, name } = parseCoordinate(dep);
      const key = `${group}:${name}`;
      if (key === `${m.group}:${m.name}`) {
        ctx.addIssue({ code: "custom", path: ["dependencies", i], message: "An artifact cannot depend on itself" });
      } else if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["dependencies", i], message: `Duplicate dependency on ${key}` });
      }
      seen.add(key);
    });
  });

export type Manifest = z.infer<typeof manifestSchema>;

/** Input of {@link publish}. */
export interface PublishInput {
  repository: string;
  manifest: Manifest;
  archive: Buffer;
  force?: boolean;
}

/** Outcome of a successful publish. */
export interface PublishResult {
  coordinate: Coordinate;
  buildNumber: number;
  sha256: string;
  redeployed: boolean;
}

function validationFailed(message: string, details?: unknown): RegistryError {
  return new RegistryError("validation_failed", message, details);
}

function parseManifest(input: unknown): Manifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RegistryError("invalid_request", "Invalid manifest", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/** Matches the tombstone of a deleted release `c` in the repository `repositoryId`. */
function tombstoneOf(repositoryId: string, c: Coordinate) {
  return and(
    eq(protoDeletedRelease.repositoryId, repositoryId),
    eq(protoDeletedRelease.group, c.group),
    eq(protoDeletedRelease.name, c.name),
    eq(protoDeletedRelease.version, c.version),
  );
}

/**
 * Checks publishing a release over an existing or a deleted one. Over an existing release it
 * rejects as `immutable` unless the repository allows redeploy, and applies the dependents rule.
 * Over a deleted release (a tombstone) in a repository without redeploy, only content identical
 * to the deleted archive (`digest`) is accepted. Returns the build being replaced (null for
 * snapshots and new releases) and whether the replacement is forced.
 */
async function checkExistingRelease(
  db: Queryable,
  p: Principal,
  repo: Repo,
  c: Coordinate,
  digest: string,
  force: boolean | undefined,
): Promise<{ existing: BuildRow | null; forced: boolean; dependents: Dependent[] }> {
  const none = { existing: null, forced: false, dependents: [] };
  if (isSnapshot(c.version)) return none;
  const existing = await findLatestBuild(db, repo.id, c);
  if (!existing) {
    if (!hostedProtoConfig(repo).allowRedeploy) {
      const [tombstone] = await db
        .select({ sha256: protoDeletedRelease.sha256 })
        .from(protoDeletedRelease)
        .where(tombstoneOf(repo.id, c));
      if (tombstone && tombstone.sha256 !== digest) {
        throw new RegistryError(
          "immutable",
          `Release ${formatCoordinate(c)} was deleted; re-publishing is only allowed with identical content (or enable redeploy)`,
        );
      }
    }
    return none;
  }
  if (!hostedProtoConfig(repo).allowRedeploy) {
    throw new RegistryError("immutable", `${formatCoordinate(c)} already exists in ${repo.name} and releases are immutable`);
  }
  const dependents = await findDependents(db, c);
  const forced = assertNoDependents(p, c, dependents, force);
  return { existing, forced, dependents: dependents.map(({ repository, coordinate }) => ({ repository, coordinate })) };
}

/** Resolves the declared dependencies the way publishing does and rejects unusable graphs. */
async function resolveDependencies(
  ctx: RegistryContext,
  p: Principal,
  repo: Repo,
  c: Coordinate,
  declared: Coordinate[],
): Promise<{ resolution: Resolution; buildIds: Map<string, string> }> {
  if (!isSnapshot(c.version)) {
    const snapshot = declared.find((d) => isSnapshot(d.version));
    if (snapshot) throw validationFailed(`A release may not depend on snapshot ${formatCoordinate(snapshot)}`);
  }
  const sources = await publishSources(ctx.db, p, repo);
  const { lookup, buildIds } = createLookup(ctx.db, p, sources.repositories, sources.viaGroups);
  let resolution: Resolution;
  try {
    resolution = await resolveGraph(declared, lookup);
  } catch (error) {
    if (error instanceof RegistryError && error.code === "not_found") {
      const path = (error.details as { path?: string[] } | undefined)?.path ?? [];
      throw validationFailed(`Dependency not found: ${path.at(-1) ?? error.message}`, { path });
    }
    throw error;
  }
  for (const node of resolution.nodes) {
    if (node.coordinate.group === c.group && node.coordinate.name === c.name) {
      throw validationFailed(`${c.group}:${c.name} depends on itself through ${formatCoordinate(node.coordinate)}`);
    }
    if (!isSnapshot(c.version) && isSnapshot(node.coordinate.version)) {
      throw validationFailed(`A release may not depend on snapshot ${formatCoordinate(node.coordinate)}`);
    }
  }
  return { resolution, buildIds };
}

/**
 * Publishes an archive: checks permissions and the manifest, validates the protos against the
 * resolved dependencies, stores the blob, then records the build in one transaction serialized
 * per version by an advisory lock, upserting the version's `component` row. A redeploy replaces
 * build 1 and drops the old blob afterwards.
 */
export async function publish(ctx: RegistryContext, p: Principal, input: PublishInput): Promise<PublishResult> {
  if (p.kind === "anonymous") throw new RegistryError("unauthorized", "Publishing requires an API key");
  const manifest = parseManifest(input.manifest);
  const c: Coordinate = { group: manifest.group, name: manifest.name, version: manifest.version };
  // Unreadable repositories look missing, so publishing never discloses that one exists; a
  // readable mirror or group answers method_not_allowed before the write check.
  const repo = await readableRepository(ctx.repos, p, input.repository, c.group, "publish");
  if (!canAccess(p, repo, c.group, "write")) {
    throw new RegistryError("forbidden", `No write access to ${c.group} in ${repo.name}`);
  }
  const snapshot = isSnapshot(c.version);
  const settings = hostedProtoConfig(repo);
  if (snapshot && !settings.allowSnapshots) {
    throw new RegistryError("invalid_request", `Repository ${repo.name} does not accept snapshots`);
  }
  if (!snapshot && !settings.allowReleases) {
    throw new RegistryError("invalid_request", `Repository ${repo.name} does not accept releases`);
  }

  const files = await extractArchive(input.archive);
  if (files.length === 0) throw new RegistryError("invalid_request", "The archive contains no .proto files");
  const digest = sha256(input.archive);
  await checkExistingRelease(ctx.db, p, repo, c, digest, input.force);

  const declared = manifest.dependencies.map(parseCoordinate);
  const { resolution, buildIds } = await resolveDependencies(ctx, p, repo, c, declared);
  const depBuildIds = resolution.nodes.map((n) => buildIds.get(formatCoordinate(n.coordinate)) as string);
  const depFiles = await loadFiles(ctx.db, depBuildIds);

  const collisions = findPathCollisions([
    { coordinate: c, paths: files.map((f) => f.path) },
    ...resolution.nodes.map((n, i) => ({
      coordinate: n.coordinate,
      paths: (depFiles.get(depBuildIds[i] as string) ?? []).map((f) => f.path),
    })),
  ]);
  if (collisions.length > 0) {
    throw validationFailed(`${collisions.length} file path(s) are provided by more than one artifact`, { collisions });
  }
  const issues = await ctx.validate({ files, dependencyFiles: [...depFiles.values()].flat() });
  if (issues.length > 0) throw validationFailed("Proto validation failed", { issues });

  const storageKey = `${repo.name}/${c.group}/${c.name}/${c.version}/${randomUUID()}.tar.gz`;
  const blob: BlobRef = { store: ctx.stores.primary.id, storageKey };
  await putBuffer(ctx.stores.primary, storageKey, input.archive);

  let outcome: { buildNumber: number; replaced: BuildRow | null };
  try {
    outcome = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${versionLockKey(repo.name, c)}))`);
      // Hold every dependency still while this build commits, and make sure none vanished meanwhile.
      for (const node of resolution.nodes) {
        const key = versionLockKey(node.repository, node.coordinate);
        await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${key}))`);
      }
      if (depBuildIds.length > 0) {
        const present = await tx.select({ id: protoBuild.id }).from(protoBuild).where(inArray(protoBuild.id, depBuildIds));
        if (present.length !== depBuildIds.length) {
          throw validationFailed("A dependency was removed or replaced during publishing; retry");
        }
      }
      const { existing, forced, dependents } = await checkExistingRelease(tx, p, repo, c, digest, input.force);
      // The release exists again; deleting it later records a fresh tombstone.
      if (!snapshot) await tx.delete(protoDeletedRelease).where(tombstoneOf(repo.id, c));

      const [art] = await tx
        .insert(protoArtifact)
        .values({ repositoryId: repo.id, group: c.group, name: c.name })
        .onConflictDoUpdate({
          target: [protoArtifact.repositoryId, protoArtifact.group, protoArtifact.name],
          set: { name: sql`excluded.name` },
        })
        .returning({ id: protoArtifact.id });
      const now = new Date();
      const [ver] = await tx
        .insert(protoVersion)
        .values({ artifactId: art!.id, version: c.version, isSnapshot: snapshot })
        .onConflictDoUpdate({ target: [protoVersion.artifactId, protoVersion.version], set: { updatedAt: now } })
        .returning({ id: protoVersion.id });
      const versionId = ver!.id;
      // The version's component makes it searchable and carries its download count.
      await tx
        .insert(component)
        .values({ repositoryId: repo.id, namespace: c.group, name: c.name, version: c.version })
        .onConflictDoUpdate({
          target: [component.repositoryId, component.namespace, component.name, component.version],
          set: { updatedAt: now },
        });

      let buildNumber = 1;
      if (existing) {
        await tx.delete(protoBuild).where(eq(protoBuild.id, existing.id));
      } else if (snapshot) {
        const [row] = await tx
          .select({ highest: max(protoBuild.buildNumber) })
          .from(protoBuild)
          .where(eq(protoBuild.versionId, versionId));
        buildNumber = (row?.highest ?? 0) + 1;
      }

      const [created] = await tx
        .insert(protoBuild)
        .values({
          versionId,
          buildNumber,
          store: blob.store,
          storageKey,
          sha256: digest,
          sizeBytes: input.archive.length,
          publishedByUserId: p.userId,
          publishedByKeyId: p.kind === "apikey" ? p.keyId : null,
        })
        .returning({ id: protoBuild.id });
      const buildId = created!.id;
      await tx.insert(protoBuildFile).values(files.map((f) => ({ buildId, path: f.path, content: f.content })));
      if (declared.length > 0) {
        await tx
          .insert(protoDependency)
          .values(declared.map((d) => ({ buildId, depGroup: d.group, depName: d.name, depVersion: d.version })));
      }
      await recordAudit(tx, {
        actor: p,
        action: existing ? "redeploy" : "publish",
        target: `${repo.name}/${formatCoordinate(c)}`,
        details: forced ? { buildNumber, sha256: digest, dependents } : { buildNumber, sha256: digest },
        forced,
      });
      return { buildNumber, replaced: existing };
    });
  } catch (error) {
    await deleteBlobLogged(ctx.stores, blob);
    throw error;
  }

  if (outcome.replaced) {
    // The new build is committed; a failure here only leaves an orphaned blob behind.
    await deleteBlobLogged(ctx.stores, outcome.replaced);
  }
  return { coordinate: c, buildNumber: outcome.buildNumber, sha256: digest, redeployed: outcome.replaced !== null };
}

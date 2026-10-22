import { asc, eq, inArray, max } from "drizzle-orm";
import { protoArtifact, protoBuild, protoVersion, type Db } from "@weaver/db";
import { recordAudit } from "../audit.js";
import { formatCoordinate, type Coordinate } from "../coordinates.js";
import { groupMatches } from "../permissions.js";
import { deleteBuildRow, deleteVersionRows, findVersionTarget, lockVersion } from "../registry/delete.js";
import { deleteBlobLogged, type BlobRef } from "../registry/lookup.js";
import { findDependents, type Dependent } from "../registry/read.js";
import type { Repo } from "../repos/service.js";
import type { StoreSet } from "../storage/index.js";
import type { CleanupCandidate, CleanupPolicyRow, FormatCleanup } from "./types.js";

const DAY_MS = 86_400_000;

/** The repository fields the proto cleanup needs. */
type ProtoRepo = Pick<Repo, "id" | "name">;

/** One thing a proto cleanup deletes: a single snapshot build, or a whole version when `buildNumber` is null. */
interface ProtoCandidate {
  repository: string;
  coordinate: Coordinate;
  /** null = the whole version. */
  buildNumber: number | null;
  reason: string;
}

interface VersionRow {
  versionId: string;
  coordinate: Coordinate;
  isSnapshot: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastDownloadedAt: Date | null;
}

/** A candidate plus the row state it was planned against, re-checked under the version lock. */
interface PlannedCandidate extends ProtoCandidate {
  updatedAt: Date;
}

const coordinateKey = (c: Coordinate) => formatCoordinate(c);

function compareCandidates(a: ProtoCandidate, b: ProtoCandidate): number {
  const byCoordinate = coordinateKey(a.coordinate).localeCompare(coordinateKey(b.coordinate));
  if (byCoordinate !== 0) return byCoordinate;
  return (a.buildNumber ?? Number.MAX_SAFE_INTEGER) - (b.buildNumber ?? Number.MAX_SAFE_INTEGER);
}

async function loadVersions(db: Db, repositoryId: string): Promise<VersionRow[]> {
  const rows = await db
    .select({
      versionId: protoVersion.id,
      group: protoArtifact.group,
      name: protoArtifact.name,
      version: protoVersion.version,
      isSnapshot: protoVersion.isSnapshot,
      createdAt: protoVersion.createdAt,
      updatedAt: protoVersion.updatedAt,
      lastDownloadedAt: max(protoBuild.lastDownloadedAt),
    })
    .from(protoVersion)
    .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
    .leftJoin(protoBuild, eq(protoBuild.versionId, protoVersion.id))
    .where(eq(protoArtifact.repositoryId, repositoryId))
    .groupBy(protoVersion.id, protoArtifact.group, protoArtifact.name);
  return rows.map((r) => ({
    versionId: r.versionId,
    coordinate: { group: r.group, name: r.name, version: r.version },
    isSnapshot: r.isSnapshot,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastDownloadedAt: r.lastDownloadedAt,
  }));
}

/** Build numbers of the given versions, newest first, keyed by version id. */
async function loadBuildNumbers(db: Db, versionIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (versionIds.length === 0) return out;
  const rows = await db
    .select({ versionId: protoBuild.versionId, buildNumber: protoBuild.buildNumber })
    .from(protoBuild)
    .where(inArray(protoBuild.versionId, versionIds))
    .orderBy(asc(protoBuild.versionId), asc(protoBuild.buildNumber));
  for (const r of rows) {
    const list = out.get(r.versionId) ?? [];
    list.unshift(r.buildNumber);
    out.set(r.versionId, list);
  }
  return out;
}

/** Days-based rules use at least one day, so a misconfigured 0 never sweeps everything. */
const cutoff = (now: Date, days: number) => new Date(now.getTime() - Math.max(1, days) * DAY_MS);

/** Whole versions a single days-based rule targets, with the rule's reason. Releases only via an explicit `includeReleases`. */
function wholeVersionTargets(policy: CleanupPolicyRow, versions: VersionRow[], now: Date): { v: VersionRow; reason: string }[] {
  const before = cutoff(now, policy.value);
  switch (policy.kind) {
    case "delete_stale_snapshots":
      return versions
        .filter((v) => v.isSnapshot && v.updatedAt < before)
        .map((v) => ({ v, reason: `snapshot not published for ${policy.value} days` }));
    case "delete_not_downloaded":
      return versions
        .filter((v) => (v.isSnapshot || policy.includeReleases) && (v.lastDownloadedAt ?? v.createdAt) < before)
        .map((v) => ({ v, reason: `not downloaded for ${policy.value} days` }));
    case "keep_last_snapshot_builds":
      // Plans single builds, not whole versions; see planFor.
      return [];
    case "keep_last_versions":
    case "delete_untagged_manifests":
    case "keep_last_tags":
      // npm and docker kinds; the policy API never stores them on a proto repository.
      return [];
    default: {
      const unknown: never = policy.kind;
      throw new Error(`Unknown cleanup kind ${String(unknown)}`);
    }
  }
}

/**
 * Drops whole-version candidates that a retained version (any repository) depends on, repeating
 * until stable, since dropping one candidate retains it and may protect its own dependencies.
 */
async function excludeDepended(
  db: Db,
  repo: ProtoRepo,
  wholes: Map<string, PlannedCandidate>,
): Promise<void> {
  const dependentsOf = new Map<string, Dependent[]>();
  for (const [key, candidate] of wholes) dependentsOf.set(key, await findDependents(db, candidate.coordinate));
  const isRetained = (d: Dependent) => d.repository !== repo.name || !wholes.has(coordinateKey(d.coordinate));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, dependents] of dependentsOf) {
      if (!wholes.has(key)) continue;
      if (dependents.some(isRetained)) {
        wholes.delete(key);
        changed = true;
      }
    }
  }
}

/**
 * What `policies` would delete at `now`. Releases are only planned by a `delete_not_downloaded` rule
 * with `includeReleases`; the newest build of a snapshot is never planned on its own; and a version
 * that a retained version in any repository depends on is never planned.
 */
async function planFor(db: Db, repo: ProtoRepo, policies: CleanupPolicyRow[], now: Date): Promise<PlannedCandidate[]> {
  if (policies.length === 0) return [];

  const versions = await loadVersions(db, repo.id);
  const inScope = (p: CleanupPolicyRow) => versions.filter((v) => groupMatches(p.groupPrefix, v.coordinate.group));

  const wholes = new Map<string, PlannedCandidate>();
  for (const policy of policies) {
    for (const { v, reason } of wholeVersionTargets(policy, inScope(policy), now)) {
      const key = coordinateKey(v.coordinate);
      if (wholes.has(key)) continue;
      wholes.set(key, { repository: repo.name, coordinate: v.coordinate, buildNumber: null, reason, updatedAt: v.updatedAt });
    }
  }
  await excludeDepended(db, repo, wholes);

  const builds: PlannedCandidate[] = [];
  const seenBuilds = new Set<string>();
  const keepRules = policies.filter((p) => p.kind === "keep_last_snapshot_builds");
  if (keepRules.length > 0) {
    const snapshots = versions.filter((v) => v.isSnapshot);
    const numbers = await loadBuildNumbers(db, snapshots.map((v) => v.versionId));
    for (const policy of keepRules) {
      const keep = Math.max(1, policy.value);
      for (const v of inScope(policy).filter((x) => x.isSnapshot)) {
        if (wholes.has(coordinateKey(v.coordinate))) continue;
        for (const buildNumber of (numbers.get(v.versionId) ?? []).slice(keep)) {
          const key = `${coordinateKey(v.coordinate)}#${buildNumber}`;
          if (seenBuilds.has(key)) continue;
          seenBuilds.add(key);
          builds.push({
            repository: repo.name,
            coordinate: v.coordinate,
            buildNumber,
            reason: `keep last ${keep} snapshot builds`,
            updatedAt: v.updatedAt,
          });
        }
      }
    }
  }
  return [...wholes.values(), ...builds].sort(compareCandidates);
}

/**
 * Deletes one planned candidate under its version lock, re-checking that the version was not
 * published again since planning and, for whole versions, that nothing depends on it now.
 * Returns the blobs to remove after commit, or null when the candidate was skipped.
 */
async function applyOne(db: Db, repo: ProtoRepo, candidate: PlannedCandidate): Promise<BlobRef[] | null> {
  return db.transaction(async (tx) => {
    await lockVersion(tx, repo.name, candidate.coordinate);
    const target = await findVersionTarget(tx, repo.id, candidate.coordinate);
    if (!target || target.updatedAt.getTime() !== candidate.updatedAt.getTime()) return null;

    let keys: BlobRef[];
    if (candidate.buildNumber === null) {
      if ((await findDependents(tx, candidate.coordinate)).length > 0) return null;
      keys = await deleteVersionRows(tx, target);
    } else {
      const key = await deleteBuildRow(tx, target.versionId, candidate.buildNumber);
      if (key === null) return null;
      keys = [key];
    }
    const suffix = candidate.buildNumber === null ? "" : `#${candidate.buildNumber}`;
    await recordAudit(tx, {
      actor: "system",
      action: "cleanup.delete",
      target: `${repo.name}/${formatCoordinate(candidate.coordinate)}${suffix}`,
      details: { reason: candidate.reason, buildNumber: candidate.buildNumber, builds: keys.length },
    });
    return keys;
  });
}

/**
 * Plans as {@link planFor}, then deletes each candidate in its own transaction (rows, then blobs
 * after commit) with a `cleanup.delete` audit entry by the system. Dependents are deleted before
 * what they depend on; a candidate that changed since planning is skipped. Returns the candidates
 * actually deleted.
 */
async function applyFor(
  db: Db,
  stores: StoreSet,
  repo: ProtoRepo,
  policies: CleanupPolicyRow[],
  now: Date,
): Promise<PlannedCandidate[]> {
  const applied: PlannedCandidate[] = [];
  // Whole versions blocked only by another candidate become deletable once that one is gone,
  // so retry them while each pass makes progress.
  let pending = await planFor(db, repo, policies, now);
  while (pending.length > 0) {
    const retry: PlannedCandidate[] = [];
    for (const candidate of pending) {
      const keys = await applyOne(db, repo, candidate);
      if (keys === null) {
        if (candidate.buildNumber === null) retry.push(candidate);
        continue;
      }
      applied.push(candidate);
      await Promise.all(keys.map((blob) => deleteBlobLogged(stores, blob)));
    }
    if (retry.length === pending.length) break;
    pending = retry;
  }
  return applied.sort(compareCandidates);
}

/** A proto candidate as the runner reports it: key `proto:<coordinate>#<build|all>`, label `<coordinate>[ build <n>]`. */
function toCleanupCandidate({ repository, coordinate, buildNumber, reason }: ProtoCandidate): CleanupCandidate {
  const text = formatCoordinate(coordinate);
  return {
    repository,
    key: `proto:${text}#${buildNumber ?? "all"}`,
    label: buildNumber === null ? text : `${text} build ${buildNumber}`,
    reason,
  };
}

/**
 * The proto cleanup: `keep_last_snapshot_builds` deletes single snapshot builds, and
 * `delete_stale_snapshots` / `delete_not_downloaded` delete whole versions (releases only with
 * `includeReleases`), never one that a retained version in any repository depends on. When not a
 * dry run, each deletion re-checks under the version lock that the version was not published again
 * and gained no dependent since planning, and is audited as `cleanup.delete`.
 */
export const protoCleanup: FormatCleanup = {
  format: "proto",
  async run(deps, repo, policies, now, opts) {
    const candidates = opts.dryRun
      ? await planFor(deps.db, repo, policies, now)
      : await applyFor(deps.db, deps.stores, repo, policies, now);
    return candidates.map(toCleanupCandidate);
  },
};

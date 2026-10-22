import { and, eq, sql } from "drizzle-orm";
import {
  recordAudit,
  type AssetRow,
  type CleanupCandidate,
  type CleanupDeps,
  type CleanupPolicyRow,
  type FormatCleanup,
  type Repo,
} from "@weaver/core";
import { asset, component, type Db, type Tx } from "@weaver/db";
import { lockMavenArtifact } from "./hosted.js";
import { classifyStoredPath, type SnapshotStamp } from "./path.js";

const DAY_MS = 86_400_000;
const SNAPSHOT_SUFFIX = "-SNAPSHOT";

/** The repository fields the maven cleanup needs. */
type MavenRepo = Pick<Repo, "id" | "name">;

/** One hosted file of a version, with the snapshot build it belongs to (null for release and non-timestamped files). */
interface VersionFile {
  asset: AssetRow;
  buildNumber: number | null;
  /** When the file was last deployed; see {@link deployedAt}. */
  deployedAt: Date;
}

/** A hosted version (one component) with its files and the times the rules look at. */
interface VersionState {
  componentId: string;
  groupId: string;
  artifactId: string;
  version: string;
  isSnapshot: boolean;
  createdAt: Date;
  lastDownloadedAt: Date | null;
  /** When a file was last deployed to the version: the newest {@link VersionFile.deployedAt}. */
  lastPublishedAt: Date;
  files: VersionFile[];
}

/** One thing the maven cleanup deletes: one snapshot build, or a whole version when `buildNumber` is null. */
interface MavenCandidate {
  repository: string;
  groupId: string;
  artifactId: string;
  version: string;
  /** null = the whole version. */
  buildNumber: number | null;
  reason: string;
}

const coordinateOf = (c: { groupId: string; artifactId: string; version: string }) => `${c.groupId}:${c.artifactId}:${c.version}`;
const artifactOf = (c: { groupId: string; artifactId: string }) => `${c.groupId}:${c.artifactId}`;
const candidateKey = (c: MavenCandidate) => `maven:${coordinateOf(c)}#${c.buildNumber ?? "all"}`;

function compareCandidates(a: MavenCandidate, b: MavenCandidate): number {
  const byCoordinate = coordinateOf(a).localeCompare(coordinateOf(b));
  if (byCoordinate !== 0) return byCoordinate;
  return (a.buildNumber ?? Number.MAX_SAFE_INTEGER) - (b.buildNumber ?? Number.MAX_SAFE_INTEGER);
}

/** Days-based rules use at least one day, so a misconfigured 0 never sweeps everything. */
const cutoff = (now: Date, days: number) => new Date(now.getTime() - Math.max(1, days) * DAY_MS);

/** Whether a policy scoped to `prefix` (a plain groupId prefix; null = everything) covers `groupId`. */
const inScope = (prefix: string | null, groupId: string) => prefix === null || groupId.startsWith(prefix);

/** The stamp in a stored file name, or null when the file is not a timestamped snapshot file. */
function stampOf(path: string): SnapshotStamp | null {
  const parsed = classifyStoredPath(path);
  return parsed.type === "file" && parsed.snapshot ? parsed.stamp : null;
}

/** A Maven `yyyyMMdd.HHmmss` UTC timestamp as a date, or null when it is not a valid time. */
function parseMavenTimestamp(text: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * When a file was last deployed. A timestamped snapshot file is deployed once under its unique
 * name, so its stamp tells; for any other file the newer of `createdAt` and `updatedAt`, because a
 * file re-deployed in place (e.g. `lib-1.0-SNAPSHOT.jar`) keeps its row and only `updatedAt`
 * moves. `updatedAt` also moves on downloads, which can only keep a version longer, never shorter.
 */
function deployedAt(a: AssetRow, stamp: SnapshotStamp | null): Date {
  const stamped = stamp === null ? null : parseMavenTimestamp(stamp.timestamp);
  if (stamped) return stamped;
  return a.updatedAt > a.createdAt ? a.updatedAt : a.createdAt;
}

/**
 * The hosted versions of the repository with their hosted files, optionally only those of one
 * artifact. Cache content is never loaded, so it can never be planned.
 */
async function loadVersions(q: Db | Tx, repositoryId: string, artifact?: { groupId: string; artifactId: string }): Promise<VersionState[]> {
  const conditions = [eq(component.repositoryId, repositoryId), eq(asset.origin, "hosted")];
  if (artifact) conditions.push(eq(component.namespace, artifact.groupId), eq(component.name, artifact.artifactId));
  const rows = await q
    .select({ component, asset })
    .from(asset)
    .innerJoin(component, eq(component.id, asset.componentId))
    .where(and(...conditions));

  const byComponent = new Map<string, VersionState>();
  for (const { component: c, asset: a } of rows) {
    let state = byComponent.get(c.id);
    if (!state) {
      state = {
        componentId: c.id,
        groupId: c.namespace,
        artifactId: c.name,
        version: c.version,
        isSnapshot: c.version.endsWith(SNAPSHOT_SUFFIX),
        createdAt: c.createdAt,
        lastDownloadedAt: c.lastDownloadedAt,
        lastPublishedAt: new Date(0),
        files: [],
      };
      byComponent.set(c.id, state);
    }
    const stamp = state.isSnapshot ? stampOf(a.path) : null;
    const file: VersionFile = { asset: a, buildNumber: stamp?.buildNumber ?? null, deployedAt: deployedAt(a, stamp) };
    if (file.deployedAt > state.lastPublishedAt) state.lastPublishedAt = file.deployedAt;
    state.files.push(file);
  }
  return [...byComponent.values()];
}

/** Whole versions a single days-based rule targets, with the rule's reason. Releases only via an explicit `includeReleases`. */
function wholeVersionTargets(policy: CleanupPolicyRow, versions: VersionState[], now: Date): { v: VersionState; reason: string }[] {
  const before = cutoff(now, policy.value);
  switch (policy.kind) {
    case "delete_stale_snapshots":
      return versions
        .filter((v) => v.isSnapshot && v.lastPublishedAt < before)
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
      // npm and docker kinds; the policy API never stores them on a maven repository.
      return [];
    default: {
      const unknown: never = policy.kind;
      throw new Error(`Unknown cleanup kind ${String(unknown)}`);
    }
  }
}

/**
 * What `policies` would delete from `versions` at `now`: whole versions for the days-based rules
 * (releases only with `includeReleases`), and the builds of each snapshot beyond the newest N for
 * `keep_last_snapshot_builds` (the newest build is always kept).
 */
function planFor(repo: MavenRepo, versions: VersionState[], policies: CleanupPolicyRow[], now: Date): MavenCandidate[] {
  const scoped = (p: CleanupPolicyRow) => versions.filter((v) => inScope(p.groupPrefix, v.groupId));
  const candidate = (v: VersionState, buildNumber: number | null, reason: string): MavenCandidate => ({
    repository: repo.name,
    groupId: v.groupId,
    artifactId: v.artifactId,
    version: v.version,
    buildNumber,
    reason,
  });

  const wholes = new Map<string, MavenCandidate>();
  for (const policy of policies) {
    for (const { v, reason } of wholeVersionTargets(policy, scoped(policy), now)) {
      if (!wholes.has(v.componentId)) wholes.set(v.componentId, candidate(v, null, reason));
    }
  }

  const builds = new Map<string, MavenCandidate>();
  for (const policy of policies.filter((p) => p.kind === "keep_last_snapshot_builds")) {
    const keep = Math.max(1, policy.value);
    for (const v of scoped(policy)) {
      if (!v.isSnapshot || wholes.has(v.componentId)) continue;
      const numbers = [...new Set(v.files.flatMap((f) => (f.buildNumber === null ? [] : [f.buildNumber])))].sort((a, b) => b - a);
      for (const buildNumber of numbers.slice(keep)) {
        const c = candidate(v, buildNumber, `keep last ${keep} snapshot builds`);
        if (!builds.has(candidateKey(c))) builds.set(candidateKey(c), c);
      }
    }
  }
  return [...wholes.values(), ...builds.values()].sort(compareCandidates);
}

/**
 * Deletes the planned candidates of one artifact under its advisory lock (held by publishing too).
 * The artifact is planned again under the lock and only candidates still planned are deleted, so a
 * version published to or downloaded since planning is kept. Files go through the asset service, a
 * component left without files is deleted, and each deletion is audited as `cleanup.delete`.
 * Returns the candidates deleted.
 */
async function applyArtifact(
  deps: CleanupDeps,
  repo: MavenRepo,
  artifact: { groupId: string; artifactId: string },
  planned: MavenCandidate[],
  policies: CleanupPolicyRow[],
  now: Date,
): Promise<MavenCandidate[]> {
  return deps.db.transaction(async (tx) => {
    await lockMavenArtifact(tx, repo.id, artifact.groupId, artifact.artifactId);
    const versions = await loadVersions(tx, repo.id, artifact);
    const still = new Set(planFor(repo, versions, policies, now).map(candidateKey));
    const byCoordinate = new Map(versions.map((v) => [coordinateOf(v), v]));

    const deleted: MavenCandidate[] = [];
    for (const candidate of planned) {
      const v = byCoordinate.get(coordinateOf(candidate));
      if (!v || !still.has(candidateKey(candidate))) continue;
      const files = v.files.filter((f) => candidate.buildNumber === null || f.buildNumber === candidate.buildNumber);
      for (const file of files) await deps.assets.delete(file.asset);
      v.files = v.files.filter((f) => !files.includes(f));
      if (v.files.length === 0) {
        await tx
          .delete(component)
          .where(and(eq(component.id, v.componentId), sql`NOT EXISTS (SELECT 1 FROM ${asset} WHERE ${asset.componentId} = ${component.id})`));
      }
      const suffix = candidate.buildNumber === null ? "" : `#${candidate.buildNumber}`;
      await recordAudit(tx, {
        actor: "system",
        action: "cleanup.delete",
        target: `${repo.name}/${coordinateOf(candidate)}${suffix}`,
        details: { reason: candidate.reason, buildNumber: candidate.buildNumber, files: files.length },
      });
      deleted.push(candidate);
    }
    return deleted;
  });
}

/** Plans as {@link planFor}, then deletes artifact by artifact with {@link applyArtifact}; returns what was deleted. */
async function applyFor(deps: CleanupDeps, repo: MavenRepo, policies: CleanupPolicyRow[], now: Date): Promise<MavenCandidate[]> {
  const planned = planFor(repo, await loadVersions(deps.db, repo.id), policies, now);
  const byArtifact = new Map<string, MavenCandidate[]>();
  for (const c of planned) byArtifact.set(artifactOf(c), [...(byArtifact.get(artifactOf(c)) ?? []), c]);

  const deleted: MavenCandidate[] = [];
  for (const candidates of byArtifact.values()) {
    const { groupId, artifactId } = candidates[0]!;
    deleted.push(...(await applyArtifact(deps, repo, { groupId, artifactId }, candidates, policies, now)));
  }
  return deleted.sort(compareCandidates);
}

/** A maven candidate as the runner reports it: key `maven:<g>:<a>:<v>#<build|all>`, label `<g>:<a>:<v>[ build <n>]`. */
function toCleanupCandidate(c: MavenCandidate): CleanupCandidate {
  const text = coordinateOf(c);
  return {
    repository: c.repository,
    key: candidateKey(c),
    label: c.buildNumber === null ? text : `${text} build ${c.buildNumber}`,
    reason: c.reason,
  };
}

/**
 * The maven cleanup of hosted repositories: `keep_last_snapshot_builds` deletes every file of the
 * older timestamped builds of a `-SNAPSHOT` version (checksums and signatures included), and
 * `delete_stale_snapshots` / `delete_not_downloaded` delete whole versions (releases only with
 * `includeReleases`). `groupPrefix` is a plain groupId prefix. Generated `maven-metadata.xml`
 * follows the remaining files and components, so nothing else needs rewriting. Cache content of
 * mirrors is never touched.
 */
export const mavenCleanup: FormatCleanup = {
  format: "maven",
  async run(deps, repo, policies, now, opts) {
    const candidates = opts.dryRun
      ? planFor(repo, await loadVersions(deps.db, repo.id), policies, now)
      : await applyFor(deps, repo, policies, now);
    return candidates.map(toCleanupCandidate);
  },
};

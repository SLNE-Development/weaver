import { and, eq, inArray } from "drizzle-orm";
import {
  recordAudit,
  type AssetRow,
  type CleanupCandidate,
  type CleanupDeps,
  type CleanupPolicyRow,
  type FormatCleanup,
  type Repo,
  type StoreSet,
} from "@weaver/core";
import { asset, component, npmPackage, type Db, type Tx } from "@weaver/db";
import { compareSemver } from "./semver.js";
import type { Packument } from "./packument.js";
import { createNpmStore, type DbOrTx, type NpmStore } from "./store.js";

const DAY_MS = 86_400_000;

/** One published version of a package with the times the rules look at. */
interface VersionState {
  version: string;
  /** Publish time: the component's creation. */
  createdAt: Date;
  lastDownloadedAt: Date | null;
}

/** One version the npm cleanup deletes. */
interface NpmCandidate {
  repository: string;
  /** Full package name, `@scope/name` or `name`. */
  pkg: string;
  version: string;
  reason: string;
}

/** The component `namespace` (the scope without `@`, as publish stores it; "" when unscoped) and bare `name` of a full package name. */
function splitName(full: string): { namespace: string; name: string } {
  if (!full.startsWith("@")) return { namespace: "", name: full };
  const slash = full.indexOf("/");
  return { namespace: full.slice(1, slash), name: full.slice(slash + 1) };
}

const candidateKey = (c: NpmCandidate) => `npm:${c.pkg}@${c.version}`;

function compareCandidates(a: NpmCandidate, b: NpmCandidate): number {
  return a.pkg.localeCompare(b.pkg) || compareSemver(a.version, b.version);
}

/** Days-based rules use at least one day, so a misconfigured 0 never sweeps everything. */
const cutoff = (now: Date, days: number) => new Date(now.getTime() - Math.max(1, days) * DAY_MS);

/** Whether a policy scoped to `prefix` (a plain prefix of the full package name, `@scope/name` or `name`; null = everything) covers `full`. */
const inScope = (prefix: string | null, full: string) => prefix === null || full.startsWith(prefix);

/** The hosted versions of one package that still have a packument entry, newest publish first (ties by semver). */
async function loadVersions(q: DbOrTx, repoId: string, full: string, doc: Packument): Promise<VersionState[]> {
  const { namespace, name } = splitName(full);
  const rows = await q
    .select({ version: component.version, createdAt: component.createdAt, lastDownloadedAt: component.lastDownloadedAt })
    .from(component)
    .where(and(eq(component.repositoryId, repoId), eq(component.namespace, namespace), eq(component.name, name)));
  const listed = doc.versions ?? {};
  return rows
    .filter((r) => Object.hasOwn(listed, r.version))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareSemver(b.version, a.version));
}

/** The versions every dist-tag points at; never deleted. */
function taggedVersions(doc: Packument): Set<string> {
  const tags = doc["dist-tags"] ?? {};
  return new Set(Object.values(tags).filter((v): v is string => typeof v === "string"));
}

/** What `policies` would delete from the `versions` of one package at `now`, never a dist-tagged version. */
function planPackage(
  repo: Pick<Repo, "name">,
  full: string,
  versions: VersionState[],
  doc: Packument,
  policies: CleanupPolicyRow[],
  now: Date,
): NpmCandidate[] {
  const protectedVersions = taggedVersions(doc);
  // The newest version always stays, so a package never ends up empty.
  if (versions[0]) protectedVersions.add(versions[0].version);
  const found = new Map<string, NpmCandidate>();
  const add = (v: VersionState, reason: string) => {
    if (protectedVersions.has(v.version) || found.has(v.version)) return;
    found.set(v.version, { repository: repo.name, pkg: full, version: v.version, reason });
  };
  for (const policy of policies) {
    if (!inScope(policy.groupPrefix, full)) continue;
    switch (policy.kind) {
      case "keep_last_versions": {
        const keep = Math.max(1, policy.value);
        for (const v of versions.slice(keep)) add(v, `keep last ${keep} versions`);
        break;
      }
      case "delete_not_downloaded": {
        const before = cutoff(now, policy.value);
        for (const v of versions) if ((v.lastDownloadedAt ?? v.createdAt) < before) add(v, `not downloaded for ${policy.value} days`);
        break;
      }
      case "keep_last_snapshot_builds":
      case "delete_stale_snapshots":
      case "delete_untagged_manifests":
      case "keep_last_tags":
        // Maven, proto and docker kinds; the policy API never stores them on an npm repository.
        break;
      default: {
        const unknown: never = policy.kind;
        throw new Error(`Unknown cleanup kind ${String(unknown)}`);
      }
    }
  }
  return [...found.values()];
}

/** Plans every package of the repository. */
async function planFor(db: Db, repo: Repo, policies: CleanupPolicyRow[], now: Date): Promise<NpmCandidate[]> {
  const packages = await db
    .select({ name: npmPackage.name, document: npmPackage.document })
    .from(npmPackage)
    .where(eq(npmPackage.repositoryId, repo.id));
  const planned: NpmCandidate[] = [];
  for (const { name, document } of packages) {
    const doc = document as Packument;
    planned.push(...planPackage(repo, name, await loadVersions(db, repo.id, name, doc), doc, policies, now));
  }
  return planned.sort(compareCandidates);
}

/** Deletes the stored objects of removed assets after the transaction committed; failures only leave orphans. */
async function deleteObjects(stores: StoreSet, rows: AssetRow[]): Promise<void> {
  for (const row of rows) {
    try {
      await stores.get(row.store)?.delete(row.storageKey);
    } catch (error) {
      console.warn(`weaver: failed to delete asset object ${row.storageKey}`, error);
    }
  }
}

/**
 * Deletes the planned versions of one package under its package lock (held by publishing too), all
 * database work on the lock's transaction. The package is planned again under the lock and only
 * versions still planned are deleted. Each version leaves the packument `versions` (its `time`
 * entry stays as tombstone), and its asset and component are deleted; objects go after commit.
 */
async function applyPackage(
  deps: CleanupDeps,
  store: NpmStore,
  repo: Repo,
  full: string,
  planned: NpmCandidate[],
  policies: CleanupPolicyRow[],
  now: Date,
): Promise<NpmCandidate[]> {
  const { namespace, name } = splitName(full);
  const result = await store.locked(repo.id, full, async (tx: Tx) => {
    const none = { deleted: [] as NpmCandidate[], rows: [] as AssetRow[] };
    const current = await store.get(repo.id, full, tx);
    if (!current) return none;
    const doc = structuredClone(current.document);
    const still = new Set(planPackage(repo, full, await loadVersions(tx, repo.id, full, doc), doc, policies, now).map(candidateKey));
    const deleted = planned.filter((c) => still.has(candidateKey(c)));
    if (deleted.length === 0) return none;

    const versions = deleted.map((c) => c.version);
    const components = await tx
      .select({ id: component.id })
      .from(component)
      .where(
        and(eq(component.repositoryId, repo.id), eq(component.namespace, namespace), eq(component.name, name), inArray(component.version, versions)),
      );
    const ids = components.map((c) => c.id);
    const rows = ids.length === 0 ? [] : ((await tx.select().from(asset).where(inArray(asset.componentId, ids))) as AssetRow[]);
    if (rows.length > 0) {
      await tx.delete(asset).where(
        inArray(
          asset.id,
          rows.map((r) => r.id),
        ),
      );
    }
    if (ids.length > 0) await tx.delete(component).where(inArray(component.id, ids));

    const listed = doc.versions ?? {};
    for (const v of versions) delete listed[v];
    const tags = doc["dist-tags"] ?? {};
    for (const [tag, target] of Object.entries(tags)) if (typeof target === "string" && versions.includes(target)) delete tags[tag];
    if (!Object.hasOwn(tags, "latest")) {
      const highest = Object.keys(listed).sort(compareSemver).at(-1);
      if (highest !== undefined) tags["latest"] = highest;
    }
    doc.versions = listed;
    doc["dist-tags"] = tags;
    doc.time = { ...(doc.time ?? {}), modified: now.toISOString() };
    await store.save(tx, repo.id, full, doc, current.rev);

    for (const c of deleted) {
      await recordAudit(tx, {
        actor: "system",
        action: "cleanup.delete",
        target: `${repo.name}/${full}@${c.version}`,
        details: { reason: c.reason },
      });
    }
    return { deleted, rows };
  });
  await deleteObjects(deps.stores, result.rows);
  return result.deleted;
}

/** Plans as {@link planFor}, then deletes package by package with {@link applyPackage}; returns what was deleted. */
async function applyFor(deps: CleanupDeps, repo: Repo, policies: CleanupPolicyRow[], now: Date): Promise<NpmCandidate[]> {
  const store = createNpmStore(deps.db);
  const byPackage = new Map<string, NpmCandidate[]>();
  for (const c of await planFor(deps.db, repo, policies, now)) byPackage.set(c.pkg, [...(byPackage.get(c.pkg) ?? []), c]);
  const deleted: NpmCandidate[] = [];
  for (const [full, candidates] of byPackage) deleted.push(...(await applyPackage(deps, store, repo, full, candidates, policies, now)));
  return deleted.sort(compareCandidates);
}

/** An npm candidate as the runner reports it: key `npm:<package>@<version>`, label `<package>@<version>`. */
function toCleanupCandidate(c: NpmCandidate): CleanupCandidate {
  return { repository: c.repository, key: candidateKey(c), label: `${c.pkg}@${c.version}`, reason: c.reason };
}

/**
 * The npm cleanup of hosted repositories: `keep_last_versions` keeps the newest N versions of each
 * package (by publish time, ties by semver) and `delete_not_downloaded` deletes versions not
 * downloaded for N days. Versions any dist-tag points at, and the newest version, are never deleted, so a package
 * never loses `latest` or ends up empty. `groupPrefix` is a plain prefix of the full package name. A deleted
 * version leaves its `time` entry as tombstone. Cache content of mirrors is never touched.
 */
export const npmCleanup: FormatCleanup = {
  format: "npm",
  async run(deps, repo, policies, now, opts) {
    const candidates = opts.dryRun ? await planFor(deps.db, repo, policies, now) : await applyFor(deps, repo, policies, now);
    return candidates.map(toCleanupCandidate);
  },
};

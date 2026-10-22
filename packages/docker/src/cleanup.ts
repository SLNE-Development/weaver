import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  globMatches,
  recordAudit,
  type AssetService,
  type CleanupCandidate,
  type CleanupDeps,
  type CleanupPolicyRow,
  type FormatCleanup,
  type Repo,
  type StoreSet,
} from "@weaver/core";
import { dockerManifest, dockerManifestRef, dockerTag, type Db, type Tx } from "@weaver/db";
import { syncImageComponents } from "./components.js";
import { runDockerGc } from "./gc.js";

const DAY_MS = 86_400_000;

/** A tag of a hosted image with the times the cleanup rules look at. */
export interface DockerTagInfo {
  image: string;
  tag: string;
  digest: string;
  /** When the tag was pushed or last moved. */
  pushedAt: Date;
  /** The latest pull by this tag or by its digest. */
  lastPulledAt: Date | null;
}

/** A manifest of a hosted image. */
export interface DockerManifestInfo {
  image: string;
  digest: string;
  createdAt: Date;
}

/** A tag as the planner sees it. */
interface TagState extends DockerTagInfo {
  manifestId: string;
}

/** A manifest as the planner sees it: what holds it (tags, parent indexes, its subject) is derived from these. */
interface ManifestState extends DockerManifestInfo {
  id: string;
  subjectDigest: string | null;
  /** Digests of the child manifests of an index. */
  children: string[];
}

/** Everything one image holds, as far as cleanup is concerned. */
interface ImageState {
  image: string;
  tags: TagState[];
  manifests: ManifestState[];
}

/** One tag or manifest the docker cleanup deletes. */
type DockerCandidate =
  | { type: "tag"; image: string; tag: string; digest: string; manifestId: string; reason: string }
  | { type: "manifest"; image: string; digest: string; id: string; reason: string };

/** Either a database or an open transaction. */
type DbOrTx = Db | Tx;

/** Days-based rules use at least one day, so a misconfigured 0 never sweeps everything. */
const cutoff = (now: Date, days: number) => new Date(now.getTime() - Math.max(1, days) * DAY_MS);

/** Whether a policy scoped to `prefix` (a plain prefix of the image name; null = everything) covers `image`. */
const inScope = (prefix: string | null, image: string) => prefix === null || image.startsWith(prefix);

/** The later of two optional times. */
function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Byte-wise string order, as the registry lists tags. */
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The tag and manifest state of the images of a hosted repository (only `image` when given), by image name. */
async function loadState(q: DbOrTx, repoId: string, image?: string): Promise<ImageState[]> {
  const tagRows = await q
    .select({
      image: dockerTag.image,
      tag: dockerTag.tag,
      manifestId: dockerTag.manifestId,
      digest: dockerManifest.digest,
      pushedAt: dockerTag.updatedAt,
      tagPulledAt: dockerTag.lastPulledAt,
      manifestPulledAt: dockerManifest.lastPulledAt,
    })
    .from(dockerTag)
    .innerJoin(dockerManifest, eq(dockerManifest.id, dockerTag.manifestId))
    .where(and(eq(dockerTag.repositoryId, repoId), image === undefined ? undefined : eq(dockerTag.image, image)));
  const manifestRows = await q
    .select({
      id: dockerManifest.id,
      image: dockerManifest.image,
      digest: dockerManifest.digest,
      createdAt: dockerManifest.createdAt,
      subjectDigest: dockerManifest.subjectDigest,
    })
    .from(dockerManifest)
    .where(and(eq(dockerManifest.repositoryId, repoId), image === undefined ? undefined : eq(dockerManifest.image, image)));
  const childRows = await q
    .select({ manifestId: dockerManifestRef.manifestId, digest: dockerManifestRef.digest })
    .from(dockerManifestRef)
    .innerJoin(dockerManifest, eq(dockerManifest.id, dockerManifestRef.manifestId))
    .where(
      and(
        eq(dockerManifest.repositoryId, repoId),
        image === undefined ? undefined : eq(dockerManifest.image, image),
        eq(dockerManifestRef.kind, "manifest"),
      ),
    );

  const children = new Map<string, string[]>();
  for (const r of childRows) children.set(r.manifestId, [...(children.get(r.manifestId) ?? []), r.digest]);
  const images = new Map<string, ImageState>();
  const of = (name: string) => {
    let state = images.get(name);
    if (!state) images.set(name, (state = { image: name, tags: [], manifests: [] }));
    return state;
  };
  for (const m of manifestRows) of(m.image).manifests.push({ ...m, children: children.get(m.id) ?? [] });
  for (const t of tagRows) {
    of(t.image).tags.push({
      image: t.image,
      tag: t.tag,
      manifestId: t.manifestId,
      digest: t.digest,
      pushedAt: t.pushedAt,
      lastPulledAt: latest(t.tagPulledAt, t.manifestPulledAt),
    });
  }
  for (const state of images.values()) {
    state.tags.sort((a, b) => byteOrder(a.tag, b.tag));
    state.manifests.sort((a, b) => byteOrder(a.digest, b.digest));
  }
  return [...images.values()].sort((a, b) => byteOrder(a.image, b.image));
}

/** The tags of one image that the tag kinds (`keep_last_tags`, `delete_not_downloaded`) delete at `now`. */
function planTags(state: ImageState, policies: CleanupPolicyRow[], now: Date): Array<Extract<DockerCandidate, { type: "tag" }>> {
  const found = new Map<string, Extract<DockerCandidate, { type: "tag" }>>();
  const add = (t: TagState, reason: string) => {
    if (!found.has(t.tag)) found.set(t.tag, { type: "tag", image: t.image, tag: t.tag, digest: t.digest, manifestId: t.manifestId, reason });
  };
  for (const policy of policies) {
    if (!inScope(policy.groupPrefix, state.image)) continue;
    switch (policy.kind) {
      case "keep_last_tags": {
        const keep = Math.max(1, policy.value);
        const pattern = policy.pattern ?? "*";
        const matching = state.tags
          .filter((t) => globMatches(pattern, t.tag))
          .sort((a, b) => b.pushedAt.getTime() - a.pushedAt.getTime() || byteOrder(b.tag, a.tag));
        for (const t of matching.slice(keep)) add(t, `keep last ${keep} tags matching ${pattern}`);
        break;
      }
      case "delete_not_downloaded": {
        const before = cutoff(now, policy.value);
        for (const t of state.tags) if ((t.lastPulledAt ?? t.pushedAt) < before) add(t, `not downloaded for ${policy.value} days`);
        break;
      }
      case "delete_untagged_manifests":
        // Planned by planOrphans, after the tags.
        break;
      case "keep_last_snapshot_builds":
      case "delete_stale_snapshots":
      case "keep_last_versions":
        // Maven, proto and npm kinds; the policy API never stores them on a docker repository.
        break;
      default: {
        const unknown: never = policy.kind;
        throw new Error(`Unknown cleanup kind ${String(unknown)}`);
      }
    }
  }
  return [...found.values()].sort((a, b) => byteOrder(a.tag, b.tag));
}

/** The manifests of `manifests` that nothing holds: no tag, no remaining parent index, no remaining subject. */
function orphansOf(manifests: ManifestState[], tagged: Set<string>, remaining: Set<string>): ManifestState[] {
  const parented = new Set<string>();
  for (const m of manifests) if (remaining.has(m.digest)) for (const c of m.children) parented.add(c);
  return manifests.filter(
    (m) =>
      remaining.has(m.digest) &&
      !tagged.has(m.digest) &&
      !parented.has(m.digest) &&
      !(m.subjectDigest !== null && remaining.has(m.subjectDigest)),
  );
}

/**
 * The manifests of one image to delete once the tags of `state` are gone: a manifest nothing holds (see
 * {@link orphansOf}) goes when a `delete_untagged_manifests` policy covers the image and it is older than the
 * policy's days, or when this run released it, i.e. deleted its tag (`released`), its parent index or its subject.
 * Repeats until nothing changes, so deleting an index also deletes its children and referrers.
 */
function planOrphans(
  state: ImageState,
  policies: CleanupPolicyRow[],
  now: Date,
  released: Set<string>,
): Array<Extract<DockerCandidate, { type: "manifest" }>> {
  const untagged = policies.filter((p) => p.kind === "delete_untagged_manifests" && inScope(p.groupPrefix, state.image));
  const tagged = new Set(state.tags.map((t) => t.digest));
  const remaining = new Set(state.manifests.map((m) => m.digest));
  const freed = new Set(released);
  const planned: Array<Extract<DockerCandidate, { type: "manifest" }>> = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of orphansOf(state.manifests, tagged, remaining)) {
      const policy = untagged.find((p) => m.createdAt < cutoff(now, p.value));
      const reason = freed.has(m.digest) ? "orphaned by cleanup" : policy ? `untagged for ${policy.value} days` : null;
      if (reason === null) continue;
      remaining.delete(m.digest);
      planned.push({ type: "manifest", image: m.image, digest: m.digest, id: m.id, reason });
      for (const c of m.children) freed.add(c);
      for (const r of state.manifests) if (r.subjectDigest === m.digest) freed.add(r.digest);
      changed = true;
    }
  }
  return planned.sort((a, b) => byteOrder(a.digest, b.digest));
}

/** The image state as it is once `deleted` tags are gone. */
const withoutTags = (state: ImageState, deleted: Array<{ tag: string }>): ImageState => {
  const gone = new Set(deleted.map((t) => t.tag));
  return { ...state, tags: state.tags.filter((t) => !gone.has(t.tag)) };
};

/** Every tag of a hosted repository with its push time and latest pull by tag or digest, by image and tag. */
export async function listTags(deps: { db: Db }, repo: Repo): Promise<DockerTagInfo[]> {
  return (await loadState(deps.db, repo.id)).flatMap((s) =>
    s.tags.map(({ image, tag, digest, pushedAt, lastPulledAt }) => ({ image, tag, digest, pushedAt, lastPulledAt })),
  );
}

/** Manifests with no tag, not a child of any remaining index, and not a referrer whose subject still exists. */
export async function listOrphanManifests(deps: { db: Db }, repo: Repo): Promise<DockerManifestInfo[]> {
  return (await loadState(deps.db, repo.id)).flatMap((s) =>
    orphansOf(s.manifests, new Set(s.tags.map((t) => t.digest)), new Set(s.manifests.map((m) => m.digest))).map(
      ({ image, digest, createdAt }) => ({ image, digest, createdAt }),
    ),
  );
}

/** Takes the per-tag advisory lock that manifest PUT by tag holds, until the transaction ends. */
async function lockTag(tx: Tx, repoId: string, image: string, tag: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`docker-tag:${repoId}:${image}:${tag}`}, 0))`);
}

/**
 * Deletes tag `image:tag` of a hosted repository under the per-tag lock that manifest PUT holds; with
 * `opts.digest` only while the tag still points at that manifest. Resolves to whether a tag was deleted.
 * The manifest stays; it is cleaned as an orphan.
 */
export async function deleteTag(
  deps: { db: Db; assets?: AssetService },
  repo: Repo,
  image: string,
  tag: string,
  opts: { digest?: string } = {},
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    await lockTag(tx, repo.id, image, tag);
    return (await deleteLockedTags(tx, repo, image, [{ tag, digest: opts.digest }])).length > 0;
  });
}

/** Deletes the given tags (each only while it still points at `digest`, when set); the caller holds their tag locks. */
async function deleteLockedTags(tx: Tx, repo: Repo, image: string, tags: Array<{ tag: string; digest?: string }>): Promise<string[]> {
  const deleted: string[] = [];
  for (const { tag, digest } of tags) {
    const pointsAt =
      digest === undefined
        ? undefined
        : inArray(
            dockerTag.manifestId,
            tx
              .select({ id: dockerManifest.id })
              .from(dockerManifest)
              .where(and(eq(dockerManifest.repositoryId, repo.id), eq(dockerManifest.image, image), eq(dockerManifest.digest, digest))),
          );
    const rows = await tx
      .delete(dockerTag)
      .where(and(eq(dockerTag.repositoryId, repo.id), eq(dockerTag.image, image), eq(dockerTag.tag, tag), pointsAt))
      .returning({ tag: dockerTag.tag });
    if (rows.length > 0) deleted.push(tag);
  }
  if (deleted.length > 0) await syncImageComponents(tx, repo.id, image);
  return deleted;
}

/**
 * Deletes manifest `image@digest` of a hosted repository with its tags and refs, but only when it is still an
 * orphan (see {@link listOrphanManifests}) and no concurrent push holds its row. Resolves to whether it was
 * deleted. Blobs stay until garbage collection.
 */
export async function deleteManifest(
  deps: { db: Db; assets?: AssetService },
  repo: Repo,
  image: string,
  digest: string,
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: dockerManifest.id })
      .from(dockerManifest)
      .where(and(eq(dockerManifest.repositoryId, repo.id), eq(dockerManifest.image, image), eq(dockerManifest.digest, digest)));
    if (!row) return false;
    return (await deleteOrphanRows(tx, repo, image, [row.id], () => new Set([digest]))).length > 0;
  });
}

/**
 * Locks the manifest rows `ids` (sorted, skipping rows a concurrent push holds), reloads the image and deletes
 * the locked rows whose digest `stillPlanned` returns for the fresh state. Resolves to the deleted digests.
 */
async function deleteOrphanRows(
  tx: Tx,
  repo: Repo,
  image: string,
  ids: string[],
  stillPlanned: (state: ImageState) => Set<string>,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const locked = await tx
    .select({ id: dockerManifest.id, digest: dockerManifest.digest })
    .from(dockerManifest)
    .where(inArray(dockerManifest.id, [...ids].sort()))
    .orderBy(asc(dockerManifest.id))
    .for("update", { skipLocked: true });
  if (locked.length === 0) return [];
  const [state] = await loadState(tx, repo.id, image);
  if (!state) return [];
  const planned = stillPlanned(state);
  // Shrinks until every row left is held by nothing that stays (a skipped or kept index keeps its children).
  let doomed = locked.filter((l) => planned.has(l.digest));
  for (let size = -1; size !== doomed.length; ) {
    size = doomed.length;
    const gone = new Set(doomed.map((d) => d.digest));
    const remaining = new Set(state.manifests.filter((m) => !gone.has(m.digest)).map((m) => m.digest));
    doomed = doomed.filter((d) => isFree(state, d.digest, remaining));
  }
  if (doomed.length === 0) return [];
  await tx.delete(dockerManifest).where(
    inArray(
      dockerManifest.id,
      doomed.map((d) => d.id),
    ),
  );
  await syncImageComponents(tx, repo.id, image);
  return doomed.map((d) => d.digest).sort(byteOrder);
}

/** Whether nothing outside the deleted set holds `digest`: no tag, no parent index in `remaining`, no subject in `remaining`. */
function isFree(state: ImageState, digest: string, remaining: Set<string>): boolean {
  if (state.tags.some((t) => t.digest === digest)) return false;
  if (state.manifests.some((m) => remaining.has(m.digest) && m.children.includes(digest))) return false;
  const self = state.manifests.find((m) => m.digest === digest);
  return !(self?.subjectDigest && remaining.has(self.subjectDigest));
}

/** Removes blobs no manifest references (also run by the `{ kind: "docker:gc" }` job), with `now` as the time the grace period counts back from. */
export async function collectGarbage(deps: { db: Db; stores: StoreSet }, now?: Date): Promise<{ blobsDeleted: number; bytesFreed: number }> {
  const result = await runDockerGc({ db: deps.db, stores: deps.stores, now });
  return { blobsDeleted: result.blobsDeleted, bytesFreed: result.bytesFreed };
}

/** Plans the whole repository: the tag kinds first, then the orphans of the state without those tags. */
async function planFor(db: Db, repo: Repo, policies: CleanupPolicyRow[], now: Date): Promise<DockerCandidate[]> {
  const planned: DockerCandidate[] = [];
  const manifests: DockerCandidate[] = [];
  for (const state of await loadState(db, repo.id)) {
    const tags = planTags(state, policies, now);
    planned.push(...tags);
    manifests.push(...planOrphans(withoutTags(state, tags), policies, now, new Set(tags.map((t) => t.digest))));
  }
  return [...planned, ...manifests];
}

/** Records one `cleanup.delete` audit entry per deleted tag or manifest. */
async function audit(tx: Tx, repo: Repo, deleted: DockerCandidate[]): Promise<void> {
  for (const c of deleted) {
    await recordAudit(tx, {
      actor: "system",
      action: "cleanup.delete",
      target: `${repo.name}/${labelOf(c)}`,
      details: { reason: c.reason },
    });
  }
}

/**
 * Deletes the planned tags of one image in one transaction: takes the per-tag locks (sorted), plans the image
 * again and deletes only tags still planned and still pointing at the planned manifest.
 */
async function applyTags(db: Db, repo: Repo, image: string, planned: Array<Extract<DockerCandidate, { type: "tag" }>>, policies: CleanupPolicyRow[], now: Date) {
  return db.transaction(async (tx) => {
    for (const t of [...planned].sort((a, b) => byteOrder(a.tag, b.tag))) await lockTag(tx, repo.id, image, t.tag);
    const [state] = await loadState(tx, repo.id, image);
    if (!state) return [];
    const still = new Map(planTags(state, policies, now).map((t) => [t.tag, t.digest]));
    const confirmed = planned.filter((t) => still.get(t.tag) === t.digest);
    const gone = new Set(await deleteLockedTags(tx, repo, image, confirmed));
    const deleted = confirmed.filter((t) => gone.has(t.tag));
    await audit(tx, repo, deleted);
    return deleted;
  });
}

/**
 * Deletes the orphans of one image in one transaction: plans them from the committed state (with the digests
 * whose tags this run deleted as `released`), locks their rows and deletes those still planned.
 */
async function applyOrphans(db: Db, repo: Repo, image: string, policies: CleanupPolicyRow[], now: Date, released: Set<string>) {
  const [before] = await loadState(db, repo.id, image);
  if (!before) return [];
  const planned = planOrphans(before, policies, now, released);
  if (planned.length === 0) return [];
  return db.transaction(async (tx) => {
    const gone = new Set(
      await deleteOrphanRows(
        tx,
        repo,
        image,
        planned.map((m) => m.id),
        (state) => new Set(planOrphans(state, policies, now, released).map((m) => m.digest)),
      ),
    );
    const deleted = planned.filter((m) => gone.has(m.digest));
    await audit(tx, repo, deleted);
    return deleted;
  });
}

/** Applies the plan image by image: tags first, then the orphans recomputed after the tag deletions. */
async function applyFor(db: Db, repo: Repo, policies: CleanupPolicyRow[], now: Date): Promise<DockerCandidate[]> {
  const tagsDeleted: DockerCandidate[] = [];
  const released = new Map<string, Set<string>>();
  for (const state of await loadState(db, repo.id)) {
    const planned = planTags(state, policies, now);
    if (planned.length === 0) continue;
    const deleted = await applyTags(db, repo, state.image, planned, policies, now);
    tagsDeleted.push(...deleted);
    released.set(state.image, new Set(deleted.map((t) => t.digest)));
  }
  const manifestsDeleted: DockerCandidate[] = [];
  for (const state of await loadState(db, repo.id)) {
    manifestsDeleted.push(...(await applyOrphans(db, repo, state.image, policies, now, released.get(state.image) ?? new Set())));
  }
  return [...tagsDeleted, ...manifestsDeleted];
}

/** `<image>:<tag>` or `<image>@<digest>`. */
const labelOf = (c: DockerCandidate) => (c.type === "tag" ? `${c.image}:${c.tag}` : `${c.image}@${c.digest}`);

/** A docker candidate as the runner reports it: key `docker:<image>:<tag>` or `docker:<image>@<digest>`. */
function toCleanupCandidate(repo: Repo, c: DockerCandidate): CleanupCandidate {
  return { repository: repo.name, key: `docker:${labelOf(c)}`, label: labelOf(c), reason: c.reason };
}

/** What {@link createDockerCleanup} can replace. */
export interface DockerCleanupOptions {
  /** The garbage collection run once after deletions (default {@link collectGarbage}). */
  collectGarbage?: (deps: { db: Db; stores: StoreSet }, now: Date) => Promise<unknown>;
}

/**
 * Creates the docker cleanup of hosted repositories. `keep_last_tags` keeps the newest N tags (by push time)
 * matching its glob `pattern` per image; `delete_not_downloaded` deletes tags not pulled (by tag or by digest)
 * for N days; `delete_untagged_manifests` deletes manifests nothing holds (no tag, no remaining parent index,
 * no remaining subject) that are older than N days. Manifests orphaned by this run's deletions (their tag,
 * parent index or subject) go too, whatever their age. `groupPrefix` is a plain prefix of the image name.
 * Tags are deleted first under the per-tag lock manifest PUT holds, then the orphans are recomputed and
 * deleted with their rows locked; both re-check under the lock. When anything was deleted and the run is not a
 * dry run, garbage collection runs once. Mirror and group repositories are never touched.
 */
export function createDockerCleanup(opts: DockerCleanupOptions = {}): FormatCleanup {
  const gc = opts.collectGarbage ?? collectGarbage;
  return {
    format: "docker",
    async run(deps: CleanupDeps, repo, policies, now, { dryRun }) {
      if (repo.kind !== "hosted" || repo.format !== "docker") return [];
      if (dryRun) return (await planFor(deps.db, repo, policies, now)).map((c) => toCleanupCandidate(repo, c));
      const deleted = await applyFor(deps.db, repo, policies, now);
      if (deleted.length > 0) await gc({ db: deps.db, stores: deps.stores }, now);
      return deleted.map((c) => toCleanupCandidate(repo, c));
    },
  };
}

/** The docker cleanup the worker and the web server register; see {@link createDockerCleanup}. */
export const dockerCleanup: FormatCleanup = createDockerCleanup();

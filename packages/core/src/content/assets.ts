import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { asset, component, type Db, type Tx } from "@weaver/db";
import { RegistryError } from "../errors.js";
import type { Repo } from "../repos/service.js";
import type { ObjectDigests, ObjectRead, StoreId, StoreSet } from "../storage/index.js";

/** One stored file of a repository: where its bytes live, their digests, and whether it was published or cached. */
export interface AssetRow {
  id: string;
  repositoryId: string;
  componentId: string | null;
  path: string;
  store: StoreId;
  storageKey: string;
  size: number;
  contentType: string | null;
  md5: string;
  sha1: string;
  sha256: string;
  sha512: string;
  origin: "hosted" | "cache";
  /** When cached metadata must be revalidated upstream; null for hosted and immutable assets. */
  expiresAt: Date | null;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The coordinate of a component (a Maven GAV, an npm package version, a Docker tag); empty strings where a format has none. */
export interface ComponentRef {
  namespace: string;
  name: string;
  version: string;
  /** Format-specific details; replaces the stored metadata when given. */
  metadata?: Record<string, unknown>;
}

/** What {@link AssetService.put} stores. */
export interface PutAssetInput {
  repo: Repo;
  path: string;
  body: Readable;
  contentType?: string | null;
  origin: "hosted" | "cache";
  /** The store to write to; defaults to the primary store. */
  store?: StoreId;
  expiresAt?: Date | null;
  /** Links the asset to this component, creating the component when needed. */
  component?: ComponentRef;
  /** The expected body length; a body of another length fails the put and writes nothing. */
  contentLength?: number;
  /** Aborting it fails the put and writes nothing. */
  signal?: AbortSignal;
}

/** What {@link AssetService.stage} streams to a store: the bytes and where they go, but no path or row yet. */
export interface StageAssetInput {
  repo: Repo;
  body: Readable;
  origin: "hosted" | "cache";
  /** The store to write to; defaults to the primary store. */
  store?: StoreId;
  /** The expected body length; a body of another length fails the stage and writes nothing. */
  contentLength?: number;
  /** Aborting it fails the stage and writes nothing. */
  signal?: AbortSignal;
}

/** An object written to a store by {@link AssetService.stage} that no asset row points to yet. */
export interface StagedAsset extends ObjectDigests {
  repositoryId: string;
  origin: "hosted" | "cache";
  store: StoreId;
  storageKey: string;
  size: number;
}

/** The row half of an asset write: what {@link AssetService.commit} records for a staged object. */
export interface CommitAssetInput {
  path: string;
  contentType?: string | null;
  expiresAt?: Date | null;
  /** Links the asset to this component, creating the component when needed. */
  component?: ComponentRef;
}

/** The result of {@link AssetService.commit}. */
export interface CommittedAsset {
  asset: AssetRow;
  /** Whether the commit created the linked component (false when it existed or there is none). */
  componentCreated: boolean;
  /**
   * Deletes the object of the asset row this commit replaced, if any. Call it only after the transaction
   * passed to `commit` has committed; a failed delete is only logged.
   */
  finish(): Promise<void>;
}

/** Stored files of non-proto repositories: rows in `asset`, bytes in the object stores. */
export interface AssetService {
  /** The asset at `path` in the repository, or null. */
  find(repoId: string, path: string): Promise<AssetRow | null>;
  /** The assets whose path starts with `prefix` (taken literally), by path. */
  list(repoId: string, prefix: string): Promise<AssetRow[]>;
  /** Streams into the store under key `<repoId>/<origin>/<uuid>`, then upserts the row (replacing and deleting the previous object on conflict). */
  put(input: PutAssetInput): Promise<AssetRow>;
  /** Streams the body into the store under key `<repoId>/<origin>/<uuid>` without touching the database. */
  stage(input: StageAssetInput): Promise<StagedAsset>;
  /**
   * Upserts the component and the asset row of a staged object inside the caller's transaction, holding the
   * per-path advisory lock until it ends. The replaced object is deleted by `finish()` once the caller committed;
   * if the transaction fails, the caller discards the staged object.
   */
  commit(tx: Tx, staged: StagedAsset, input: CommitAssetInput): Promise<CommittedAsset>;
  /** Deletes a staged object that was never committed (or whose transaction rolled back); failures are only logged. */
  discard(staged: StagedAsset): Promise<void>;
  /** Opens the asset's bytes, optionally an inclusive range; null when the object or its store is gone. */
  open(asset: AssetRow, range?: { start: number; end?: number }): Promise<ObjectRead | null>;
  /** Deletes the row, then the object; a failed object delete is only logged. */
  delete(asset: AssetRow): Promise<void>;
  /** Sets `lastAccessedAt` to now. */
  touch(assetId: string): Promise<void>;
  /** Creates or updates the component at `ref` in the repository and returns its id. */
  upsertComponent(repoId: string, ref: ComponentRef): Promise<string>;
}

type AssetTableRow = typeof asset.$inferSelect;

function toAssetRow(row: AssetTableRow): AssetRow {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    componentId: row.componentId,
    path: row.path,
    store: row.store,
    storageKey: row.storageKey,
    size: row.size,
    contentType: row.contentType,
    md5: row.md5,
    sha1: row.sha1,
    sha256: row.sha256,
    sha512: row.sha512,
    origin: row.origin,
    expiresAt: row.expiresAt,
    lastAccessedAt: row.lastAccessedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `value` with the LIKE wildcards `%`, `_` and the escape character `\` escaped. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Creates the asset service over the database and the object stores. */
export function createAssetService(deps: { db: Db; stores: StoreSet }): AssetService {
  const { db, stores } = deps;

  /** Deletes an object whose row is gone; failures and unconfigured stores only leave an orphan and are logged. */
  async function deleteObject(store: StoreId, key: string): Promise<void> {
    const target = stores.get(store);
    if (!target) {
      console.warn(`weaver: cannot delete orphaned asset object ${key}: store ${store} is not configured`);
      return;
    }
    try {
      await target.delete(key);
    } catch (error) {
      console.warn(`weaver: failed to delete orphaned asset object ${key}`, error);
    }
  }

  /** Creates or updates the component at `ref` through `q`; reports whether the row was inserted. */
  async function upsertComponentIn(q: Db | Tx, repoId: string, ref: ComponentRef): Promise<{ id: string; created: boolean }> {
    const [row] = await q
      .insert(component)
      .values({ repositoryId: repoId, namespace: ref.namespace, name: ref.name, version: ref.version, metadata: ref.metadata ?? {} })
      .onConflictDoUpdate({
        target: [component.repositoryId, component.namespace, component.name, component.version],
        set: ref.metadata === undefined ? { updatedAt: new Date() } : { metadata: ref.metadata, updatedAt: new Date() },
      })
      // xmax is 0 only for a row this statement inserted; an updated row carries the updating transaction id.
      .returning({ id: component.id, created: sql<boolean>`(xmax = 0)` });
    return { id: row!.id, created: row!.created };
  }

  async function upsertComponent(repoId: string, ref: ComponentRef): Promise<string> {
    return (await upsertComponentIn(db, repoId, ref)).id;
  }

  async function stage(input: StageAssetInput): Promise<StagedAsset> {
    const storeId = input.store ?? stores.primary.id;
    const store = stores.get(storeId);
    if (!store) throw new RegistryError("invalid_request", `Storage "${storeId}" is not configured`);
    const key = `${input.repo.id}/${input.origin}/${randomUUID()}`;
    const written = await store.put(key, input.body, { contentLength: input.contentLength, signal: input.signal });
    return {
      repositoryId: input.repo.id,
      origin: input.origin,
      store: storeId,
      storageKey: key,
      size: written.size,
      md5: written.md5,
      sha1: written.sha1,
      sha256: written.sha256,
      sha512: written.sha512,
    };
  }

  async function commit(tx: Tx, staged: StagedAsset, input: CommitAssetInput): Promise<CommittedAsset> {
    // Serializes writes to one path until the caller's transaction ends, so the replaced object is the one this commit saw.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset:${staged.repositoryId}:${input.path}`}, 0))`);
    const linked = input.component ? await upsertComponentIn(tx, staged.repositoryId, input.component) : null;
    const values = {
      repositoryId: staged.repositoryId,
      componentId: linked?.id ?? null,
      path: input.path,
      store: staged.store,
      storageKey: staged.storageKey,
      size: staged.size,
      contentType: input.contentType ?? null,
      md5: staged.md5,
      sha1: staged.sha1,
      sha256: staged.sha256,
      sha512: staged.sha512,
      origin: staged.origin,
      expiresAt: input.expiresAt ?? null,
    };
    const [existing] = await tx
      .select({ store: asset.store, storageKey: asset.storageKey })
      .from(asset)
      .where(and(eq(asset.repositoryId, staged.repositoryId), eq(asset.path, input.path)));
    const [upserted] = await tx
      .insert(asset)
      .values(values)
      .onConflictDoUpdate({ target: [asset.repositoryId, asset.path], set: { ...values, updatedAt: new Date() } })
      .returning();
    const replaced = existing && existing.storageKey !== staged.storageKey ? existing : null;
    return {
      asset: toAssetRow(upserted!),
      componentCreated: linked?.created ?? false,
      finish: async () => {
        if (replaced) await deleteObject(replaced.store, replaced.storageKey);
      },
    };
  }

  async function discard(staged: StagedAsset): Promise<void> {
    await deleteObject(staged.store, staged.storageKey);
  }

  return {
    async find(repoId, path) {
      const [row] = await db
        .select()
        .from(asset)
        .where(and(eq(asset.repositoryId, repoId), eq(asset.path, path)));
      return row ? toAssetRow(row) : null;
    },

    async list(repoId, prefix) {
      const rows = await db
        .select()
        .from(asset)
        .where(and(eq(asset.repositoryId, repoId), like(asset.path, `${escapeLike(prefix)}%`)))
        .orderBy(asc(asset.path));
      return rows.map(toAssetRow);
    },

    async put(input) {
      const staged = await stage(input);
      let committed: CommittedAsset;
      try {
        committed = await db.transaction((tx) => commit(tx, staged, input));
      } catch (error) {
        await discard(staged);
        throw error;
      }
      await committed.finish();
      return committed.asset;
    },

    stage,
    commit,
    discard,

    async open(row, range) {
      const store = stores.get(row.store);
      if (!store) {
        console.warn(`weaver: cannot open asset ${row.path}: store ${row.store} is not configured`);
        return null;
      }
      return store.get(row.storageKey, range ? { range } : undefined);
    },

    async delete(row) {
      await db.delete(asset).where(eq(asset.id, row.id));
      await deleteObject(row.store, row.storageKey);
    },

    async touch(assetId) {
      await db.update(asset).set({ lastAccessedAt: new Date() }).where(eq(asset.id, assetId));
    },

    upsertComponent,
  };
}

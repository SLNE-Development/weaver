import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import type { FormatDeps, StoreId } from "@weaver/core";
import { dockerBlob, dockerBlobLink, type Db } from "@weaver/db";
import { requireAccess, type Caller } from "../auth/authorize.js";
import { DockerError } from "../errors.js";
import type { DockerOptions } from "../handler.js";
import type { Target } from "../target.js";

/** Everything a hosted-repository operation works with: dependencies, options, the authorized caller and the target. */
export interface HostedCtx {
  deps: FormatDeps;
  opts: DockerOptions;
  caller: Caller;
  target: Target;
}

/** What a hosted read (manifest, blob, tags, referrers) works with: a {@link HostedCtx} without the handler options. */
export type HostedReadCtx = Omit<HostedCtx, "opts">;

/** A stored blob as seen through a link: where its bytes live, its size and digest. */
export interface BlobRef {
  blobId: string;
  store: StoreId;
  storageKey: string;
  size: number;
  digest: string;
}

/** The header every `/v2` response carries. */
export const API_VERSION = { "docker-distribution-api-version": "registry/2.0" } as const;

/** The `404 BLOB_UNKNOWN` error for `digest`. */
export function blobUnknown(digest: string): DockerError {
  return new DockerError(404, "BLOB_UNKNOWN", "blob unknown to registry", { digest });
}

/** Linked blob of repo/image, or null. */
export async function findLinkedBlob(db: Db, repoId: string, image: string, digest: string): Promise<BlobRef | null> {
  const [row] = await db
    .select({
      blobId: dockerBlob.id,
      store: dockerBlob.store,
      storageKey: dockerBlob.storageKey,
      size: dockerBlob.size,
      digest: dockerBlob.digest,
    })
    .from(dockerBlobLink)
    .innerJoin(dockerBlob, eq(dockerBlob.id, dockerBlobLink.blobId))
    .where(
      and(eq(dockerBlobLink.repositoryId, repoId), eq(dockerBlobLink.image, image), eq(dockerBlobLink.digest, digest)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Makes `blob` visible in repo/image, in one transaction: stamps the blob's `lastLinkedAt` first (locking its row,
 * so garbage collection cannot delete it underneath), then inserts the link or refreshes its `createdAt`.
 * Resolves to false, linking nothing, when the blob row is gone (collected meanwhile).
 */
export function linkBlob(db: Db, repoId: string, image: string, blob: BlobRef): Promise<boolean> {
  return db.transaction(async (tx) => {
    const touched = await tx
      .update(dockerBlob)
      .set({ lastLinkedAt: sql`now()` })
      .where(eq(dockerBlob.id, blob.blobId))
      .returning({ id: dockerBlob.id });
    if (touched.length === 0) return false;
    await tx
      .insert(dockerBlobLink)
      .values({ repositoryId: repoId, image, blobId: blob.blobId, digest: blob.digest })
      .onConflictDoUpdate({
        target: [dockerBlobLink.repositoryId, dockerBlobLink.image, dockerBlobLink.digest],
        set: { createdAt: sql`now()` },
      });
    return true;
  });
}

/**
 * Refreshes an existing link of repo/image to `digest` (its `createdAt` and the blob's `lastLinkedAt`), so a
 * client that skips an upload because the layer already exists can rely on it for the whole grace period.
 * Blob row first, then link, the same lock order as {@link linkBlob}.
 */
export async function touchLink(db: Db, repoId: string, image: string, blob: BlobRef): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(dockerBlob).set({ lastLinkedAt: sql`now()` }).where(eq(dockerBlob.id, blob.blobId));
    await tx
      .update(dockerBlobLink)
      .set({ createdAt: sql`now()` })
      .where(and(eq(dockerBlobLink.repositoryId, repoId), eq(dockerBlobLink.image, image), eq(dockerBlobLink.digest, blob.digest)));
  });
}

/** Whether the caller may push to the target, without raising the challenge `requireAccess` would. */
function mayPush(ctx: HostedReadCtx): boolean {
  try {
    requireAccess(ctx.deps, ctx.caller, ctx.target, "push");
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses a single `bytes=` range against a blob of `size` bytes: `undefined` when absent, malformed or
 * multi-range (the whole blob is served), `null` when unsatisfiable, else the inclusive range.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return null;
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (m[2] !== "" && Number(m[2]) < start) return undefined;
  if (start >= size) return null;
  return { start, end };
}

/**
 * Serves a blob linked in the target image: `GET` streams it from its object store (`206` for a
 * satisfiable `Range`, `416` otherwise) and records a download; `HEAD` answers headers only and, for a caller
 * who may push, refreshes the link (see {@link touchLink}).
 * An unlinked digest is `404 BLOB_UNKNOWN`, also when another repository holds it.
 */
export async function serveHostedBlob(ctx: HostedReadCtx, req: Request, digest: string): Promise<Response> {
  const { deps, target } = ctx;
  const blob = await findLinkedBlob(deps.db, target.repo.id, target.image, digest);
  if (!blob) throw blobUnknown(digest);
  const headers: Record<string, string> = {
    ...API_VERSION,
    "content-type": "application/octet-stream",
    "docker-content-digest": blob.digest,
    "accept-ranges": "bytes",
    etag: `"${blob.digest}"`,
  };
  if (req.method === "HEAD") {
    // `docker push` skips layers whose HEAD succeeds ("Layer already exists"); keep that link alive for the manifest PUT.
    if (target.repo.kind === "hosted" && mayPush(ctx)) await touchLink(deps.db, target.repo.id, target.image, blob);
    return new Response(null, { status: 200, headers: { ...headers, "content-length": String(blob.size) } });
  }

  const range = parseRange(req.headers.get("range"), blob.size);
  if (range === null) {
    throw new DockerError(416, "RANGE_INVALID", "requested range not satisfiable", { size: blob.size }, {
      "content-range": `bytes */${blob.size}`,
    });
  }
  const store = deps.stores.get(blob.store);
  if (!store) throw new Error(`weaver:docker blob ${blob.digest} lives in unconfigured store ${blob.store}`);
  const read = await store.get(blob.storageKey, range ? { range } : undefined);
  if (!read) throw blobUnknown(digest);
  const length = read.range ? read.range.end - read.range.start + 1 : read.size;
  await deps.usage({
    repositoryId: target.repo.id,
    path: `${target.image}/blobs/${digest}`,
    action: "download",
    bytes: length,
    principal: ctx.caller.principal,
  });
  const body = Readable.toWeb(read.body) as unknown as ReadableStream<Uint8Array>;
  if (read.range) {
    headers["content-range"] = `bytes ${read.range.start}-${read.range.end}/${read.size}`;
    return new Response(body, { status: 206, headers: { ...headers, "content-length": String(length) } });
  }
  return new Response(body, { status: 200, headers: { ...headers, "content-length": String(length) } });
}

/** Unlinks a blob from the target image (`202`); storage is reclaimed by garbage collection. Unlinked → `404 BLOB_UNKNOWN`. */
export async function deleteHostedBlob(ctx: HostedCtx, digest: string): Promise<Response> {
  const { deps, target } = ctx;
  const removed = await deps.db
    .delete(dockerBlobLink)
    .where(
      and(
        eq(dockerBlobLink.repositoryId, target.repo.id),
        eq(dockerBlobLink.image, target.image),
        eq(dockerBlobLink.digest, digest),
      ),
    )
    .returning({ digest: dockerBlobLink.digest });
  if (removed.length === 0) throw blobUnknown(digest);
  return new Response(null, { status: 202, headers: { ...API_VERSION, "content-length": "0" } });
}

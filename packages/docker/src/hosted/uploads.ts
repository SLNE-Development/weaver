import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { and, eq, sql } from "drizzle-orm";
import { dockerBlob, dockerUpload } from "@weaver/db";
import { requireAccess } from "../auth/authorize.js";
import { DockerError } from "../errors.js";
import { isDigest } from "../media-types.js";
import { resolveTarget, type Target } from "../target.js";
import { API_VERSION, blobUnknown, findLinkedBlob, linkBlob, type BlobRef, type HostedCtx } from "./blobs.js";
import { maybeSweepUploads } from "../sweep.js";
import { SpoolError, SpoolOffsetError, appendToSpool, createSpool, removeSpool, spoolPath } from "./spool.js";

/** Tail of the operation chain per upload id: one upload is worked on by one request at a time. */
const locks = new Map<string, Promise<void>>();

/** Runs `fn` once every earlier operation on upload `id` in this process has settled. */
async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(id, tail);
  try {
    return await run;
  } finally {
    if (locks.get(id) === tail) locks.delete(id);
  }
}

function uploadUnknown(id: string): DockerError {
  return new DockerError(404, "BLOB_UPLOAD_UNKNOWN", "blob upload unknown to registry", { uploadId: id });
}

function digestInvalid(digest: string | null): DockerError {
  return new DockerError(400, "DIGEST_INVALID", "provided digest did not match uploaded content", { digest });
}

/** The `Range` header value for an upload holding `offset` bytes (`0-0` when empty). */
function rangeOf(offset: number): string {
  return `0-${Math.max(offset - 1, 0)}`;
}

/** The headers locating upload `id` of `target` at `offset`, for any response including errors (no body length). */
function uploadLocation(target: Target, id: string, offset: number): Record<string, string> {
  return {
    location: `/v2/${target.name}/blobs/uploads/${id}`,
    "docker-upload-uuid": id,
    range: rangeOf(offset),
  };
}

/** The headers of an empty-bodied success response describing upload `id` of `target` at `offset`. */
function uploadHeaders(target: Target, id: string, offset: number): Record<string, string> {
  return { ...API_VERSION, ...uploadLocation(target, id, offset), "content-length": "0" };
}

/** The `201 Created` answer for a blob now linked under `target`. */
function created(target: Target, digest: string): Response {
  return new Response(null, {
    status: 201,
    headers: {
      ...API_VERSION,
      location: `/v2/${target.name}/blobs/${digest}`,
      "docker-content-digest": digest,
      "content-length": "0",
    },
  });
}

/** The upload row `id` when it belongs to the target image; else `404 BLOB_UPLOAD_UNKNOWN`. */
async function loadUpload(ctx: HostedCtx, id: string): Promise<{ id: string; offset: number }> {
  const [row] = await ctx.deps.db
    .select({ id: dockerUpload.id, offset: dockerUpload.offset })
    .from(dockerUpload)
    .where(
      and(
        eq(dockerUpload.id, id),
        eq(dockerUpload.repositoryId, ctx.target.repo.id),
        eq(dockerUpload.image, ctx.target.image),
      ),
    );
  if (!row) throw uploadUnknown(id);
  return row;
}

/** Deletes the upload row and its spool file. */
async function discard(ctx: HostedCtx, id: string): Promise<void> {
  await ctx.deps.db.delete(dockerUpload).where(eq(dockerUpload.id, id));
  await removeSpool(spoolPath(ctx.opts.uploadDir, id));
}

/**
 * Appends a request body to the spool of upload `id` at `offset` and records the new offset; resolves to it.
 * An interrupted body keeps the bytes that reached the file, records them and answers `400 BLOB_UPLOAD_INVALID`
 * with the resumable `Range`; a spool file shorter than the recorded offset (lost) ends the upload.
 */
async function append(ctx: HostedCtx, id: string, body: ReadableStream<Uint8Array> | null, offset: number): Promise<number> {
  if (!body) return offset;
  const setOffset = (value: number) =>
    ctx.deps.db.update(dockerUpload).set({ offset: value, updatedAt: sql`now()` }).where(eq(dockerUpload.id, id));
  let written: number;
  try {
    written = await appendToSpool(spoolPath(ctx.opts.uploadDir, id), body, offset);
  } catch (err) {
    if (err instanceof SpoolError) {
      const persisted = offset + err.persisted;
      await setOffset(persisted);
      throw new DockerError(
        400,
        "BLOB_UPLOAD_INVALID",
        "upload body interrupted",
        { offset: persisted },
        uploadLocation(ctx.target, id, persisted),
      );
    }
    if (err instanceof SpoolOffsetError) {
      await discard(ctx, id);
      throw uploadUnknown(id);
    }
    throw err;
  }
  const next = offset + written;
  await setOffset(next);
  return next;
}

/** Hashes a file with `algorithm`, streaming; resolves to lowercase hex. */
async function hashFile(path: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Turns the spool of upload `id` (holding `size` bytes) into the blob `digest` of the primary store and
 * links it into the target image. A blob row that already exists is reused (its `lastLinkedAt` touched) after hashing the spool;
 * otherwise the spool is streamed into `docker/blobs/<alg>/<hex[0..2]>/<hex>-<id>` and the row upserted,
 * deleting our object when a concurrent upload won. A mismatch is `400 DIGEST_INVALID` and keeps the upload.
 */
async function finalize(ctx: HostedCtx, id: string, digest: string, size: number): Promise<Response> {
  const { deps, target } = ctx;
  const [algorithm, hex] = digest.split(":") as [string, string];
  const store = deps.stores.primary;
  const path = spoolPath(ctx.opts.uploadDir, id);

  // Touching `last_linked_at` here keeps garbage collection from deleting the row before it is linked again.
  const [existing] = await deps.db
    .update(dockerBlob)
    .set({ lastLinkedAt: sql`now()` })
    .where(and(eq(dockerBlob.store, store.id), eq(dockerBlob.digest, digest)))
    .returning();
  let blob: BlobRef;
  if (existing) {
    if ((await hashFile(path, algorithm)) !== hex) throw digestInvalid(digest);
    blob = { blobId: existing.id, store: existing.store, storageKey: existing.storageKey, size: existing.size, digest };
  } else {
    const key = `docker/blobs/${algorithm}/${hex.slice(0, 2)}/${hex}-${id}`;
    const result = await store.put(key, createReadStream(path), { contentLength: size });
    const actual = algorithm === "sha512" ? result.sha512 : result.sha256;
    if (actual !== hex) {
      await store.delete(key);
      throw digestInvalid(digest);
    }
    await ctx.opts.beforeBlobUpsert?.(digest, key);
    const [row] = await deps.db
      .insert(dockerBlob)
      .values({ store: store.id, digest, size: result.size, storageKey: key })
      .onConflictDoUpdate({ target: [dockerBlob.store, dockerBlob.digest], set: { lastLinkedAt: sql`now()` } })
      .returning();
    if (row!.storageKey !== key) await store.delete(key);
    blob = { blobId: row!.id, store: row!.store, storageKey: row!.storageKey, size: row!.size, digest };
  }

  if (!(await linkBlob(deps.db, target.repo.id, target.image, blob))) throw blobUnknown(digest);
  await discard(ctx, id);
  await deps.usage({
    repositoryId: target.repo.id,
    path: `${target.image}/blobs/${digest}`,
    action: "upload",
    bytes: size,
    principal: ctx.caller.principal,
  });
  return created(target, digest);
}

/**
 * Cross-repository mount: links `digest` from the `from` image into the target when the source is a hosted
 * repository the caller may pull (checked against the token claims through `requireAccess`), the blob is
 * linked there and lives in the primary store. Null when any of that fails, so the caller starts an ordinary upload.
 */
async function tryMount(ctx: HostedCtx, digest: string, from: string): Promise<Response | null> {
  const { deps, caller, target } = ctx;
  let source: Target | null;
  try {
    source = await resolveTarget(deps.repos, from);
  } catch (err) {
    if (err instanceof DockerError) return null;
    throw err;
  }
  if (!source || source.repo.kind !== "hosted") return null;
  try {
    requireAccess(deps, caller, source, "pull");
  } catch (err) {
    if (err instanceof DockerError) return null;
    throw err;
  }
  const blob = await findLinkedBlob(deps.db, source.repo.id, source.image, digest);
  if (!blob || blob.store !== deps.stores.primary.id) return null;
  // A blob collected since the lookup cannot be mounted; the client then uploads it normally.
  if (!(await linkBlob(deps.db, target.repo.id, target.image, blob))) return null;
  return created(target, digest);
}

/**
 * `POST .../blobs/uploads/`: mounts with `?mount=&from=` when allowed, stores a monolithic upload with
 * `?digest=` and a body (`201`), and otherwise opens an upload session (`202`). Before a new upload the
 * upload directory is swept of stale spool files, at most every ten minutes per process.
 */
export async function startUpload(ctx: HostedCtx, req: Request): Promise<Response> {
  const { deps, target } = ctx;
  const params = new URL(req.url).searchParams;
  const mount = params.get("mount");
  const from = params.get("from");
  if (mount && from && isDigest(mount)) {
    const mounted = await tryMount(ctx, mount, from);
    if (mounted) return mounted;
  }
  const digest = params.get("digest");
  if (digest !== null && !isDigest(digest)) throw digestInvalid(digest);

  // Fire and forget: the sweep never fails or delays an upload (it logs its own errors).
  void maybeSweepUploads(deps.db, ctx.opts.uploadDir);
  const id = randomUUID();
  await createSpool(spoolPath(ctx.opts.uploadDir, id));
  await deps.db.insert(dockerUpload).values({ id, repositoryId: target.repo.id, image: target.image });
  if (digest === null) return new Response(null, { status: 202, headers: uploadHeaders(target, id, 0) });

  try {
    return await withLock(id, async () => finalize(ctx, id, digest, await append(ctx, id, req.body, 0)));
  } catch (err) {
    await discard(ctx, id);
    throw err;
  }
}

/** Parses a chunk's `Content-Range` (`<start>-<end>`, optionally with a `bytes` unit and `/<total>`); null when malformed. */
function parseContentRange(value: string): { start: number; end: number } | null {
  const m = /^(?:bytes[ =])?(\d+)-(\d+)(?:\/(?:\d+|\*))?$/.exec(value.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return end < start ? null : { start, end };
}

/** `PATCH .../uploads/<id>`: appends a chunk (`202` with the new `Range`); a chunk not starting at the offset is `416 RANGE_INVALID`. */
export function patchUpload(ctx: HostedCtx, req: Request, id: string): Promise<Response> {
  return withLock(id, async () => {
    const row = await loadUpload(ctx, id);
    const header = req.headers.get("content-range");
    if (header !== null) {
      const range = parseContentRange(header);
      if (!range || range.start !== row.offset) {
        throw new DockerError(
          416,
          "RANGE_INVALID",
          "chunk does not continue the upload",
          { offset: row.offset },
          uploadLocation(ctx.target, id, row.offset),
        );
      }
    }
    const offset = await append(ctx, id, req.body, row.offset);
    return new Response(null, { status: 202, headers: uploadHeaders(ctx.target, id, offset) });
  });
}

/** `PUT .../uploads/<id>?digest=`: appends an optional final chunk and completes the blob (`201`). */
export async function finishUpload(ctx: HostedCtx, req: Request, id: string): Promise<Response> {
  const digest = new URL(req.url).searchParams.get("digest");
  return withLock(id, async () => {
    const row = await loadUpload(ctx, id);
    if (digest === null || !isDigest(digest)) throw digestInvalid(digest);
    const offset = await append(ctx, id, req.body, row.offset);
    return finalize(ctx, id, digest, offset);
  });
}

/** `GET .../uploads/<id>`: `204` with the bytes received so far as `Range`. */
export async function uploadStatus(ctx: HostedCtx, id: string): Promise<Response> {
  const row = await loadUpload(ctx, id);
  return new Response(null, { status: 204, headers: uploadHeaders(ctx.target, id, row.offset) });
}

/** `DELETE .../uploads/<id>`: cancels the upload and deletes its spool file (`204`). */
export function cancelUpload(ctx: HostedCtx, id: string): Promise<Response> {
  return withLock(id, async () => {
    await loadUpload(ctx, id);
    await discard(ctx, id);
    return new Response(null, { status: 204, headers: { ...API_VERSION } });
  });
}

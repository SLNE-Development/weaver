import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DockerHostedConfig } from "@weaver/core";
import { dockerBlob, dockerBlobLink, dockerManifest, dockerManifestRef, dockerTag, type Db, type Tx } from "@weaver/db";
import { syncImageComponents } from "../components.js";
import { DockerError } from "../errors.js";
import { parseManifest, type Descriptor, type ParsedManifest, type Platform } from "../manifest-parse.js";
import { isDigest } from "../media-types.js";
import { API_VERSION, findLinkedBlob, type HostedCtx, type HostedReadCtx } from "./blobs.js";

/** The largest manifest body accepted, in bytes. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/** The largest config blob read to learn an image's platform, in bytes. */
const MAX_CONFIG_READ = 1024 * 1024;

const IMAGE_CONFIG_TYPES = new Set([
  "application/vnd.docker.container.image.v1+json",
  "application/vnd.oci.image.config.v1+json",
]);

/** A manifest as stored: its exact bytes plus the columns needed to serve it. */
export interface StoredManifest {
  id: string;
  digest: string;
  mediaType: string;
  size: number;
  content: Buffer;
  subjectDigest: string | null;
}

/** The `404 MANIFEST_UNKNOWN` error for `reference`. */
export function manifestUnknown(reference: string): DockerError {
  return new DockerError(404, "MANIFEST_UNKNOWN", "manifest unknown to registry", { reference });
}

function tooLarge(): DockerError {
  return new DockerError(413, "SIZE_INVALID", `manifest exceeds ${MAX_MANIFEST_BYTES} bytes`, { max: MAX_MANIFEST_BYTES });
}

/** Reads a request body of at most {@link MAX_MANIFEST_BYTES}, counting bytes as they stream in; more → `413 SIZE_INVALID`. */
async function readManifestBody(req: Request): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
    await req.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MANIFEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** The manifest `reference` (a tag or a digest) names in repo/image, or null. */
export async function findManifest(db: Db, repoId: string, image: string, reference: string): Promise<StoredManifest | null> {
  const columns = {
    id: dockerManifest.id,
    digest: dockerManifest.digest,
    mediaType: dockerManifest.mediaType,
    size: dockerManifest.size,
    content: dockerManifest.content,
    subjectDigest: dockerManifest.subjectDigest,
  };
  if (isDigest(reference)) {
    const [row] = await db
      .select(columns)
      .from(dockerManifest)
      .where(and(eq(dockerManifest.repositoryId, repoId), eq(dockerManifest.image, image), eq(dockerManifest.digest, reference)))
      .limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select(columns)
    .from(dockerTag)
    .innerJoin(dockerManifest, eq(dockerManifest.id, dockerTag.manifestId))
    .where(and(eq(dockerTag.repositoryId, repoId), eq(dockerTag.image, image), eq(dockerTag.tag, reference)))
    .limit(1);
  return row ?? null;
}

/** Whether a platform names a real target (buildx attestation entries use `unknown/unknown`). */
function isRealPlatform(p: Platform): boolean {
  return !(p.os === "unknown" && p.architecture === "unknown");
}

/** The platform recorded in an image config blob, or null when the blob is not an image config, too large or unreadable. */
async function platformFromConfig(ctx: HostedCtx, config: Descriptor): Promise<Platform | null> {
  if (!IMAGE_CONFIG_TYPES.has(config.mediaType) || config.size > MAX_CONFIG_READ) return null;
  const blob = await findLinkedBlob(ctx.deps.db, ctx.target.repo.id, ctx.target.image, config.digest);
  const store = blob && ctx.deps.stores.get(blob.store);
  if (!blob || !store) return null;
  const read = await store.get(blob.storageKey);
  if (!read) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of read.body as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_CONFIG_READ) {
      read.body.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (typeof json.os !== "string" || typeof json.architecture !== "string") return null;
    const platform: Platform = { os: json.os, architecture: json.architecture };
    if (typeof json.variant === "string" && json.variant) platform.variant = json.variant;
    return platform;
  } catch {
    return null;
  }
}

/** What a validated manifest contributes to its row: platforms, total size and the blobs that must stay linked. */
interface Derived {
  platforms: Platform[];
  totalSize: number;
  /** Digests of the config and non-foreign layers, which must be linked in the image (empty for an index). */
  required: string[];
}

/**
 * Checks that everything `parsed` references exists in the target image: config and non-foreign layers must be
 * linked blobs (`400 MANIFEST_BLOB_UNKNOWN`), index children stored manifests (`400 MANIFEST_UNKNOWN`).
 * Resolves to the platforms and total size of the manifest.
 */
async function validateReferences(ctx: HostedCtx, parsed: ParsedManifest): Promise<Derived> {
  const { db } = ctx.deps;
  const { repo, image } = ctx.target;
  if (parsed.isIndex) {
    const digests = [...new Set(parsed.manifests.map((d) => d.digest))];
    const rows =
      digests.length === 0
        ? []
        : await db
            .select({ digest: dockerManifest.digest, totalSize: dockerManifest.totalSize })
            .from(dockerManifest)
            .where(and(eq(dockerManifest.repositoryId, repo.id), eq(dockerManifest.image, image), inArray(dockerManifest.digest, digests)));
    const found = new Map(rows.map((r) => [r.digest, r.totalSize]));
    const missing = digests.find((d) => !found.has(d));
    if (missing) throw new DockerError(400, "MANIFEST_UNKNOWN", "manifest references an unknown child manifest", { digest: missing });
    return {
      platforms: parsed.manifests.flatMap((d) => (d.platform && isRealPlatform(d.platform) ? [d.platform] : [])),
      totalSize: digests.reduce((sum, d) => sum + found.get(d)!, 0),
      required: [],
    };
  }

  const config = parsed.config!;
  // Only layers may be foreign (served from `urls`); the config is always a linked blob.
  const required = [...new Set([config, ...parsed.layers.filter((d) => !d.urls)].map((d) => d.digest))];
  const linked = await db
    .select({ digest: dockerBlobLink.digest })
    .from(dockerBlobLink)
    .where(and(eq(dockerBlobLink.repositoryId, repo.id), eq(dockerBlobLink.image, image), inArray(dockerBlobLink.digest, required)));
  const have = new Set(linked.map((r) => r.digest));
  const missing = required.find((d) => !have.has(d));
  if (missing) throw new DockerError(400, "MANIFEST_BLOB_UNKNOWN", "manifest references an unknown blob", { digest: missing });
  const platform = await platformFromConfig(ctx, config);
  return {
    platforms: platform && isRealPlatform(platform) ? [platform] : [],
    totalSize: parsed.layers.reduce((sum, d) => sum + d.size, config.size),
    required,
  };
}

/** The blobs and child manifests of `parsed` as ref rows of manifest `manifestId`, first occurrence of each digest kept. */
function refRowsOf(manifestId: string, parsed: ParsedManifest): Array<typeof dockerManifestRef.$inferInsert> {
  const entries: Array<{ d: Descriptor; kind: "blob" | "manifest" }> = parsed.isIndex
    ? parsed.manifests.map((d) => ({ d, kind: "manifest" as const }))
    : [parsed.config!, ...parsed.layers].map((d) => ({ d, kind: "blob" as const }));
  const seen = new Set<string>();
  const rows: Array<typeof dockerManifestRef.$inferInsert> = [];
  entries.forEach(({ d, kind }, position) => {
    if (seen.has(d.digest)) return;
    seen.add(d.digest);
    rows.push({ manifestId, digest: d.digest, kind, mediaType: d.mediaType, size: d.size, position });
  });
  return rows;
}

/** The `400 MANIFEST_BLOB_UNKNOWN` error for `digest`. */
function blobUnknownInManifest(digest: string | undefined): DockerError {
  return new DockerError(400, "MANIFEST_BLOB_UNKNOWN", "manifest references an unknown blob", { digest: digest ?? null });
}

/**
 * Inside the manifest write transaction: stamps the blobs and links of `required` (lock order blob rows, then
 * links, each sorted, the same as `linkBlob`, so concurrent pushes cannot deadlock), so garbage collection
 * neither deletes them before the transaction commits nor counts them as stale afterwards. A link or blob
 * collected since the fast check outside the transaction is `400 MANIFEST_BLOB_UNKNOWN`.
 */
async function touchRequired(tx: Tx, repoId: string, image: string, required: string[]): Promise<void> {
  if (required.length === 0) return;
  const linkWhere = and(eq(dockerBlobLink.repositoryId, repoId), eq(dockerBlobLink.image, image), inArray(dockerBlobLink.digest, required));
  const links = await tx.select({ digest: dockerBlobLink.digest, blobId: dockerBlobLink.blobId }).from(dockerBlobLink).where(linkWhere);
  const missingLink = required.find((d) => !links.some((l) => l.digest === d));
  if (missingLink) throw blobUnknownInManifest(missingLink);

  const blobIds = [...new Set(links.map((l) => l.blobId))].sort();
  await tx.select({ id: dockerBlob.id }).from(dockerBlob).where(inArray(dockerBlob.id, blobIds)).orderBy(asc(dockerBlob.id)).for("update");
  const blobs = await tx.update(dockerBlob).set({ lastLinkedAt: sql`now()` }).where(inArray(dockerBlob.id, blobIds)).returning({ id: dockerBlob.id });
  if (blobs.length < blobIds.length) {
    const gone = links.find((l) => !blobs.some((b) => b.id === l.blobId));
    throw blobUnknownInManifest(gone?.digest);
  }

  await tx.select({ digest: dockerBlobLink.digest }).from(dockerBlobLink).where(linkWhere).orderBy(asc(dockerBlobLink.digest)).for("update");
  const touched = await tx.update(dockerBlobLink).set({ createdAt: sql`now()` }).where(linkWhere).returning({ digest: dockerBlobLink.digest });
  if (touched.length < required.length) throw blobUnknownInManifest(required.find((d) => !touched.some((t) => t.digest === d)));
}

/**
 * Inside the manifest write transaction of an index: takes a key-share lock on the stored child manifests
 * (sorted by id, after the blob and link locks), so a concurrent cleanup or DELETE cannot remove a child
 * before the index referencing it commits. A child deleted since the check outside the transaction is
 * `400 MANIFEST_UNKNOWN`.
 */
async function holdChildren(tx: Tx, repoId: string, image: string, children: string[]): Promise<void> {
  const digests = [...new Set(children)];
  if (digests.length === 0) return;
  const rows = await tx
    .select({ id: dockerManifest.id, digest: dockerManifest.digest })
    .from(dockerManifest)
    .where(and(eq(dockerManifest.repositoryId, repoId), eq(dockerManifest.image, image), inArray(dockerManifest.digest, digests)))
    .orderBy(asc(dockerManifest.id))
    .for("key share");
  const missing = digests.find((d) => !rows.some((r) => r.digest === d));
  if (missing) throw new DockerError(400, "MANIFEST_UNKNOWN", "manifest references an unknown child manifest", { digest: missing });
}

/** Whether `err` (or an error it wraps) is a Postgres foreign key violation (`23503`). */
function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if ((e as { code?: unknown }).code === "23503") return true;
  }
  return false;
}

/** The artifact type of a manifest as the referrers API reports it: `artifactType`, else the config media type. */
function effectiveArtifactType(parsed: ParsedManifest): string | null {
  return parsed.artifactType ?? parsed.config?.mediaType ?? null;
}

/**
 * `PUT .../manifests/<reference>`: stores the exact pushed bytes (at most 4 MiB, `413 SIZE_INVALID`) under their
 * sha256 digest after validating shape and references; a digest reference must match (`400 DIGEST_INVALID`).
 * Row, refs and tag are written in one transaction that first refreshes the referenced blobs and links (so garbage collection keeps them) and holds the child manifests of an index (so cleanup keeps them); on a `tagImmutable` repository moving an existing tag to
 * another digest is `403 DENIED`. A concurrent DELETE of the same digest mid-transaction is retried once, then
 * answered `503 UNAVAILABLE`. Answers `201` with `Location`, `Docker-Content-Digest` and, for a manifest with a
 * subject, `OCI-Subject`.
 */
export async function putManifest(ctx: HostedCtx, req: Request, reference: string): Promise<Response> {
  const { deps, target } = ctx;
  const body = await readManifestBody(req);
  const byDigest = isDigest(reference);
  const algorithm = byDigest ? reference.slice(0, reference.indexOf(":")) : "sha256";
  const digest = `${algorithm}:${createHash(algorithm).update(body).digest("hex")}`;
  if (byDigest && digest !== reference) {
    throw new DockerError(400, "DIGEST_INVALID", "provided digest did not match uploaded content", { digest: reference });
  }
  const parsed = parseManifest(body, req.headers.get("content-type"));
  const derived = await validateReferences(ctx, parsed);
  const tagImmutable = (target.repo.config as Partial<DockerHostedConfig>).tagImmutable === true;
  const repoId = target.repo.id;
  const image = target.image;

  /** One attempt at the write transaction; false when a concurrent DELETE removed the manifest mid-way. */
  const attempt = () =>
    deps.db.transaction(async (tx): Promise<boolean> => {
      if (!byDigest) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`docker-tag:${repoId}:${image}:${reference}`}, 0))`);
      }
      await ctx.opts.onManifestPutStep?.("begin");
      await touchRequired(tx, repoId, image, derived.required);
      if (parsed.isIndex) await holdChildren(tx, repoId, image, parsed.manifests.map((d) => d.digest));
      const [inserted] = await tx
        .insert(dockerManifest)
        .values({
          repositoryId: repoId,
          image,
          digest,
          mediaType: parsed.mediaType,
          artifactType: effectiveArtifactType(parsed),
          subjectDigest: parsed.subject?.digest ?? null,
          annotations: parsed.annotations,
          platforms: derived.platforms,
          size: body.length,
          totalSize: derived.totalSize,
          content: body,
        })
        .onConflictDoNothing()
        .returning({ id: dockerManifest.id });
      await ctx.opts.onManifestPutStep?.("inserted");
      let manifestId = inserted?.id;
      if (manifestId) {
        const refs = refRowsOf(manifestId, parsed);
        if (refs.length > 0) await tx.insert(dockerManifestRef).values(refs).onConflictDoNothing();
      } else {
        const [existing] = await tx
          .select({ id: dockerManifest.id })
          .from(dockerManifest)
          .where(and(eq(dockerManifest.repositoryId, repoId), eq(dockerManifest.image, image), eq(dockerManifest.digest, digest)));
        if (!existing) return false;
        manifestId = existing.id;
      }
      await ctx.opts.onManifestPutStep?.("resolved");
      if (byDigest) return true;

      const [current] = await tx
        .select({ manifestId: dockerTag.manifestId })
        .from(dockerTag)
        .where(and(eq(dockerTag.repositoryId, repoId), eq(dockerTag.image, image), eq(dockerTag.tag, reference)));
      if (current?.manifestId === manifestId) return true;
      if (current && tagImmutable) {
        throw new DockerError(403, "DENIED", `tag ${reference} is immutable`, { tag: reference });
      }
      await tx
        .insert(dockerTag)
        .values({ repositoryId: repoId, image, tag: reference, manifestId })
        .onConflictDoUpdate({
          target: [dockerTag.repositoryId, dockerTag.image, dockerTag.tag],
          set: { manifestId, updatedAt: sql`now()` },
        });
      await syncImageComponents(tx, repoId, image);
      return true;
    });

  // A DELETE by digest committing between our insert (which found the row) and the tag write leaves no row
  // to point at; the second attempt inserts the manifest afresh.
  let stored = false;
  for (let i = 0; i < 2 && !stored; i++) {
    try {
      stored = await attempt();
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err;
    }
  }
  if (!stored) {
    throw new DockerError(503, "UNAVAILABLE", "manifest was deleted concurrently, retry the push", { digest });
  }

  await deps.usage({
    repositoryId: repoId,
    path: `${image}/manifests/${reference}`,
    action: "upload",
    bytes: body.length,
    principal: ctx.caller.principal,
  });
  const headers: Record<string, string> = {
    ...API_VERSION,
    location: `/v2/${target.name}/manifests/${digest}`,
    "docker-content-digest": digest,
    "content-length": "0",
  };
  if (parsed.subject) headers["oci-subject"] = parsed.subject.digest;
  return new Response(null, { status: 201, headers });
}

/**
 * `GET`/`HEAD .../manifests/<reference>`: the exact stored bytes with their media type, length, digest and ETag.
 * A reference by tag stamps the tag's `lastPulledAt` (also on `HEAD`); `GET` also stamps `lastPulledAt`/`pullCount`
 * on the manifest and records a download.
 * Unknown → `404 MANIFEST_UNKNOWN`.
 */
export async function serveManifest(ctx: HostedReadCtx, req: Request, reference: string): Promise<Response> {
  const { deps, target } = ctx;
  const manifest = await findManifest(deps.db, target.repo.id, target.image, reference);
  if (!manifest) throw manifestUnknown(reference);
  const headers = {
    ...API_VERSION,
    "content-type": manifest.mediaType,
    "content-length": String(manifest.size),
    "docker-content-digest": manifest.digest,
    etag: `"${manifest.digest}"`,
  };
  // containerd and buildx resolve tags with HEAD, so a HEAD by tag still counts as a use of the tag.
  if (!isDigest(reference)) {
    await deps.db
      .update(dockerTag)
      .set({ lastPulledAt: sql`now()` })
      .where(and(eq(dockerTag.repositoryId, target.repo.id), eq(dockerTag.image, target.image), eq(dockerTag.tag, reference)));
  }
  if (req.method === "HEAD") return new Response(null, { status: 200, headers });

  await deps.db
    .update(dockerManifest)
    .set({ lastPulledAt: sql`now()`, pullCount: sql`${dockerManifest.pullCount} + 1` })
    .where(eq(dockerManifest.id, manifest.id));
  await deps.usage({
    repositoryId: target.repo.id,
    path: `${target.image}/manifests/${reference}`,
    action: "download",
    bytes: manifest.size,
    principal: ctx.caller.principal,
  });
  return new Response(new Uint8Array(manifest.content), { status: 200, headers });
}

/**
 * `DELETE .../manifests/<reference>`: a tag removes only that tag; a digest removes the manifest with its tags
 * and refs (`202`). Blobs stay linked until garbage collection. Unknown → `404 MANIFEST_UNKNOWN`.
 */
export async function deleteManifest(ctx: HostedCtx, reference: string): Promise<Response> {
  const { deps, target } = ctx;
  const removed = isDigest(reference)
    ? await deps.db
        .delete(dockerManifest)
        .where(
          and(
            eq(dockerManifest.repositoryId, target.repo.id),
            eq(dockerManifest.image, target.image),
            eq(dockerManifest.digest, reference),
          ),
        )
        .returning({ id: dockerManifest.id })
    : await deps.db
        .delete(dockerTag)
        .where(and(eq(dockerTag.repositoryId, target.repo.id), eq(dockerTag.image, target.image), eq(dockerTag.tag, reference)))
        .returning({ id: dockerTag.manifestId });
  if (removed.length === 0) throw manifestUnknown(reference);
  await syncImageComponents(deps.db, target.repo.id, target.image);
  await deps.usage({
    repositoryId: target.repo.id,
    path: `${target.image}/manifests/${reference}`,
    action: "delete",
    principal: ctx.caller.principal,
  });
  return new Response(null, { status: 202, headers: { ...API_VERSION, "content-length": "0" } });
}

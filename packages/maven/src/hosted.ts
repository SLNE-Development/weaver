import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { sql } from "drizzle-orm";
import type { AssetRow, MavenHostedConfig, Repo } from "@weaver/core";
import type { Tx } from "@weaver/db";
import { checksumGeneratable, checksumText, digestOf } from "./checksum.js";
import type { MavenContext } from "./context.js";
import { compareStamps, hostedMetadataXml, snapshotFiles } from "./generate.js";
import { assetResponse, contentTypeFor, textResponse } from "./http.js";
import { parseMetadata } from "./metadata.js";
import type { ChecksumAlgo, MavenFile, MavenPath } from "./path.js";

/** Largest accepted `maven-metadata.xml` upload. */
const METADATA_LIMIT = 1024 * 1024;

/** The hosted settings of a Maven repository, with the defaults for anything missing. */
function hostedConfig(repo: Repo): MavenHostedConfig {
  const c = repo.config as Partial<MavenHostedConfig>;
  return { versionPolicy: c.versionPolicy ?? "mixed", redeploy: c.redeploy ?? false };
}

/** The 201 answer to a successful upload. */
function created(): Response {
  return new Response(null, { status: 201 });
}

/** The request body as a Node stream; an absent body is empty. */
function bodyOf(req: Request): Readable {
  return req.body ? Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>) : Readable.from([]);
}

/** The declared `Content-Length`, when it is a valid byte count. */
function contentLengthOf(req: Request): number | undefined {
  const raw = req.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/** Whether downloads and uploads of this path count as usage (not checksums, signatures or metadata). */
export function counted(target: MavenPath): boolean {
  if (target.type === "directory" || target.type === "metadata") return false;
  return target.checksum === null && !target.basePath.endsWith(".asc");
}

/** Reads a request body of at most `limit` bytes; null when it is larger. */
async function readCapped(req: Request, limit: number): Promise<Buffer | null> {
  const declared = contentLengthOf(req);
  if (declared !== undefined && declared > limit) return null;
  if (!req.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Reads and discards a request body. */
async function drain(req: Request): Promise<void> {
  if (!req.body) return;
  const reader = req.body.getReader();
  while (!(await reader.read()).done) {
    // discard
  }
}

/** Handles an uploaded `maven-metadata.xml` (or checksum): stored only for plugin group metadata. */
async function writeMetadata(ctx: MavenContext, repo: Repo, target: Extract<MavenPath, { type: "metadata" }>, req: Request): Promise<Response> {
  if (target.checksum !== null) {
    await drain(req);
    return created();
  }
  const body = await readCapped(req, METADATA_LIMIT);
  if (body === null) return textResponse(413, `maven-metadata.xml is larger than ${METADATA_LIMIT} bytes`);
  if (parseMetadata(body.toString("utf8"))?.kind === "plugins") {
    await ctx.deps.assets.put({
      repo,
      path: target.path,
      body: Readable.from([body]),
      contentType: contentTypeFor(target.path),
      origin: "hosted",
      contentLength: body.length,
      signal: req.signal,
    });
  }
  return created();
}

/**
 * Takes the transaction-scoped advisory lock of artifact `groupId:artifactId` in a repository.
 * Publishing a file and cleaning up the artifact both hold it, so a cleanup never deletes a
 * version that is being published to.
 */
export async function lockMavenArtifact(tx: Tx, repositoryId: string, groupId: string, artifactId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`maven:${repositoryId}:${groupId}:${artifactId}`}))`);
}

/** Stores an artifact file and links it to its version's component while holding the artifact lock. */
async function putFile(ctx: MavenContext, repo: Repo, target: MavenFile, req: Request): Promise<AssetRow> {
  const { assets, db } = ctx.deps;
  const staged = await assets.stage({ repo, body: bodyOf(req), origin: "hosted", contentLength: contentLengthOf(req), signal: req.signal });
  let committed: Awaited<ReturnType<typeof assets.commit>>;
  try {
    committed = await db.transaction(async (tx) => {
      await lockMavenArtifact(tx, repo.id, target.groupId, target.artifactId);
      return assets.commit(tx, staged, {
        path: target.path,
        contentType: contentTypeFor(target.path),
        component: { namespace: target.groupId, name: target.artifactId, version: target.version },
      });
    });
  } catch (error) {
    await assets.discard(staged);
    throw error;
  }
  await committed.finish();
  return committed.asset;
}

/** The reason a file may not be deployed to the repository, or null when it may. */
async function rejectFile(ctx: MavenContext, repo: Repo, target: MavenFile): Promise<Response | null> {
  const config = hostedConfig(repo);
  if (config.versionPolicy === "release" && target.snapshot) {
    return textResponse(400, `Repository ${repo.name} does not accept SNAPSHOT versions`);
  }
  if (config.versionPolicy === "snapshot" && !target.snapshot) {
    return textResponse(400, `Repository ${repo.name} only accepts SNAPSHOT versions`);
  }
  if (!target.snapshot && !config.redeploy && (await ctx.deps.assets.find(repo.id, target.path))) {
    return textResponse(409, `${target.path} already exists and redeploy is disabled for ${repo.name}`);
  }
  return null;
}

/**
 * Stores an upload to a hosted repository. Artifact- and version-level metadata (and every
 * metadata checksum) is accepted and discarded; plugin group metadata is stored. Files obey the
 * repository's version policy and redeploy setting; snapshots and `other` paths are always overwritable.
 */
export async function writeHosted(ctx: MavenContext, repo: Repo, target: MavenPath, req: Request): Promise<Response> {
  if (target.type === "directory") return textResponse(400, "Cannot upload to a directory");
  if (target.type === "metadata") return writeMetadata(ctx, repo, target, req);

  let row: AssetRow;
  if (target.type === "file") {
    const rejected = await rejectFile(ctx, repo, target);
    if (rejected) return rejected;
    row = await putFile(ctx, repo, target, req);
  } else {
    row = await ctx.deps.assets.put({
      repo,
      path: target.path,
      body: bodyOf(req),
      contentType: contentTypeFor(target.path),
      origin: "hosted",
      contentLength: contentLengthOf(req),
      signal: req.signal,
    });
  }
  if (counted(target)) {
    await ctx.deps.usage({ repositoryId: repo.id, assetId: row.id, path: row.path, action: "upload", bytes: row.size, principal: ctx.principal });
  }
  return created();
}

/** Streams a stored asset (no body for HEAD), marks it accessed and records a download when it counts. */
async function serveAsset(ctx: MavenContext, repo: Repo, asset: AssetRow, countable: boolean): Promise<Response | null> {
  if (ctx.method === "HEAD") {
    await ctx.deps.assets.touch(asset.id);
    return assetResponse(asset, null);
  }
  const read = await ctx.deps.assets.open(asset);
  if (!read) return null;
  await ctx.deps.assets.touch(asset.id);
  if (countable) {
    await ctx.deps.usage({ repositoryId: repo.id, assetId: asset.id, path: asset.path, action: "download", bytes: asset.size, principal: ctx.principal });
  }
  return assetResponse(asset, Readable.toWeb(read.body) as unknown as ReadableStream<Uint8Array>);
}

/** Serves a small generated body (metadata or a checksum) with length and etag headers. */
export function generatedResponse(ctx: MavenContext, body: string, contentType: string): Response {
  const bytes = Buffer.from(body, "utf8");
  return new Response(ctx.method === "HEAD" ? null : bytes, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.length),
      etag: `"${createHash("sha1").update(bytes).digest("hex")}"`,
    },
  });
}

/** The newest timestamped file standing in for a non-unique snapshot file name, or null. */
async function newestSnapshot(ctx: MavenContext, repo: Repo, target: MavenFile): Promise<AssetRow | null> {
  if (!target.snapshot || target.stamp !== null) return null;
  const dir = target.basePath.slice(0, target.basePath.lastIndexOf("/"));
  let best: Awaited<ReturnType<typeof snapshotFiles>>[number] | null = null;
  for (const f of await snapshotFiles(ctx.deps, repo, dir)) {
    if (f.file.classifier !== target.classifier || f.file.extension !== target.extension) continue;
    if (!best || compareStamps(f.file.stamp, best.file.stamp) > 0) best = f;
  }
  return best?.asset ?? null;
}

/** Serves a checksum of a file that was not uploaded: an uploaded sidecar of the stand-in, or the stored digest. */
async function generatedChecksum(ctx: MavenContext, repo: Repo, target: MavenFile | Extract<MavenPath, { type: "other" }>, algo: ChecksumAlgo): Promise<Response | null> {
  if (!checksumGeneratable(target.basePath)) return null;
  const base = await ctx.deps.assets.find(repo.id, target.basePath);
  if (base) return generatedResponse(ctx, digestOf(base, algo), "text/plain");
  if (target.type !== "file") return null;
  const stand = await newestSnapshot(ctx, repo, target);
  if (!stand) return null;
  const uploaded = await ctx.deps.assets.find(repo.id, `${stand.path}.${algo}`);
  if (uploaded) return serveAsset(ctx, repo, uploaded, false);
  return generatedResponse(ctx, digestOf(stand, algo), "text/plain");
}

/**
 * Serves a path of a hosted repository: the stored asset, else a generated checksum or
 * metadata document, else the newest build for a non-unique snapshot name.
 * null = not found here (lets groups continue).
 */
export async function readHosted(ctx: MavenContext, repo: Repo, target: Exclude<MavenPath, { type: "directory" }>): Promise<Response | null> {
  const stored = await ctx.deps.assets.find(repo.id, target.path);
  if (stored) return serveAsset(ctx, repo, stored, counted(target));

  if (target.type === "metadata") {
    const xml = await hostedMetadataXml(ctx.deps, repo, target.dir);
    if (xml === null) return null;
    if (target.checksum !== null) return generatedResponse(ctx, checksumText(xml, target.checksum), "text/plain");
    return generatedResponse(ctx, xml, "application/xml");
  }
  if (target.checksum !== null) return generatedChecksum(ctx, repo, target, target.checksum);
  if (target.type !== "file") return null;

  const stand = await newestSnapshot(ctx, repo, target);
  return stand ? serveAsset(ctx, repo, stand, counted(target)) : null;
}

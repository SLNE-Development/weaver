import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { and, eq, inArray, sql } from "drizzle-orm";
import { asset, component, type Tx } from "@weaver/db";
import { RegistryError, type AssetRow, type CommittedAsset, type FormatDeps, type Principal, type Repo } from "@weaver/core";
import { npmError, npmJson } from "./http.js";
import { isValidNewPackageName, tarballFile, versionFromTarball, type PackageName } from "./names.js";
import {
  ABBREVIATED_TYPE,
  abbreviate,
  rewriteTarballs,
  wantsAbbreviated,
  type Packument,
  type VersionManifest,
} from "./packument.js";
import { compareSemver } from "./semver.js";
import { formatRev, type NpmStore } from "./store.js";

/** Largest accepted publish body (JSON with the base64 tarball): 256 MiB. */
export const MAX_PUBLISH_BYTES = 256 * 1024 * 1024;

/** Strict semantic version, as the npm registry requires for published versions. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** What serving one request of a hosted npm repository works with. */
export interface HostedContext {
  deps: FormatDeps;
  store: NpmStore;
  repo: Repo;
  principal: Principal;
}

/** Own-property assignment that is safe for untrusted keys such as `__proto__`. */
function setOwn<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `${publicUrl}/npm/${repo}`: the base every tarball URL served from the repository starts with. */
function baseOf(ctx: HostedContext): string {
  return `${ctx.deps.publicUrl}/npm/${ctx.repo.name}`;
}

/** The asset path of a tarball: `<name>/-/<file>`. */
function tarballPath(name: PackageName, file: string): string {
  return `${name.full}/-/${file}`;
}

/** Reads a request body into memory, failing with 413 once it exceeds `limit` bytes (declared or actual). */
export async function readBody(req: Request, limit: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new RegistryError("payload_too_large", "request body too large");
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError("payload_too_large", "request body too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Answers HEAD with the headers of `res` and no body. */
function forMethod(req: Request, res: Response): Response {
  if (req.method.toUpperCase() !== "HEAD") return res;
  return new Response(null, { status: res.status, headers: res.headers });
}

/** `GET/HEAD <name>`: the full packument with `_rev`, or the abbreviated one when the Accept header asks for it. */
export async function servePackument(ctx: HostedContext, name: PackageName, req: Request): Promise<Response> {
  const found = await ctx.store.get(ctx.repo.id, name.full);
  if (!found) return npmError(404, "not found");
  const doc = rewriteTarballs({ ...found.document, _rev: formatRev(found.rev, found.document) }, baseOf(ctx));
  const res = wantsAbbreviated(req.headers.get("accept"))
    ? npmJson(abbreviate(doc), { headers: { "content-type": ABBREVIATED_TYPE, vary: "Accept" } })
    : npmJson(doc, { headers: { vary: "Accept" } });
  return forMethod(req, res);
}

/** `GET/HEAD <name>/<spec>`: one version manifest, `spec` being a dist-tag first, then a version. */
export async function serveVersion(ctx: HostedContext, name: PackageName, spec: string, req: Request): Promise<Response> {
  const found = await ctx.store.get(ctx.repo.id, name.full);
  if (!found) return npmError(404, "not found");
  const doc = found.document;
  const tags = doc["dist-tags"] ?? {};
  const version = Object.hasOwn(tags, spec) ? tags[spec]! : spec;
  const versions = doc.versions ?? {};
  if (!Object.hasOwn(versions, version)) return npmError(404, `version not found: ${spec}`);
  const single: Record<string, VersionManifest> = {};
  setOwn(single, version, versions[version]!);
  const rewritten = rewriteTarballs({ name: doc.name, versions: single }, baseOf(ctx));
  return forMethod(req, npmJson(rewritten.versions[version]));
}

/** `GET/HEAD <name>/-/<file>`: streams a hosted tarball; GET records a download. */
export async function serveTarball(ctx: HostedContext, name: PackageName, file: string, method: "GET" | "HEAD"): Promise<Response> {
  const path = tarballPath(name, file);
  const row = await ctx.deps.assets.find(ctx.repo.id, path);
  if (!row || row.origin !== "hosted") return npmError(404, "not found");
  const headers = { "content-type": "application/octet-stream", "content-length": String(row.size) };
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  const read = await ctx.deps.assets.open(row);
  if (!read) return npmError(404, "not found");
  await ctx.deps.usage({ repositoryId: ctx.repo.id, assetId: row.id, path, action: "download", bytes: row.size, principal: ctx.principal });
  const body = Readable.toWeb(read.body) as NodeReadableStream<Uint8Array> as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

/** Whether a client-sent `integrity` string agrees with the tarball's digests (unknown algorithms are ignored). */
function integrityMatches(integrity: string, digests: { sha1: Buffer; sha512: Buffer }): boolean {
  for (const token of integrity.trim().split(/\s+/)) {
    const dash = token.indexOf("-");
    if (dash < 0) return false;
    const algo = token.slice(0, dash).toLowerCase();
    const value = token.slice(dash + 1).split("?")[0]!;
    const expected = algo === "sha512" ? digests.sha512 : algo === "sha1" ? digests.sha1 : null;
    if (expected && value !== expected.toString("base64")) return false;
  }
  return true;
}

/** The single version, manifest and tarball of a publish body, after validating it against the URL name. */
function parsePublish(name: PackageName, body: unknown) {
  if (!isRecord(body)) throw new RegistryError("invalid_request", "invalid publish body");
  const attachments = body["_attachments"];
  if (!isRecord(attachments) || Object.keys(attachments).length === 0) {
    throw new RegistryError("invalid_request", "nothing to publish: the body has no attachments");
  }
  if (body["name"] !== name.full) throw new RegistryError("invalid_request", "package name in the body does not match the URL");
  if (!isValidNewPackageName(name.full)) throw new RegistryError("invalid_request", `invalid package name: ${name.full}`);
  const versions = body["versions"];
  const versionKeys = isRecord(versions) ? Object.keys(versions) : [];
  const attachmentKeys = Object.keys(attachments);
  if (versionKeys.length !== 1 || attachmentKeys.length !== 1) {
    throw new RegistryError("invalid_request", "a publish must contain exactly one version and one attachment");
  }
  const version = versionKeys[0]!;
  const manifest = (versions as Record<string, unknown>)[version];
  if (!SEMVER.test(version)) throw new RegistryError("invalid_request", `invalid version: ${version}`);
  if (!isRecord(manifest) || manifest["version"] !== version || (manifest["name"] !== undefined && manifest["name"] !== name.full)) {
    throw new RegistryError("invalid_request", "the version manifest does not match the package");
  }
  const attachment = attachments[attachmentKeys[0]!];
  if (!isRecord(attachment) || typeof attachment["data"] !== "string") throw new RegistryError("invalid_request", "invalid attachment");
  const tarball = Buffer.from(attachment["data"], "base64");
  if (tarball.length === 0) throw new RegistryError("invalid_request", "empty attachment");
  if (typeof attachment["length"] === "number" && attachment["length"] !== tarball.length) {
    // The digests are verified anyway; a wrong length is a client quirk, not a reason to refuse.
    console.warn(`weaver: npm publish of ${name.full}@${version}: attachment length ${attachment["length"]} differs from ${tarball.length} decoded bytes`);
  }
  const tags = body["dist-tags"];
  const distTags: Record<string, string> = {};
  if (tags !== undefined) {
    if (!isRecord(tags)) throw new RegistryError("invalid_request", "invalid dist-tags");
    for (const [tag, value] of Object.entries(tags)) {
      if (tag === "" || encodeURIComponent(tag) !== tag || typeof value !== "string") {
        throw new RegistryError("invalid_request", `invalid dist-tag: ${tag}`);
      }
      setOwn(distTags, tag, value);
    }
  }
  return { version, manifest, tarball, distTags, body };
}

/** Reads and parses a JSON request body of at most {@link MAX_PUBLISH_BYTES}. */
async function readJson(req: Request): Promise<unknown> {
  const raw = await readBody(req, MAX_PUBLISH_BYTES);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new RegistryError("invalid_request", "invalid JSON body");
  }
}

/**
 * `PUT <name>` and `PUT <name>/-rev/<rev>`: a body with attachments (and no rev in the URL) is a publish, anything
 * else is a modification (deprecate, version unpublish) of the packument at the rev from the URL or the body.
 */
export async function putPackument(ctx: HostedContext, name: PackageName, rev: string | null, req: Request): Promise<Response> {
  const body = await readJson(req);
  const attachments = isRecord(body) ? body["_attachments"] : undefined;
  if (rev === null && isRecord(attachments) && Object.keys(attachments).length > 0) return publish(ctx, name, body);
  if (!isRecord(body)) throw new RegistryError("invalid_request", "invalid request body");
  const bodyRev = body["_rev"];
  const expected = rev ?? (typeof bodyRev === "string" ? bodyRev : null);
  if (expected === null) throw new RegistryError("invalid_request", "nothing to publish: the body has no attachments");
  return modifyPackument(ctx, name, expected, body);
}

/** `PUT <name>` with attachments: validates the single new version, stores its tarball and adds it to the packument. */
async function publish(ctx: HostedContext, name: PackageName, parsedJson: unknown): Promise<Response> {
  const { version, manifest, tarball, distTags, body } = parsePublish(name, parsedJson);

  const sha1 = createHash("sha1").update(tarball).digest();
  const sha512 = createHash("sha512").update(tarball).digest();
  const dist = isRecord(manifest["dist"]) ? manifest["dist"] : {};
  const shasum = present(dist["shasum"]);
  if (shasum !== undefined && (typeof shasum !== "string" || shasum.toLowerCase() !== sha1.toString("hex"))) {
    throw new RegistryError("invalid_request", "integrity mismatch");
  }
  const integrity = present(dist["integrity"]);
  if (integrity !== undefined && (typeof integrity !== "string" || !integrityMatches(integrity, { sha1, sha512 }))) {
    throw new RegistryError("invalid_request", "integrity mismatch");
  }

  const file = tarballFile(name, version);
  const path = tarballPath(name, file);
  const stored: VersionManifest = {
    ...manifest,
    name: name.full,
    version,
    dist: { ...dist, shasum: sha1.toString("hex"), integrity: `sha512-${sha512.toString("base64")}`, tarball: path },
  };
  const { deps, repo, store } = ctx;
  // Streamed to the store before the package lock is taken, so a publish holds one pool connection at a time.
  const staged = await deps.assets.stage({ repo, body: Readable.from([tarball]), origin: "hosted", contentLength: tarball.length });
  let result: { rev: number; document: Packument; committed: CommittedAsset };
  try {
    result = await store.locked(repo.id, name.full, async (tx) => {
      const current = await store.get(repo.id, name.full, tx);
      const doc: Packument = current
        ? structuredClone(current.document)
        : { _id: name.full, name: name.full, "dist-tags": {}, versions: {}, time: {} };
      doc["dist-tags"] = isRecord(doc["dist-tags"]) ? doc["dist-tags"] : {};
      doc.versions = isRecord(doc.versions) ? doc.versions : {};
      doc.time = isRecord(doc.time) ? doc.time : {};
      if (publishedBefore(doc, version)) {
        throw new RegistryError("immutable", `You cannot publish over the previously published versions: ${version}.`);
      }
      for (const [tag, target] of Object.entries(distTags)) {
        if (target !== version && !Object.hasOwn(doc.versions, target)) {
          throw new RegistryError("invalid_request", `dist-tag ${tag} points to an unknown version: ${target}`);
        }
      }

      const committed = await deps.assets.commit(tx, staged, {
        path,
        contentType: "application/octet-stream",
        component: { namespace: name.scope, name: name.bare, version, metadata: stored },
      });

      const now = new Date().toISOString();
      setOwn(doc.versions, version, stored);
      for (const [tag, target] of Object.entries(distTags)) setOwn(doc["dist-tags"], tag, target);
      if (!Object.hasOwn(doc["dist-tags"], "latest")) setOwn(doc["dist-tags"], "latest", version);
      setOwn(doc.time, version, now);
      setOwn(doc.time, "modified", now);
      if (!Object.hasOwn(doc.time, "created")) setOwn(doc.time, "created", now);
      const readme = typeof body["readme"] === "string" ? body["readme"] : manifest["readme"];
      if (typeof readme === "string") doc.readme = readme;
      const description = typeof body["description"] === "string" ? body["description"] : manifest["description"];
      if (typeof description === "string") doc.description = description;
      if (Array.isArray(manifest["keywords"])) doc["keywords"] = manifest["keywords"];
      const rev = await store.save(tx, repo.id, name.full, doc, current?.rev ?? null);
      return { rev, document: doc, committed };
    });
  } catch (error) {
    // The transaction rolled back the asset row and any component it created; only the object is left.
    await deps.assets.discard(staged);
    throw error;
  }
  await result.committed.finish();

  const asset = result.committed.asset;
  await deps.usage({ repositoryId: repo.id, assetId: asset.id, path, action: "upload", bytes: tarball.length, principal: ctx.principal });
  return npmJson({ ok: true, id: name.full, rev: formatRev(result.rev, result.document) }, { status: 201 });
}

/** A digest field the client sent, or undefined when it is missing, null or blank. */
function present(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

/** The version without build metadata (`1.0.0+b` is `1.0.0`). */
function withoutBuild(version: string): string {
  const plus = version.indexOf("+");
  return plus < 0 ? version : version.slice(0, plus);
}

/**
 * Whether the version, or one differing from it only in build metadata, is or was published: present in
 * `versions` or left as a tombstone in `time`.
 */
function publishedBefore(doc: Packument, version: string): boolean {
  const base = withoutBuild(version);
  const keys = [...Object.keys(doc.versions), ...Object.keys(doc.time).filter((k) => k !== "created" && k !== "modified")];
  return keys.some((k) => withoutBuild(k) === base);
}

/** Throws 409 unless `rev` is the current revision of the stored packument. */
function checkRev(current: { document: Packument; rev: number }, rev: string): void {
  if (formatRev(current.rev, current.document) !== rev) throw new RegistryError("immutable", "document update conflict");
}

/**
 * Deletes the asset rows `rows` and the components of the package (all of them, or only `versions`) inside `tx`.
 * The objects behind the rows are removed by {@link deleteObjects} once `tx` has committed.
 */
async function dropAssets(tx: Tx, ctx: HostedContext, name: PackageName, rows: AssetRow[], versions: string[] | null): Promise<void> {
  if (rows.length > 0) {
    await tx.delete(asset).where(inArray(asset.id, rows.map((r) => r.id)));
  }
  const scope = and(eq(component.repositoryId, ctx.repo.id), eq(component.namespace, name.scope), eq(component.name, name.bare));
  await tx.delete(component).where(versions === null ? scope : and(scope, inArray(component.version, versions)));
}

/** Deletes the stored objects of removed assets; failures only leave orphans and are logged. */
async function deleteObjects(ctx: HostedContext, rows: AssetRow[]): Promise<void> {
  for (const row of rows) {
    try {
      await ctx.deps.stores.get(row.store)?.delete(row.storageKey);
    } catch (error) {
      console.warn(`weaver: failed to delete asset object ${row.storageKey}`, error);
    }
  }
}

/** The asset rows of a repository whose path equals one of `paths`, read through `tx`. */
async function assetsAt(tx: Tx, repoId: string, paths: string[]): Promise<AssetRow[]> {
  if (paths.length === 0) return [];
  return (await tx.select().from(asset).where(and(eq(asset.repositoryId, repoId), inArray(asset.path, paths)))) as AssetRow[];
}

/**
 * Applies a client-sent packument to the stored one at `rev`: versions missing from the body are unpublished (asset
 * and component deleted, `time` entry kept as tombstone, tags dropped, `latest` re-pointed), and for kept versions
 * only `deprecated` is taken over (an empty string clears it).
 */
async function modifyPackument(ctx: HostedContext, name: PackageName, rev: string, body: Record<string, unknown>): Promise<Response> {
  const sent = body["versions"];
  if (!isRecord(sent)) throw new RegistryError("invalid_request", "invalid packument: versions missing");
  const { repo, store } = ctx;
  const result = await store.locked(repo.id, name.full, async (tx) => {
    const current = await store.get(repo.id, name.full, tx);
    if (!current) throw new RegistryError("not_found", "not found");
    checkRev(current, rev);
    const doc = structuredClone(current.document);
    const versions = isRecord(doc.versions) ? doc.versions : {};
    const tags = isRecord(doc["dist-tags"]) ? doc["dist-tags"] : {};
    const time = isRecord(doc.time) ? doc.time : {};
    doc.versions = versions;
    doc["dist-tags"] = tags;
    doc.time = time;

    for (const v of Object.keys(sent)) {
      if (!Object.hasOwn(versions, v)) throw new RegistryError("invalid_request", `version ${v} does not exist`);
    }
    const removed = Object.keys(versions).filter((v) => !Object.hasOwn(sent, v));
    if (removed.length > 0 && removed.length === Object.keys(versions).length) {
      throw new RegistryError("invalid_request", "use npm unpublish --force");
    }

    let changed = false;
    for (const [v, manifest] of Object.entries(sent)) {
      const deprecated = isRecord(manifest) ? manifest["deprecated"] : undefined;
      if (typeof deprecated !== "string") continue;
      const target = versions[v]!;
      if (deprecated === "") {
        if (target.deprecated !== undefined) {
          delete target.deprecated;
          changed = true;
        }
      } else if (target.deprecated !== deprecated) {
        target.deprecated = deprecated;
        changed = true;
      }
    }

    let dropped: AssetRow[] = [];
    if (removed.length > 0) {
      changed = true;
      dropped = await assetsAt(tx, repo.id, removed.map((v) => tarballPath(name, tarballFile(name, v))));
      await dropAssets(tx, ctx, name, dropped, removed);
      for (const v of removed) delete versions[v];
      for (const [tag, target] of Object.entries(tags)) {
        if (typeof target === "string" && removed.includes(target)) delete tags[tag];
      }
      if (!Object.hasOwn(tags, "latest")) {
        const highest = Object.keys(versions).sort(compareSemver).at(-1);
        if (highest !== undefined) setOwn(tags, "latest", highest);
      }
    }
    if (changed) setOwn(time, "modified", new Date().toISOString());
    const saved = changed ? await store.save(tx, repo.id, name.full, doc, current.rev) : current.rev;
    return { rev: saved, document: doc, dropped };
  });
  await deleteObjects(ctx, result.dropped);
  return npmJson({ ok: true, id: name.full, rev: formatRev(result.rev, result.document) });
}

/** `DELETE <name>/-rev/<rev>`: removes the whole package (row, components, every tarball), freeing the name. */
export async function unpublishPackage(ctx: HostedContext, name: PackageName, rev: string): Promise<Response> {
  const { repo, store } = ctx;
  const dropped = await store.locked(repo.id, name.full, async (tx) => {
    const current = await store.get(repo.id, name.full, tx);
    if (!current) throw new RegistryError("not_found", "not found");
    checkRev(current, rev);
    const prefix = `${name.full}/-/`;
    const rows = (await tx
      .select()
      .from(asset)
      .where(and(eq(asset.repositoryId, repo.id), sql`starts_with(${asset.path}, ${prefix})`))) as AssetRow[];
    await dropAssets(tx, ctx, name, rows, null);
    await store.remove(tx, repo.id, name.full);
    return rows;
  });
  await deleteObjects(ctx, dropped);
  return npmJson({ ok: true });
}

/**
 * `DELETE <name>/-/<file>/-rev/<rev>`: npm sends it after the packument PUT of a version unpublish. The tarball is
 * already gone by then, so this only confirms that its version is a tombstone (200), else 404.
 */
export async function confirmTarballRemoved(ctx: HostedContext, name: PackageName, file: string): Promise<Response> {
  const version = versionFromTarball(name, file);
  const found = await ctx.store.get(ctx.repo.id, name.full);
  if (!found || version === null) return npmError(404, "not found");
  const doc = found.document;
  const gone = !Object.hasOwn(doc.versions ?? {}, version) && Object.hasOwn(doc.time ?? {}, version);
  return gone ? npmJson({ ok: true }) : npmError(404, "not found");
}

/** `GET -/package/<name>/dist-tags`: the `{ tag: version }` map. */
export async function listDistTags(ctx: HostedContext, name: PackageName): Promise<Response> {
  const found = await ctx.store.get(ctx.repo.id, name.full);
  if (!found) return npmError(404, "not found");
  return npmJson(found.document["dist-tags"] ?? {});
}

/** `PUT -/package/<name>/dist-tags/<tag>`: points `tag` at the version in the JSON string body. */
export async function setDistTag(ctx: HostedContext, name: PackageName, tag: string, req: Request): Promise<Response> {
  const version = await readJson(req);
  if (typeof version !== "string" || version === "") throw new RegistryError("invalid_request", "the body must be a version string");
  if (encodeURIComponent(tag) !== tag || SEMVER.test(tag)) throw new RegistryError("invalid_request", `invalid dist-tag: ${tag}`);
  const { repo, store } = ctx;
  await store.locked(repo.id, name.full, async (tx) => {
    const current = await store.get(repo.id, name.full, tx);
    if (!current) throw new RegistryError("not_found", "not found");
    const doc = structuredClone(current.document);
    if (!isRecord(doc.versions) || !Object.hasOwn(doc.versions, version)) {
      throw new RegistryError("invalid_request", `version ${version} does not exist`);
    }
    doc["dist-tags"] = isRecord(doc["dist-tags"]) ? doc["dist-tags"] : {};
    doc.time = isRecord(doc.time) ? doc.time : {};
    setOwn(doc["dist-tags"], tag, version);
    setOwn(doc.time, "modified", new Date().toISOString());
    await store.save(tx, repo.id, name.full, doc, current.rev);
  });
  return npmJson({ ok: true }, { status: 201 });
}

/** `DELETE -/package/<name>/dist-tags/<tag>`: removes a tag other than `latest`. */
export async function removeDistTag(ctx: HostedContext, name: PackageName, tag: string): Promise<Response> {
  if (tag === "latest") throw new RegistryError("invalid_request", "cannot remove the latest tag");
  const { repo, store } = ctx;
  await store.locked(repo.id, name.full, async (tx) => {
    const current = await store.get(repo.id, name.full, tx);
    if (!current) throw new RegistryError("not_found", "not found");
    const doc = structuredClone(current.document);
    if (!isRecord(doc["dist-tags"]) || !Object.hasOwn(doc["dist-tags"], tag)) throw new RegistryError("not_found", `tag ${tag} not found`);
    delete doc["dist-tags"][tag];
    doc.time = isRecord(doc.time) ? doc.time : {};
    setOwn(doc.time, "modified", new Date().toISOString());
    await store.save(tx, repo.id, name.full, doc, current.rev);
  });
  return npmJson({ ok: true });
}

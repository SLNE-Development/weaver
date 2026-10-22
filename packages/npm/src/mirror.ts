import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { RegistryError, type FormatDeps, type MirrorConfig, type MirrorFetch, type MirrorResponse, type Principal, type Repo } from "@weaver/core";
import { npmError, npmJson } from "./http.js";
import { upstreamPackagePath, versionFromTarball, type PackageName } from "./names.js";
import {
  ABBREVIATED_TYPE,
  abbreviate,
  rewriteTarballs,
  wantsAbbreviated,
  type AbbreviatedPackument,
  type Packument,
  type VersionManifest,
} from "./packument.js";
import type { NpmRoute } from "./route.js";

/** Largest upstream packument read into memory: 128 MiB. */
export const MAX_UPSTREAM_PACKUMENT_BYTES = 128 * 1024 * 1024;

/** Mirror answer headers passed on to clients with a tarball. */
const TARBALL_HEADERS = ["content-type", "content-length", "etag", "last-modified"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-property assignment that is safe for untrusted keys such as `__proto__`. */
function setOwn<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Cancels an unused mirror body so the upstream connection and any cache write are released. */
async function discard(res: MirrorResponse): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** Whether a mirror answer must not reach an npm client: an upstream 401/403 or a redirect left after following redirects. */
function unusable(res: MirrorResponse): boolean {
  return res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400);
}

/**
 * The cached copy at `key`, served as stale; null when caching is off or nothing readable is cached. A copy that
 * cannot be opened or touched (store failure) counts as none, as in the mirror engine.
 */
async function staleCopy(deps: FormatDeps, repo: Repo, key: string, method: "GET" | "HEAD"): Promise<MirrorResponse | null> {
  if (!(repo.config as MirrorConfig).cache.enabled) return null;
  const row = await deps.assets.find(repo.id, key);
  if (!row) return null;
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    if (method === "GET") {
      const read = await deps.assets.open(row);
      if (!read) return null;
      body = Readable.toWeb(read.body) as NodeReadableStream<Uint8Array> as unknown as ReadableStream<Uint8Array>;
    }
    await deps.assets.touch(row.id);
  } catch (error) {
    await body?.cancel().catch(() => undefined);
    console.warn(`weaver: npm mirror ${repo.name} could not read its cached ${key}`, error);
    return null;
  }
  const headers = new Headers({ "content-length": String(row.size), etag: `"${row.sha256}"`, "last-modified": row.updatedAt.toUTCString() });
  if (row.contentType) headers.set("content-type", row.contentType);
  return { status: 200, headers, body, cache: "stale", asset: row, upstreamUrl: null };
}

/**
 * Fetches through the mirror engine; null when not found. An upstream 401/403 or a 3xx is never passed on (the
 * handler would turn a 401 into a client challenge, and upstream credentials are not the client's to fix): the
 * cached copy is served instead when there is one, else it fails with `upstream_unavailable`. Any other non-200
 * answer counts as not found.
 */
async function fetchThrough(deps: FormatDeps, req: MirrorFetch & { cacheKey: string }): Promise<MirrorResponse | null> {
  const res = await deps.mirror.fetch(req);
  if (res === null) return null;
  if (res.status === 200) return res;
  await discard(res);
  if (!unusable(res)) return null;
  const stale = await staleCopy(deps, req.repo, req.cacheKey, req.method ?? "GET");
  if (stale) return stale;
  throw new RegistryError("upstream_unavailable", `the upstream of ${req.repo.name} answered ${res.status}`);
}

/** Reads a packument body as text, failing with `502 upstream packument too large` beyond the 128 MiB cap. */
async function readPackumentText(repo: Repo, body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new RegistryError("upstream_unavailable", `reading a packument of ${repo.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_UPSTREAM_PACKUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError("upstream_unavailable", "upstream packument too large");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Packument from a mirror, parsed and rewritten for `servingRepo`; null when the engine returns null.
 *
 * The full and the abbreviated packument are cached separately (`<name>/.packument`, `<name>/.corgi`). When the
 * abbreviated one was asked for but the upstream answered with a full document, it is abbreviated here. Every
 * tarball URL points to `${publicUrl}/npm/${servingRepo}`. Throws `upstream_unavailable` (502) when no upstream can
 * answer and nothing is cached, for an upstream 401/403, for a document over 128 MiB and for an invalid document
 * (not an object, or a `versions` map with an entry that is not an object).
 */
export async function mirrorPackument(
  deps: FormatDeps,
  repo: Repo,
  name: PackageName,
  abbreviated: boolean,
  servingRepo: string,
): Promise<{ document: Packument | AbbreviatedPackument; cache: MirrorResponse["cache"] } | null> {
  const res = await fetchThrough(deps, {
    repo,
    path: upstreamPackagePath(name),
    subject: name.full,
    class: "metadata",
    headers: { accept: abbreviated ? ABBREVIATED_TYPE : "application/json" },
    cacheKey: `${name.full}/${abbreviated ? ".corgi" : ".packument"}`,
  });
  if (res === null) return null;
  if (res.body === null) return null;
  const text = await readPackumentText(repo, res.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RegistryError("upstream_unavailable", `the upstream of ${repo.name} sent an invalid packument`);
  }
  if (!isRecord(parsed) || !isRecord(parsed["versions"]) || !Object.values(parsed["versions"]).every(isRecord)) {
    throw new RegistryError("upstream_unavailable", `the upstream of ${repo.name} sent an invalid packument`);
  }
  // The requested name, not the upstream's claim, names the package and its tarball URLs.
  const doc = { ...parsed, name: name.full } as unknown as Packument;
  const corgi = (res.headers.get("content-type") ?? "").toLowerCase().startsWith(ABBREVIATED_TYPE);
  const shaped: Packument | AbbreviatedPackument = abbreviated && !corgi ? abbreviate(doc) : doc;
  return { document: rewriteTarballs(shaped, `${deps.publicUrl}/npm/${servingRepo}`), cache: res.cache };
}

/**
 * A tarball from a mirror, requested upstream at `<upstream package path>/-/<file>` and cached at `<name>/-/<file>`
 * (the path hosted tarballs use), linked to the component of its version. null = not found (rules, offline without
 * cache, every upstream 404 or another non-200 answer). The body streams and must be consumed or cancelled.
 * Throws `upstream_unavailable` when no upstream can serve it and nothing is cached, and for an upstream 401/403.
 */
export async function mirrorTarball(deps: FormatDeps, repo: Repo, name: PackageName, file: string, method: "GET" | "HEAD"): Promise<MirrorResponse | null> {
  const version = versionFromTarball(name, file);
  return fetchThrough(deps, {
    repo,
    path: `${upstreamPackagePath(name)}/-/${encodeURIComponent(file)}`,
    subject: name.full,
    class: "immutable",
    method,
    cacheKey: `${name.full}/-/${file}`,
    component: version === null ? undefined : { namespace: name.scope, name: name.bare, version },
  });
}

/** Answers HEAD with the headers of `res` and no body. */
function forMethod(method: string, res: Response): Response {
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

/** Streams a mirrored tarball to the client (404 when the mirror has none); a GET records a download with the engine's cache result. */
async function serveMirrorTarball(deps: FormatDeps, repo: Repo, principal: Principal, name: PackageName, file: string, method: "GET" | "HEAD"): Promise<Response> {
  const res = await mirrorTarball(deps, repo, name, file, method);
  if (res === null) return npmError(404, "not found");
  return streamMirrorTarball(deps, repo, principal, name, file, method, res);
}

/**
 * Turns a tarball answer of {@link mirrorTarball} into the client response with the tarball headers; a GET records a
 * download on `repo` with the engine's cache result (the body is cancelled when that fails).
 */
export async function streamMirrorTarball(
  deps: FormatDeps,
  repo: Repo,
  principal: Principal,
  name: PackageName,
  file: string,
  method: "GET" | "HEAD",
  res: MirrorResponse,
): Promise<Response> {
  const headers = new Headers();
  for (const header of TARBALL_HEADERS) {
    const value = res.headers.get(header);
    if (value !== null) headers.set(header, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  if (method === "GET") {
    const length = Number(res.headers.get("content-length"));
    try {
      await deps.usage({
        repositoryId: repo.id,
        assetId: res.asset?.id ?? null,
        path: `${name.full}/-/${file}`,
        action: "download",
        cache: res.cache,
        bytes: res.asset?.size ?? (Number.isSafeInteger(length) ? length : 0),
        principal,
      });
    } catch (error) {
      await discard(res);
      throw error;
    }
  }
  return new Response(res.body, { status: 200, headers });
}

/**
 * Serves the read routes of a mirror repository: packuments (abbreviated by Accept), single versions and dist-tags
 * from the upstream packument, and tarballs. Other routes answer 404; writes are refused before this is reached.
 */
export async function serveMirror(deps: FormatDeps, repo: Repo, principal: Principal, route: NpmRoute, req: Request): Promise<Response> {
  const method = req.method.toUpperCase() === "HEAD" ? "HEAD" : "GET";
  switch (route.kind) {
    case "packument": {
      if (route.rev !== null) return npmError(404, "not found");
      const abbreviated = wantsAbbreviated(req.headers.get("accept"));
      const found = await mirrorPackument(deps, repo, route.name, abbreviated, repo.name);
      if (!found) return npmError(404, "not found");
      const headers = { "content-type": abbreviated ? ABBREVIATED_TYPE : "application/json", vary: "Accept" };
      return forMethod(method, npmJson(found.document, { headers }));
    }
    case "version": {
      const found = await mirrorPackument(deps, repo, route.name, false, repo.name);
      if (!found) return npmError(404, "not found");
      const doc = found.document;
      const tags = isRecord(doc["dist-tags"]) ? doc["dist-tags"] : {};
      const version = Object.hasOwn(tags, route.spec) && typeof tags[route.spec] === "string" ? tags[route.spec]! : route.spec;
      if (!Object.hasOwn(doc.versions, version)) return npmError(404, `version not found: ${route.spec}`);
      return forMethod(method, npmJson(doc.versions[version] as VersionManifest));
    }
    case "distTags": {
      if (route.tag !== null) return npmError(404, "not found");
      const found = await mirrorPackument(deps, repo, route.name, true, repo.name);
      if (!found) return npmError(404, "not found");
      const tags: Record<string, string> = {};
      const source = isRecord(found.document["dist-tags"]) ? found.document["dist-tags"] : {};
      for (const [tag, value] of Object.entries(source)) if (typeof value === "string") setOwn(tags, tag, value);
      return forMethod(method, npmJson(tags));
    }
    case "tarball":
      if (route.rev !== null) return npmError(404, "not found");
      return serveMirrorTarball(deps, repo, principal, route.name, route.file, method);
    default:
      return npmError(404, "not found");
  }
}

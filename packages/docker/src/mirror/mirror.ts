import { Readable } from "node:stream";
import {
  RegistryError,
  type AssetRow,
  type ContentClass,
  type FormatDeps,
  type MirrorConfig,
  type MirrorResponse,
  type Repo,
} from "@weaver/core";
import type { Caller } from "../auth/authorize.js";
import { DockerError } from "../errors.js";
import { API_VERSION, blobUnknown, parseRange } from "../hosted/blobs.js";
import { MANIFEST_MEDIA_TYPES, isDigest } from "../media-types.js";
import type { Target } from "../target.js";
import type { HubAuth, UpstreamWithSecret } from "./hub-auth.js";
import { digestMatches, verifyDigest } from "./verify.js";

/** Everything a mirror operation works with: dependencies, the authorized caller, the target and the upstream token cache. */
export interface MirrorCtx {
  deps: FormatDeps;
  caller: Caller;
  target: Target;
  hub: HubAuth;
}

/** Upstream image name: Docker Hub mirrors map "nginx" to "library/nginx". */
export function upstreamImage(repo: Repo, image: string): string {
  return (repo.config as MirrorConfig).dockerHub && !image.includes("/") ? `library/${image}` : image;
}

/** Whether the mirror keeps cached assets that a request may read. */
function usesCache(repo: Repo): boolean {
  const config = repo.config as MirrorConfig;
  return config.cache.enabled || config.offline;
}

/** Releases a body that is not going to be sent. */
async function release(res: MirrorResponse): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** Whether an `upstream_unavailable` error came only from upstreams answering 429. */
function onlyRateLimited(err: RegistryError): boolean {
  const failures = (err.details as { failures?: unknown } | undefined)?.failures;
  return Array.isArray(failures) && failures.length > 0 && failures.every((f) => typeof f === "string" && / answered 429$/.test(f));
}

function unavailable(): DockerError {
  return new DockerError(502, "UNAVAILABLE", "upstream unavailable");
}

/** Evicts the cached asset at `path` when its content does not match `digest`, so it is neither served nor kept. */
async function dropMismatch(ctx: MirrorCtx, path: string, digest: string): Promise<void> {
  const row = await ctx.deps.assets.find(ctx.target.repo.id, path);
  if (row && !digestMatches(row, digest)) {
    console.warn(`weaver:docker cached ${ctx.target.repo.name}/${path} does not match ${digest}; evicting it`);
    await ctx.deps.mirror.evict(ctx.target.repo, path);
  }
}

/** Serves a cached asset as a stale answer, for an upstream that refused the request; null when there is none. */
async function cachedFallback(ctx: MirrorCtx, path: string, method: "GET" | "HEAD"): Promise<MirrorResponse | null> {
  if (!usesCache(ctx.target.repo)) return null;
  const row = await ctx.deps.assets.find(ctx.target.repo.id, path);
  if (!row) return null;
  let body: ReadableStream<Uint8Array> | null = null;
  if (method === "GET") {
    const read = await ctx.deps.assets.open(row);
    if (!read) return null;
    body = Readable.toWeb(read.body) as unknown as ReadableStream<Uint8Array>;
  }
  return { status: 200, headers: new Headers(), body, cache: "stale", asset: row, upstreamUrl: null };
}

/**
 * Asks the mirror engine for `path` below the upstream base, authorizing with cached upstream tokens for
 * `repository:<image>:pull` and answering bearer challenges. Resolves to a 200 answer or null (not found,
 * denied by the mirror's rules, or a missing image: a 401 `insufficient_scope` despite a token, unless a
 * cached copy exists). Upstream 429s with no cache become `429 TOOMANYREQUESTS`; any other upstream answer
 * (other 401s and 403 included, which are never passed on as a challenge) is served from the cache when
 * possible, else `502 UNAVAILABLE`.
 */
async function fetchUpstream(
  ctx: MirrorCtx,
  path: string,
  contentClass: ContentClass,
  method: "GET" | "HEAD",
  headers?: Record<string, string>,
): Promise<MirrorResponse | null> {
  const { deps, target, hub } = ctx;
  const subject = upstreamImage(target.repo, target.image);
  const scope = `repository:${subject}:pull`;
  // The upstream asked last, and whether a token went to it (cached, or fetched on a challenge).
  const seen: { upstream: UpstreamWithSecret | null; tokenSent: boolean } = { upstream: null, tokenSent: false };
  let res: MirrorResponse | null;
  try {
    res = await deps.mirror.fetch({
      repo: target.repo,
      path,
      subject,
      class: contentClass,
      method,
      headers,
      authorize: async (upstream) => {
        seen.upstream = upstream;
        const authorization = await hub.authorize(upstream, scope);
        seen.tokenSent = authorization !== null;
        return authorization;
      },
      onChallenge: async (challenge, upstream) => {
        seen.upstream = upstream;
        const authorization = await hub.onChallenge(challenge, upstream);
        if (authorization !== null) seen.tokenSent = true;
        return authorization;
      },
    });
  } catch (err) {
    if (err instanceof RegistryError && err.code === "upstream_unavailable" && onlyRateLimited(err)) {
      throw new DockerError(429, "TOOMANYREQUESTS", "the upstream registry is rate limiting requests");
    }
    throw err;
  }
  if (!res || res.status === 200) return res;
  await release(res);
  if (res.status === 401 && seen.upstream && isMissingImage(res, seen.tokenSent, hub, seen.upstream, scope)) {
    return cachedFallback(ctx, path, method);
  }
  console.warn(`weaver:docker upstream of ${target.repo.name} answered ${res.status} for ${path}`);
  const cached = await cachedFallback(ctx, path, method);
  if (cached) return cached;
  throw unavailable();
}

/**
 * Whether a final upstream 401 means the image is missing (or private to others): the upstream rejected a
 * token with `error="insufficient_scope"`, as Docker Hub does, or did so within the last 60 s. A fresh
 * rejection is remembered (and its token dropped), so repeated lookups do not ask the token realm each
 * time; a 401 while the mark holds never extends it, so the image is looked up again after 60 s.
 */
function isMissingImage(res: MirrorResponse, tokenSent: boolean, hub: HubAuth, upstream: UpstreamWithSecret, scope: string): boolean {
  // Already marked: the challenge went unanswered, so this 401 says nothing new and must not extend the mark.
  if (hub.isMissing(upstream, scope)) return true;
  const challenge = res.headers.get("www-authenticate") ?? "";
  if (!tokenSent || !/\berror\s*=\s*"?insufficient_scope"?/i.test(challenge)) return false;
  hub.markMissing(upstream, scope);
  return true;
}

/** The `/v2` response headers of a mirror answer: the content headers of the asset or the upstream, never its challenge. */
function contentHeaders(res: MirrorResponse, fallbackType: string): Headers {
  const headers = new Headers(API_VERSION);
  if (res.asset) {
    headers.set("content-type", res.asset.contentType ?? fallbackType);
    headers.set("content-length", String(res.asset.size));
    headers.set("docker-content-digest", `sha256:${res.asset.sha256}`);
    headers.set("etag", `"sha256:${res.asset.sha256}"`);
    return headers;
  }
  headers.set("content-type", res.headers.get("content-type") ?? fallbackType);
  for (const name of ["content-length", "docker-content-digest", "etag"]) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** The byte count of a `content-length` header, or undefined. */
function lengthOf(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

/**
 * The body of an upstream answer for `digest`, verified while it streams; a mismatching body errors before
 * its last chunk and any copy the cache took of it is evicted once its write settles.
 */
function verified(ctx: MirrorCtx, res: MirrorResponse, path: string, digest: string): ReadableStream<Uint8Array> {
  return verifyDigest(res.body!, digest, lengthOf(res.headers), () => {
    console.warn(`weaver:docker upstream of ${ctx.target.repo.name} sent content for ${path} that does not match ${digest}`);
    void ctx.deps.mirror
      .evict(ctx.target.repo, path)
      .catch((error: unknown) => console.warn(`weaver:docker cannot clean up ${path}`, error));
  });
}

/**
 * Records a mirror download of `path` (relative to the image's repository) with its cache result; when that
 * fails, `body` (the body about to be sent) is cancelled before the error propagates.
 */
async function recordDownload(
  ctx: MirrorCtx,
  path: string,
  res: MirrorResponse,
  bytes: number | undefined,
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  try {
    await recordUsage(ctx, path, res, bytes);
  } catch (err) {
    await body?.cancel(err).catch(() => undefined);
    throw err;
  }
}

/** Writes the usage event of a mirror download. */
async function recordUsage(ctx: MirrorCtx, path: string, res: MirrorResponse, bytes: number | undefined): Promise<void> {
  await ctx.deps.usage({
    repositoryId: ctx.target.repo.id,
    assetId: res.asset?.id ?? null,
    path: `${ctx.target.image}/${path}`,
    action: "download",
    cache: res.cache,
    bytes,
    principal: ctx.caller.principal,
  });
}

/** Fails with `502 UNAVAILABLE` when the upstream named a different digest than the one requested. */
async function checkUpstreamDigest(res: MirrorResponse, digest: string): Promise<void> {
  const named = res.asset ? null : res.headers.get("docker-content-digest");
  if (named !== null && isDigest(named) && named.split(":")[0] === digest.split(":")[0] && named !== digest) {
    await release(res);
    throw unavailable();
  }
}

/**
 * Serves a manifest through the mirror: by digest it is immutable, by tag metadata (revalidated after the
 * TTL). One fixed `Accept` list goes upstream, so a cached tag never depends on the asking client. Content
 * fetched by digest is verified against it; null when the upstream does not know the manifest.
 *
 * On a caching mirror a HEAD is fetched upstream as a GET and the body read into the cache: docker and
 * containerd resolve tags with HEAD only, so a tag cached no other way could not be served once the
 * upstream is down.
 */
export async function mirrorManifest(ctx: MirrorCtx, req: Request, reference: string): Promise<Response | null> {
  const method = req.method === "HEAD" ? "HEAD" : "GET";
  const caching = (ctx.target.repo.config as MirrorConfig).cache.enabled;
  const upstreamMethod = method === "HEAD" && caching ? "GET" : method;
  const byDigest = isDigest(reference);
  const path = `v2/${upstreamImage(ctx.target.repo, ctx.target.image)}/manifests/${reference}`;
  if (byDigest && usesCache(ctx.target.repo)) await dropMismatch(ctx, path, reference);
  const res = await fetchUpstream(ctx, path, byDigest ? "immutable" : "metadata", upstreamMethod, {
    accept: MANIFEST_MEDIA_TYPES.join(", "),
  });
  if (!res) return null;
  if (byDigest) await checkUpstreamDigest(res, reference);
  const headers = contentHeaders(res, MANIFEST_MEDIA_TYPES[0]!);
  if (byDigest) headers.set("docker-content-digest", reference);
  const named = headers.get("docker-content-digest");
  const expected = byDigest ? reference : named !== null && isDigest(named) ? named : null;
  if (method === "HEAD") {
    if (upstreamMethod === "GET" && !res.asset && res.body) {
      // Reading the body to its end completes the cache write; cancelling it would abort that write.
      const body = expected === null ? res.body : verified(ctx, res, path, expected);
      try {
        await body.pipeTo(new WritableStream());
      } catch {
        throw unavailable();
      }
    } else {
      await release(res);
    }
    return new Response(null, { status: 200, headers });
  }
  const body = res.asset || expected === null ? res.body : verified(ctx, res, path, expected);
  await recordDownload(ctx, `manifests/${reference}`, res, lengthOf(headers), body);
  return new Response(body, { status: 200, headers });
}

/** A `206` answer with `range` of a cached blob, read from its asset. */
async function rangeOfAsset(ctx: MirrorCtx, res: MirrorResponse, asset: AssetRow, range: { start: number; end: number }, headers: Headers, digest: string): Promise<Response> {
  await release(res);
  const read = await ctx.deps.assets.open(asset, range);
  if (!read) throw blobUnknown(digest);
  const length = range.end - range.start + 1;
  headers.set("content-range", `bytes ${range.start}-${range.end}/${asset.size}`);
  headers.set("content-length", String(length));
  const body = Readable.toWeb(read.body) as unknown as ReadableStream<Uint8Array>;
  await recordDownload(ctx, `blobs/${digest}`, res, length, body);
  return new Response(body, { status: 206, headers });
}

/**
 * Serves a blob through the mirror (immutable). `Range` is never sent upstream: a range of a cached blob is
 * answered `206` from the asset, otherwise the full body is sent with `200`. Cached copies and upstream bytes
 * are verified against the digest; null when the upstream does not know the blob.
 */
export async function mirrorBlob(ctx: MirrorCtx, req: Request, digest: string): Promise<Response | null> {
  const method = req.method === "HEAD" ? "HEAD" : "GET";
  const path = `v2/${upstreamImage(ctx.target.repo, ctx.target.image)}/blobs/${digest}`;
  if (usesCache(ctx.target.repo)) await dropMismatch(ctx, path, digest);
  const res = await fetchUpstream(ctx, path, "immutable", method);
  if (!res) return null;
  await checkUpstreamDigest(res, digest);
  const headers = contentHeaders(res, "application/octet-stream");
  headers.set("docker-content-digest", digest);
  if (res.asset) headers.set("accept-ranges", "bytes");
  if (method === "HEAD") {
    await release(res);
    return new Response(null, { status: 200, headers });
  }
  if (res.asset) {
    const range = parseRange(req.headers.get("range"), res.asset.size);
    if (range === null) {
      await release(res);
      throw new DockerError(416, "RANGE_INVALID", "requested range not satisfiable", { size: res.asset.size }, {
        "content-range": `bytes */${res.asset.size}`,
      });
    }
    if (range) return rangeOfAsset(ctx, res, res.asset, range, headers, digest);
  }
  const body = res.asset ? res.body : verified(ctx, res, path, digest);
  await recordDownload(ctx, `blobs/${digest}`, res, lengthOf(headers), body);
  return new Response(body, { status: 200, headers });
}

/** The upstream `Link` header with its `/v2/<upstream image>/` path pointed at the client's name; null when it points elsewhere. */
function rewriteLink(link: string | null, image: string, name: string): string | null {
  if (link === null) return null;
  const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*<)(?:https?://[^/>]*)?/v2/${escaped}/`);
  return pattern.test(link) ? link.replace(pattern, `$1/v2/${name}/`) : null;
}

/** `?<params>` with only the `allowed` query parameters of `req`, in their order; "" when none is left. */
function forwardedQuery(req: Request, allowed: readonly string[]): string {
  const out = new URLSearchParams();
  for (const [name, value] of new URL(req.url).searchParams) if (allowed.includes(name)) out.append(name, value);
  const query = out.toString();
  return query === "" ? "" : `?${query}`;
}

/**
 * Serves a metadata listing (`tags/list`, `referrers`) through the mirror with the request's `params`
 * (others, such as containerd's `ns`, are not sent upstream and do not split the cache).
 */
async function mirrorListing(
  ctx: MirrorCtx,
  req: Request,
  suffix: string,
  params: readonly string[],
  contentType: string,
  extra: string[],
): Promise<Response | null> {
  const image = upstreamImage(ctx.target.repo, ctx.target.image);
  const path = `v2/${image}/${suffix}${forwardedQuery(req, params)}`;
  const res = await fetchUpstream(ctx, path, "metadata", "GET");
  if (!res) return null;
  const headers = contentHeaders(res, contentType);
  headers.delete("docker-content-digest");
  if (!res.asset) {
    const link = rewriteLink(res.headers.get("link"), image, ctx.target.name);
    if (link !== null) headers.set("link", link);
    for (const name of extra) {
      const value = res.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
  }
  return new Response(res.body, { status: 200, headers });
}

/** Serves `tags/list` through the mirror (metadata), with an upstream `Link` rewritten to the client's name; null when unknown upstream. */
export function mirrorTags(ctx: MirrorCtx, req: Request): Promise<Response | null> {
  return mirrorListing(ctx, req, "tags/list", ["n", "last"], "application/json", []);
}

/** The media type of an OCI image index, as referrers answers use it. */
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

/** Whether `err` only says the upstream could not serve the request (unreachable, failing or rate limiting). */
function isUpstreamFailure(err: unknown): boolean {
  if (err instanceof RegistryError) return err.code === "upstream_unavailable";
  return err instanceof DockerError && (err.code === "UNAVAILABLE" || err.code === "TOOMANYREQUESTS");
}

/**
 * Serves the referrers of `digest` through the mirror (metadata); null when the upstream answers 404, so
 * clients fall back to the tag schema. When a caching mirror's upstream cannot answer and no listing is
 * cached, the answer is an empty index: docker asks for referrers while pulling, and a 502 there would fail
 * a pull that the cache can serve.
 */
export async function mirrorReferrers(ctx: MirrorCtx, req: Request, digest: string): Promise<Response | null> {
  try {
    return await mirrorListing(ctx, req, `referrers/${digest}`, ["artifactType"], OCI_INDEX, ["oci-filters-applied"]);
  } catch (err) {
    if (!usesCache(ctx.target.repo) || !isUpstreamFailure(err)) throw err;
    console.warn(`weaver:docker upstream of ${ctx.target.repo.name} cannot list referrers of ${digest}; answering an empty index`);
    return new Response(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [] }), {
      status: 200,
      headers: { ...API_VERSION, "content-type": OCI_INDEX },
    });
  }
}

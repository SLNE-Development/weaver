import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { and, eq } from "drizzle-orm";
import { asset, type Db } from "@weaver/db";
import type { AssetRow, AssetService, ComponentRef } from "../content/assets.js";
import { RegistryError } from "../errors.js";
import type { MirrorConfig } from "../repos/config.js";
import { matchesRules } from "../repos/rules.js";
import type { Repo, RepoService, UpstreamView } from "../repos/service.js";
import type { ServerSettings } from "../settings.js";
import type { StoreId, StoreSet } from "../storage/index.js";
import {
  discardBody,
  bodyEncoding,
  forwardableHeaders,
  requestUpstream,
  UPSTREAM_TIMEOUT_MS,
  UpstreamFetchError,
  upstreamAuthorization,
  upstreamUrl,
  type UpstreamWithSecret,
} from "./upstream.js";

/** Whether content never changes once published (artifacts, blobs) or is revalidated after the metadata TTL (indexes, tags). */
export type ContentClass = "immutable" | "metadata";

/** How a mirror served a request relative to its cache. */
export type CacheResult = "hit" | "miss" | "bypass" | "stale";

/** One request to a mirror repository. */
export interface MirrorFetch {
  /** kind must be "mirror" */
  repo: Repo;
  /** relative to each upstream base URL */
  path: string;
  /** what rules match against */
  subject: string;
  /** Asset path used for the cache lookup and write; defaults to `path`. Lets one upstream path cache several representations. */
  cacheKey?: string;
  class: ContentClass;
  method?: "GET" | "HEAD";
  /** forwarded (accept, etc.) */
  headers?: Record<string, string>;
  /** Links a cached asset to this component. */
  component?: ComponentRef;
  /** Called before the first request to each upstream; a non-null value is sent as Authorization instead of the upstream row's credentials. */
  authorize?: (upstream: UpstreamView & { secret: string | null }) => Promise<string | null>;
  /** Called on a 401 with WWW-Authenticate; returns an Authorization header value to retry once with, or null. */
  onChallenge?: (challenge: string, upstream: UpstreamView & { secret: string | null }) => Promise<string | null>;
}

/** What a mirror answered: the status, headers and body to send, and where they came from. */
export interface MirrorResponse {
  status: number;
  headers: Headers;
  /**
   * The content; null for HEAD. Callers must read it to the end or cancel it: an unread body holds
   * the upstream connection and, on a cache miss, stalls the cache write until its idle timeout.
   * A client that pauses reading for longer than that idle timeout (60 s) aborts the download
   * together with the cache write.
   */
  body: ReadableStream<Uint8Array> | null;
  cache: CacheResult;
  /** The cached asset served (hit, stale); null when the response came from an upstream. */
  asset: AssetRow | null;
  /** The upstream URL that answered, after redirects; null when served from the cache. */
  upstreamUrl: string | null;
}

/** Serves mirror repositories from their upstreams, optionally caching what they return. */
export interface MirrorEngine {
  /** null = not found: rules reject, offline without cache, or every upstream answered 404. Upstream 5xx, 429 and network errors with no usable cache throw RegistryError("upstream_unavailable"). */
  fetch(req: MirrorFetch): Promise<MirrorResponse | null>;
  /** Resolves once every cache write started so far has finished or failed. */
  drain(): Promise<void>;
  /**
   * Removes what the mirror cached under `cacheKey` (a fetch's `cacheKey`, else its `path`): waits
   * for any cache write still running for that key, then deletes the asset row it found, but only
   * while the row still points at the same object, and then that object. A write that replaced the
   * row meanwhile is kept, together with its object. Used when a cached body turned out to be
   * unusable; nothing cached is not an error.
   */
  evict(repo: Repo, cacheKey: string): Promise<void>;
}

/** What the mirror engine works with. */
export interface MirrorEngineDeps {
  db: Db;
  stores: StoreSet;
  repos: RepoService;
  assets: AssetService;
  settings: () => Promise<ServerSettings>;
  fetchImpl?: typeof fetch;
  /** How long an upstream may take to send response headers; defaults to {@link UPSTREAM_TIMEOUT_MS}. */
  upstreamTimeoutMs?: number;
  /** How long a cache write may go without receiving a chunk before it fails; defaults to {@link CACHE_IDLE_TIMEOUT_MS}. */
  cacheIdleTimeoutMs?: number;
}

/** How long a cache write may go without a chunk (a stalled upstream or an abandoned client body) before it is abandoned. */
export const CACHE_IDLE_TIMEOUT_MS = 60_000;

type UpstreamOutcome =
  | { kind: "response"; response: Response; url: string; abort: AbortController }
  | { kind: "not_found" }
  | { kind: "failed"; failures: string[] };

/**
 * Splits `source` into two streams that each receive every chunk. Unlike `ReadableStream.tee`, a
 * chunk is read only once every open branch wants one, so a slow branch slows the source instead
 * of the other branch's chunks piling up in memory. A cancelled branch stops counting and
 * `opts.onCancel` is told which one it was; the source is cancelled, with the last branch's
 * reason, when both are (also when that happens while a read is in flight).
 */
export function teeWithBackpressure<T>(
  source: ReadableStream<T>,
  opts: { onCancel?: (branch: 0 | 1, reason: unknown) => void } = {},
): [ReadableStream<T>, ReadableStream<T>] {
  const reader = source.getReader();
  interface Branch {
    controller: ReadableStreamDefaultController<T> | null;
    open: boolean;
    /** Resolves the branch's pending pull. */
    wake: (() => void) | null;
  }
  const branches: Branch[] = [
    { controller: null, open: true, wake: null },
    { controller: null, open: true, wake: null },
  ];
  let reading = false;
  let finished = false;
  let cancelReason: unknown;

  /** Cancels the source once no branch is open; true when it did. */
  function cancelIfUnwanted(): boolean {
    if (finished || branches.some((b) => b.open)) return false;
    finished = true;
    reader.cancel(cancelReason).catch(() => undefined);
    return true;
  }

  function settle(branch: Branch): void {
    const wake = branch.wake;
    branch.wake = null;
    wake?.();
  }

  function step(): void {
    if (reading || finished || cancelIfUnwanted()) return;
    if (!branches.every((b) => !b.open || b.wake !== null)) return;
    reading = true;
    reader.read().then(
      ({ done, value }) => {
        reading = false;
        if (done) finished = true;
        for (const branch of branches) {
          if (branch.open) {
            if (done) {
              branch.open = false;
              branch.controller!.close();
            } else {
              branch.controller!.enqueue(value);
            }
          }
          settle(branch);
        }
        // Both branches may have been cancelled while the read was in flight.
        if (!done) cancelIfUnwanted();
      },
      (error: unknown) => {
        reading = false;
        finished = true;
        for (const branch of branches) {
          if (branch.open) {
            branch.open = false;
            branch.controller!.error(error);
          }
          settle(branch);
        }
      },
    );
  }

  const branchStream = (branch: Branch, index: 0 | 1) =>
    new ReadableStream<T>({
      start(controller) {
        branch.controller = controller;
      },
      pull() {
        return new Promise<void>((resolve) => {
          branch.wake = resolve;
          step();
        });
      },
      cancel(reason) {
        branch.open = false;
        cancelReason = reason;
        settle(branch);
        opts.onCancel?.(index, reason);
        step();
      },
    });
  return [branchStream(branches[0]!, 0), branchStream(branches[1]!, 1)];
}

/** Whether a cached asset may be served without asking an upstream. */
function isFresh(asset: AssetRow, contentClass: ContentClass): boolean {
  if (contentClass === "immutable") return true;
  return asset.expiresAt !== null && asset.expiresAt.getTime() > Date.now();
}

/** The byte count of a `content-length` header, or undefined when absent or malformed. */
function parseLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : undefined;
}

/** The response headers describing a cached asset. */
function assetHeaders(asset: AssetRow): Headers {
  const headers = new Headers();
  if (asset.contentType) headers.set("content-type", asset.contentType);
  headers.set("content-length", String(asset.size));
  headers.set("etag", `"${asset.sha256}"`);
  headers.set("last-modified", asset.updatedAt.toUTCString());
  return headers;
}

/** Creates the mirror engine over the repositories, their upstreams and the asset store. */
export function createMirrorEngine(deps: MirrorEngineDeps): MirrorEngine {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const idleTimeoutMs = deps.cacheIdleTimeoutMs ?? CACHE_IDLE_TIMEOUT_MS;
  const pending = new Set<Promise<unknown>>();
  /** The cache writes still running, by repository id and cache key. */
  const pendingByKey = new Map<string, Set<Promise<unknown>>>();
  const keyOf = (repoId: string, cacheKey: string) => `${repoId}\u0000${cacheKey}`;

  /** The store cached objects go to: the mirror's, else the server default, else the primary when that one is not configured. */
  async function cacheStore(config: MirrorConfig): Promise<StoreId> {
    const wanted = config.cache.store ?? (await deps.settings()).defaultCacheStore;
    return deps.stores.get(wanted) ? wanted : deps.stores.primary.id;
  }

  /** Deletes the object of a removed asset row; failures and unconfigured stores only leave an orphan and are logged. */
  async function deleteObject(store: StoreId, key: string): Promise<void> {
    const target = deps.stores.get(store);
    if (!target) {
      console.warn(`weaver: cannot delete evicted object ${key}: store ${store} is not configured`);
      return;
    }
    try {
      await target.delete(key);
    } catch (error) {
      console.warn(`weaver: failed to delete evicted object ${key}`, error);
    }
  }

  /** Serves a cached asset and marks it accessed; null when its object is gone. */
  async function serveAsset(asset: AssetRow, method: "GET" | "HEAD", cache: "hit" | "stale"): Promise<MirrorResponse | null> {
    let body: ReadableStream<Uint8Array> | null = null;
    if (method === "GET") {
      const read = await deps.assets.open(asset).catch((error: unknown) => {
        console.warn(`weaver: cannot read cached asset ${asset.path}`, error);
        return null;
      });
      if (!read) return null;
      body = Readable.toWeb(read.body) as unknown as ReadableStream<Uint8Array>;
    }
    await deps.assets.touch(asset.id).catch((error: unknown) => console.warn(`weaver: cannot touch cached asset ${asset.path}`, error));
    return { status: 200, headers: assetHeaders(asset), body, cache, asset, upstreamUrl: null };
  }

  /** Sends the request to one upstream, retrying once with the `onChallenge` credentials after a 401 challenge. */
  async function ask(
    req: MirrorFetch,
    method: "GET" | "HEAD",
    upstream: UpstreamWithSecret,
    url: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const send = (authorization: string | null) =>
      requestUpstream(fetchImpl, url, { method, headers: req.headers ?? {}, authorization, timeoutMs, signal });
    const response = await send((await req.authorize?.(upstream)) ?? upstreamAuthorization(upstream));
    const challenge = response.status === 401 ? response.headers.get("www-authenticate") : null;
    if (challenge === null || !req.onChallenge) return response;
    const authorization = await req.onChallenge(challenge, upstream);
    if (authorization === null) return response;
    await discardBody(response);
    return send(authorization);
  }

  /**
   * Asks the upstreams in order. 404 tries the next one; 5xx, 429 and network errors count as
   * failures and try the next one too. Any other status (2xx, 3xx left after redirects, 401, 403,
   * other 4xx) wins and is passed through.
   */
  async function askUpstreams(req: MirrorFetch, method: "GET" | "HEAD"): Promise<UpstreamOutcome> {
    const failures: string[] = [];
    for (const upstream of await deps.repos.upstreamsWithSecrets(req.repo.id)) {
      const url = upstreamUrl(upstream.url, req.path);
      const abort = new AbortController();
      let response: Response;
      try {
        response = await ask(req, method, upstream, url, abort.signal);
      } catch (error) {
        if (!(error instanceof UpstreamFetchError)) throw error;
        failures.push(error.message);
        continue;
      }
      if (response.status === 404) {
        await discardBody(response);
        continue;
      }
      if (response.status >= 500 || response.status === 429) {
        await discardBody(response);
        failures.push(`${url} answered ${response.status}`);
        continue;
      }
      return { kind: "response", response, url: response.url || url, abort };
    }
    return failures.length > 0 ? { kind: "failed", failures } : { kind: "not_found" };
  }

  /**
   * Streams a 200 GET answer to the client and into the cache at once; the asset row appears once
   * the store write completes. The write, and with it the upstream request, is aborted when the
   * client cancels its body or when no chunk reaches the store for `idleTimeoutMs`.
   */
  async function cacheThrough(
    req: MirrorFetch,
    config: MirrorConfig,
    outcome: Extract<UpstreamOutcome, { kind: "response" }>,
  ): Promise<MirrorResponse> {
    const { response, url, abort } = outcome;
    const store = await cacheStore(config);
    const expiresAt = req.class === "metadata" ? new Date(Date.now() + config.cache.metadataTtlSeconds * 1000) : null;
    const decoded = bodyEncoding(response.headers, "GET", response.status) === "decoded";

    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new Error(`no data for ${idleTimeoutMs} ms`)), idleTimeoutMs);
    };
    const [client, toStore] = teeWithBackpressure(response.body!, {
      onCancel: (branch, reason) => {
        if (branch === 0) abort.abort(reason ?? new Error("the client cancelled the body"));
      },
    });
    const watched = toStore.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          armIdle();
          controller.enqueue(chunk);
        },
      }),
    );
    const body = Readable.fromWeb(watched as unknown as NodeReadableStream<Uint8Array>);
    // The store's pipeline sees the error too; this only keeps one that lands before it attaches from going uncaught.
    body.on("error", () => undefined);
    armIdle();
    const key = keyOf(req.repo.id, req.cacheKey ?? req.path);
    const write: Promise<unknown> = deps.assets
      .put({
        repo: req.repo,
        path: req.cacheKey ?? req.path,
        body,
        contentType: response.headers.get("content-type"),
        origin: "cache",
        store,
        expiresAt,
        component: req.component,
        contentLength: decoded ? undefined : parseLength(response.headers.get("content-length")),
        signal: abort.signal,
      })
      .catch((error: unknown) => {
        // Cancels the store branch (a put may fail before reading it), so the client keeps streaming without a cache entry.
        body.destroy();
        console.warn(`weaver: caching ${req.repo.name}/${req.path} from ${url} failed`, error);
      })
      .finally(() => {
        clearTimeout(idle);
        pending.delete(write);
        const forKey = pendingByKey.get(key);
        forKey?.delete(write);
        if (forKey?.size === 0) pendingByKey.delete(key);
      });
    pending.add(write);
    let forKey = pendingByKey.get(key);
    if (!forKey) pendingByKey.set(key, (forKey = new Set()));
    forKey.add(write);
    return {
      status: response.status,
      headers: forwardableHeaders(response.headers, decoded ? "decoded" : "plain"),
      body: client,
      cache: "miss",
      asset: null,
      upstreamUrl: url,
    };
  }

  return {
    async fetch(req) {
      const { repo } = req;
      if (repo.kind !== "mirror") throw new RegistryError("invalid_request", `Repository ${repo.name} is not a mirror`);
      const config = repo.config as MirrorConfig;
      if (!matchesRules(config.rules, req.subject)) return null;
      const method = req.method ?? "GET";

      const existing = config.cache.enabled || config.offline ? await deps.assets.find(repo.id, req.cacheKey ?? req.path) : null;
      if (config.offline) {
        return existing ? serveAsset(existing, method, isFresh(existing, req.class) ? "hit" : "stale") : null;
      }
      if (existing && isFresh(existing, req.class)) {
        const served = await serveAsset(existing, method, "hit");
        if (served) return served;
      }

      const outcome = await askUpstreams(req, method);
      if (outcome.kind === "response") {
        const { response, url } = outcome;
        const encoding = bodyEncoding(response.headers, method, response.status);
        // A HEAD describes what the GET would return, so it drops the encoding headers when the GET body would be decoded.
        const headerEncoding = method === "HEAD" ? bodyEncoding(response.headers, "GET", response.status) : encoding;
        // A body fetch could not decode is still encoded; it is passed through, never cached.
        if (config.cache.enabled && method === "GET" && response.status === 200 && response.body !== null && encoding !== "encoded") {
          return cacheThrough(req, config, outcome);
        }
        let body = response.body;
        if (method === "HEAD" && body !== null) {
          await discardBody(response);
          body = null;
        }
        return { status: response.status, headers: forwardableHeaders(response.headers, headerEncoding), body, cache: "bypass", asset: null, upstreamUrl: url };
      }
      if (outcome.kind === "not_found") return null;

      if (existing) {
        const served = await serveAsset(existing, method, "stale");
        if (served) return served;
      }
      throw new RegistryError("upstream_unavailable", `No upstream of ${repo.name} could serve ${req.path}`, { failures: outcome.failures });
    },

    async drain() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    async evict(repo, cacheKey) {
      const key = keyOf(repo.id, cacheKey);
      for (let writes = pendingByKey.get(key); writes && writes.size > 0; writes = pendingByKey.get(key)) {
        await Promise.allSettled([...writes]);
      }
      const existing = await deps.assets.find(repo.id, cacheKey);
      if (!existing) return;
      // Conditional, so a concurrent good write that replaced the row (same id, new object) is neither lost nor orphaned.
      const removed = await deps.db
        .delete(asset)
        .where(and(eq(asset.id, existing.id), eq(asset.storageKey, existing.storageKey)))
        .returning({ id: asset.id });
      if (removed.length === 0) return;
      await deleteObject(existing.store, existing.storageKey);
    },
  };
}

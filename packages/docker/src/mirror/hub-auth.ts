import type { UpstreamView } from "@weaver/core";

/** An upstream of a mirror with its decrypted secret, as the mirror engine hands it to its hooks. */
export type UpstreamWithSecret = UpstreamView & { secret: string | null };

/** A parsed `Bearer` challenge: where to fetch a token and for which service and scope. */
export interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

/** Fetches and caches bearer tokens of token-protected upstream registries (Docker Hub, GHCR, distribution). */
export interface HubAuth {
  /** The cached `Bearer <token>` for the upstream and scope, or null when none is cached or it expired. */
  authorize(upstream: UpstreamWithSecret, scope: string): Promise<string | null>;
  /**
   * Answers a 401 challenge: fetches a token from the challenge's realm (with the upstream's basic credentials,
   * when it has some), caches it and resolves to `Bearer <token>`; null for a non-Bearer challenge or a failed fetch.
   */
  onChallenge(challenge: string, upstream: UpstreamWithSecret): Promise<string | null>;
  /**
   * Remembers for 60 s that the upstream denied `scope` despite a token (a missing or private image), and
   * drops the cached token for it: its access was fixed when issued, so it would keep being refused.
   */
  markMissing(upstream: UpstreamWithSecret, scope: string): void;
  /** Whether `scope` was marked missing for the upstream within the last 60 s; challenges for it are not answered meanwhile. */
  isMissing(upstream: UpstreamWithSecret, scope: string): boolean;
}

/** How long before its `expires_in` a token stops being reused. */
const EXPIRY_MARGIN_MS = 30_000;
/** The token lifetime the token spec assumes when the realm sends no `expires_in`. */
const DEFAULT_EXPIRES_IN_S = 60;
/** How long a token request may take. */
const TOKEN_TIMEOUT_MS = 30_000;
/** How long a scope the upstream denied despite a token is answered as missing without asking the realm. */
const MISSING_TTL_MS = 60_000;
/** The largest token response read, in bytes. */
const MAX_TOKEN_BYTES = 64 * 1024;
/** The most cached tokens kept; beyond it expired, then oldest, entries are dropped. */
const MAX_CACHED = 1000;

/** Parses `Bearer realm="…",service="…",scope="…"`; null for other schemes or without a realm. */
export function parseChallenge(header: string): BearerChallenge | null {
  const m = /^\s*bearer\s+(.*)$/is.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  const param = /([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))\s*(?:,|$)/gi;
  for (const p of m[1]!.matchAll(param)) {
    params[p[1]!.toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, "$1") : p[3]!;
  }
  if (!params.realm) return null;
  const out: BearerChallenge = { realm: params.realm };
  if (params.service !== undefined) out.service = params.service;
  if (params.scope !== undefined) out.scope = params.scope;
  return out;
}

/**
 * The Authorization header for a token request to `realm`: the upstream's basic credentials, or none. They go
 * only to an https realm, or to an http realm when the upstream itself is plain http (a local registry).
 */
function realmAuthorization(upstream: UpstreamWithSecret, realm: URL): string | null {
  if (upstream.authType !== "basic" || !upstream.username || upstream.secret === null) return null;
  if (realm.protocol !== "https:" && !upstream.url.toLowerCase().startsWith("http:")) return null;
  return `Basic ${Buffer.from(`${upstream.username}:${upstream.secret}`).toString("base64")}`;
}

/** Reads a response body as text, or null when it exceeds `limit` bytes (cancelling the rest). */
async function readCapped(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Creates a {@link HubAuth} whose tokens are cached per (upstream id, scope) for `expires_in` (default 60 s)
 * minus 30 s. Concurrent challenges for the same key share one token request. Token responses are read up to
 * 64 KiB. Bearer upstreams never answer challenges: their secret is sent as the token, so realm-protected
 * registries (Docker Hub, GHCR) need basic credentials (username plus access token).
 */
export function createHubAuth(fetchImpl: typeof fetch, now: () => Date): HubAuth {
  const cache = new Map<string, { authorization: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<string | null>>();
  const missing = new Map<string, number>();
  const keyOf = (upstream: UpstreamWithSecret, scope: string) => `${upstream.id}\n${scope}`;

  function isMissing(upstream: UpstreamWithSecret, scope: string): boolean {
    const key = keyOf(upstream, scope);
    const until = missing.get(key);
    if (until === undefined) return false;
    if (until > now().getTime()) return true;
    missing.delete(key);
    return false;
  }

  function remember(key: string, authorization: string, lifetimeMs: number): void {
    if (lifetimeMs <= 0) return;
    const t = now().getTime();
    cache.delete(key);
    if (cache.size >= MAX_CACHED) {
      for (const [k, v] of cache) if (v.expiresAt <= t) cache.delete(k);
      while (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, { authorization, expiresAt: t + lifetimeMs });
  }

  async function fetchToken(challenge: BearerChallenge, upstream: UpstreamWithSecret): Promise<{ token: string; expiresIn: number } | null> {
    let url: URL;
    try {
      url = new URL(challenge.realm);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (challenge.service !== undefined) url.searchParams.set("service", challenge.service);
    if (challenge.scope !== undefined) url.searchParams.set("scope", challenge.scope);
    const headers: Record<string, string> = { accept: "application/json" };
    const authorization = realmAuthorization(upstream, url);
    if (authorization) headers.authorization = authorization;
    try {
      const res = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        console.warn(`weaver:docker token request to ${url.origin}${url.pathname} answered ${res.status}`);
        return null;
      }
      const text = await readCapped(res, MAX_TOKEN_BYTES);
      if (text === null) {
        console.warn(`weaver:docker token response of ${url.origin}${url.pathname} exceeds ${MAX_TOKEN_BYTES} bytes`);
        return null;
      }
      const body = JSON.parse(text) as { token?: unknown; access_token?: unknown; expires_in?: unknown };
      const token = typeof body.token === "string" && body.token ? body.token : body.access_token;
      if (typeof token !== "string" || !token) return null;
      const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
      return { token, expiresIn };
    } catch (error) {
      console.warn(`weaver:docker token request to ${url.origin}${url.pathname} failed`, error);
      return null;
    }
  }

  return {
    authorize(upstream, scope) {
      const entry = cache.get(keyOf(upstream, scope));
      if (!entry) return Promise.resolve(null);
      if (entry.expiresAt <= now().getTime()) {
        cache.delete(keyOf(upstream, scope));
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.authorization);
    },

    markMissing(upstream, scope) {
      const t = now().getTime();
      if (missing.size >= MAX_CACHED) {
        for (const [k, until] of missing) if (until <= t) missing.delete(k);
        while (missing.size >= MAX_CACHED) missing.delete(missing.keys().next().value!);
      }
      const key = keyOf(upstream, scope);
      cache.delete(key);
      missing.set(key, t + MISSING_TTL_MS);
    },

    isMissing,

    onChallenge(header, upstream) {
      // A bearer upstream's secret is its token, sent as is; token realms need basic credentials.
      if (upstream.authType === "bearer") return Promise.resolve(null);
      const challenge = parseChallenge(header);
      if (!challenge) return Promise.resolve(null);
      if (isMissing(upstream, challenge.scope ?? "")) return Promise.resolve(null);
      const key = keyOf(upstream, challenge.scope ?? "");
      const running = inflight.get(key);
      if (running) return running;
      const request = fetchToken(challenge, upstream)
        .then((result) => {
          if (!result) return null;
          const authorization = `Bearer ${result.token}`;
          remember(key, authorization, result.expiresIn * 1000 - EXPIRY_MARGIN_MS);
          return authorization;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    },
  };
}

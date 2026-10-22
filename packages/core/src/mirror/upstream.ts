import zlib from "node:zlib";
import type { UpstreamView } from "../repos/service.js";

/** An upstream of a mirror with its decrypted secret, as the engine contacts it. */
export type UpstreamWithSecret = UpstreamView & { secret: string | null };

/** How long an upstream may take to send response headers before the request is abandoned. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/** Response headers that describe a connection or a hop rather than the content, never forwarded to clients. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers a client sends that must never reach an upstream: its credentials, cookies and transport settings. */
const STRIPPED_REQUEST_HEADERS = ["accept-encoding", "authorization", "cookie", "host", "proxy-authorization"];

/** The content codings `fetch` (undici) decodes; zstd only where zlib supports it, as undici checks. */
const DECODED_CODINGS = new Set(["gzip", "x-gzip", "deflate", "br", ...(typeof zlib.createZstdDecompress === "function" ? ["zstd"] : [])]);

/** Statuses whose responses have no body, which `fetch` therefore never decodes. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * What a response body looks like after `fetch`: `plain` when it had no content coding (or only
 * `identity`), `decoded` when `fetch` removed the coding, `encoded` when the bytes are still encoded.
 */
export type BodyEncoding = "plain" | "decoded" | "encoded";

/** Thrown when an upstream could not be reached or sent no response headers in time. */
export class UpstreamFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamFetchError";
  }
}

/** The URL of `path` below the upstream base URL `base`; exactly one slash joins them. */
export function upstreamUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The Authorization header value the upstream's stored credentials yield, or null for none. */
export function upstreamAuthorization(upstream: UpstreamWithSecret): string | null {
  switch (upstream.authType) {
    case "none":
      return null;
    case "basic":
      return `Basic ${Buffer.from(`${upstream.username ?? ""}:${upstream.secret ?? ""}`).toString("base64")}`;
    case "bearer":
      return upstream.secret === null ? null : `Bearer ${upstream.secret}`;
  }
}

/**
 * How `fetch` delivered the body of a `method` response with `status` and `headers`. Like undici,
 * it counts a body as decoded only when every listed coding is one undici decodes, and never for
 * HEAD or null-body statuses.
 */
export function bodyEncoding(headers: Headers, method: string, status: number): BodyEncoding {
  const codings = (headers.get("content-encoding") ?? "")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== "");
  if (codings.every((c) => c === "identity")) return "plain";
  if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) return "encoded";
  return codings.every((c) => DECODED_CODINGS.has(c)) ? "decoded" : "encoded";
}

/**
 * The upstream response headers worth forwarding to a client: no hop-by-hop headers, none that the
 * upstream's `Connection` header names, and no `content-encoding`/`content-length` when `fetch`
 * decoded the body (they describe the encoded bytes).
 */
export function forwardableHeaders(upstream: Headers, encoding: BodyEncoding): Headers {
  const named = new Set(
    (upstream.get("connection") ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  );
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (HOP_HEADERS.has(name) || named.has(name)) return;
    if (encoding === "decoded" && (name === "content-encoding" || name === "content-length")) return;
    out.append(name, value);
  });
  return out;
}

/**
 * Sends one request to an upstream. The client's credentials, cookies and `accept-encoding` are
 * stripped (`fetch` negotiates its own encoding). Rejects with {@link UpstreamFetchError} on network
 * errors and when no response headers arrive within `timeoutMs`; the body itself may take longer.
 * Aborting `signal` aborts the request, also while its body is being read.
 */
export async function requestUpstream(
  fetchImpl: typeof fetch,
  url: string,
  opts: { method: "GET" | "HEAD"; headers: Record<string, string>; authorization: string | null; timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const headers = new Headers(opts.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  if (opts.authorization !== null) headers.set("authorization", opts.authorization);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new UpstreamFetchError(`${url} sent no response within ${opts.timeoutMs} ms`)), opts.timeoutMs);
  try {
    const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
    return await fetchImpl(url, { method: opts.method, headers, signal, redirect: "follow" });
  } catch (error) {
    if (error instanceof UpstreamFetchError) throw error;
    if (controller.signal.aborted && controller.signal.reason instanceof UpstreamFetchError) throw controller.signal.reason;
    throw new UpstreamFetchError(`Request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Releases a response body that is not going to be read. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is gone already; nothing to release.
  }
}

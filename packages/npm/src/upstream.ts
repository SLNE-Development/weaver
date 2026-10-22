import {
  bodyEncoding,
  discardBody,
  forwardableHeaders,
  RegistryError,
  UPSTREAM_TIMEOUT_MS,
  upstreamAuthorization,
  upstreamUrl,
  type FormatDeps,
  type MirrorConfig,
  type Repo,
} from "@weaver/core";

/**
 * The only client request headers sent upstream. Everything else (credentials, cookies, proxy and client-address
 * headers, one-time passwords, `x-weaver-*`) stays here; `fetch` negotiates its own transfer encoding.
 */
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "user-agent", "npm-command", "npm-session", "npm-scope", "npm-in-ci"];

/**
 * Forwards one request to the mirror's upstreams in order (first non-404 wins), 30 s header timeout, upstream auth applied.
 * Returns null when offline or every upstream answered 404. Only the allow-listed client headers (accept, content-type,
 * user-agent, npm-command, npm-session, npm-scope, npm-in-ci, plus content-encoding when a body is sent, which is
 * forwarded byte for byte) are sent. Response headers are filtered with core's
 * `forwardableHeaders`: hop-by-hop headers are dropped, and content-encoding/content-length only when `fetch`
 * decoded the body, so a body it could not decode keeps its encoding header.
 *
 * Network errors, timeouts, 5xx, 429, 401 and 403 count as failures and try the next upstream; when no upstream
 * answered usefully and at least one failed, this throws `RegistryError("upstream_unavailable")`, so an upstream
 * credential problem never reaches the client as an authentication challenge. The client's own credentials and
 * cookies are never forwarded. `search` is the query string, with or without the leading `?`.
 */
export async function forwardUpstream(
  deps: FormatDeps,
  repo: Repo,
  path: string,
  init: { method: string; headers: Headers; body?: Uint8Array | null; search?: string },
): Promise<Response | null> {
  if (repo.kind !== "mirror") throw new RegistryError("invalid_request", `Repository ${repo.name} is not a mirror`);
  if ((repo.config as MirrorConfig).offline) return null;
  const method = init.method.toUpperCase();
  const query = init.search ? (init.search.startsWith("?") ? init.search : `?${init.search}`) : "";
  const hasBody = method !== "GET" && method !== "HEAD" && init.body != null;
  const failures: string[] = [];
  for (const upstream of await deps.repos.upstreamsWithSecrets(repo.id)) {
    const url = `${upstreamUrl(upstream.url, path)}${query === "?" ? "" : query}`;
    const headers = new Headers();
    for (const name of hasBody ? [...FORWARDED_REQUEST_HEADERS, "content-encoding"] : FORWARDED_REQUEST_HEADERS) {
      const value = init.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const authorization = upstreamAuthorization(upstream);
    if (authorization !== null) headers.set("authorization", authorization);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no response within ${UPSTREAM_TIMEOUT_MS} ms`)), UPSTREAM_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? init.body! : undefined,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) {
      await discardBody(response);
      continue;
    }
    if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 403) {
      await discardBody(response);
      failures.push(`${url} answered ${response.status}`);
      continue;
    }
    const out = forwardableHeaders(response.headers, bodyEncoding(response.headers, method, response.status));
    return new Response(method === "HEAD" ? null : response.body, { status: response.status, headers: out });
  }
  if (failures.length === 0) return null;
  console.warn(`weaver: npm upstream request ${method} ${path} of ${repo.name} failed`, failures);
  throw new RegistryError("upstream_unavailable", `no upstream of ${repo.name} could answer`);
}

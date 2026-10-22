import { RegistryError } from "@weaver/core";

/** Anything the `Headers` constructor accepts. */
type HeadersLike = ConstructorParameters<typeof Headers>[0];

/** The `www-authenticate` challenge of every 401 answer. */
export const BASIC_CHALLENGE = 'Basic realm="Weaver"';

/** Builds a JSON response; defaults to status 200 and `content-type: application/json`. */
export function npmJson(body: unknown, init: { status?: number; headers?: HeadersLike } = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/** Builds an npm-style error response with body `{ "error": message }`. */
export function npmError(status: number, message: string, headers?: HeadersLike): Response {
  return npmJson({ error: message }, { status, headers });
}

/** Maps a thrown value to a response: registry errors keep their status and message (401 adds `www-authenticate`), anything else becomes a logged 500. */
export function toNpmResponse(err: unknown): Response {
  if (err instanceof RegistryError) {
    return npmError(err.status, err.message, err.status === 401 ? { "www-authenticate": BASIC_CHALLENGE } : undefined);
  }
  console.error("weaver: npm request failed", err);
  return npmError(500, "internal error");
}

import type { AssetRow } from "@weaver/core";

/** Builds a plain-text response with the given status, message body and extra headers. */
export function textResponse(status: number, message: string, headers?: Record<string, string>): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

/** The 401 answer that makes Maven clients retry with Basic credentials. */
export function unauthorized(): Response {
  return textResponse(401, "Unauthorized", { "www-authenticate": 'Basic realm="Weaver"' });
}

/** The 405 answer listing the methods the path supports. */
export function methodNotAllowed(allow: string): Response {
  return textResponse(405, "Method Not Allowed", { allow });
}

/** The media type Maven clients expect for a file, derived from its path. */
export function contentTypeFor(path: string): string {
  if (path.endsWith(".jar")) return "application/java-archive";
  if (path.endsWith(".pom") || path.endsWith(".xml")) return "application/xml";
  if (path.endsWith(".module")) return "application/json";
  if (/\.(asc|md5|sha1|sha256|sha512)$/.test(path)) return "text/plain";
  return "application/octet-stream";
}

/** Serves a stored asset with content type, length, last-modified and etag headers; `body` is null for HEAD. */
export function assetResponse(asset: AssetRow, body: ReadableStream<Uint8Array> | null): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": asset.contentType ?? contentTypeFor(asset.path),
      "content-length": String(asset.size),
      "last-modified": asset.updatedAt.toUTCString(),
      etag: `"${asset.sha1}"`,
    },
  });
}

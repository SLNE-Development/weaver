/**
 * Extracts the client token from `Authorization: Bearer <token>` or
 * `Authorization: Basic base64(<any user>:<token>)`. Returns `""` for an empty or malformed
 * credential and `null` when no Bearer or Basic header is present, so callers can tell "no
 * credentials" from "bad credentials".
 */
export function extractToken(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const bearer = header.match(/^Bearer(?:\s+(.*))?$/i);
  if (bearer) return (bearer[1] ?? "").trim();
  const basic = header.match(/^Basic(?:\s+(.*))?$/i);
  if (!basic) return null;
  const encoded = (basic[1] ?? "").trim();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(encoded)) return "";
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? "" : decoded.slice(colon + 1).trim();
}

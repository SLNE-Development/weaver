import { DockerError } from "./errors.js";
import { isDigest } from "./media-types.js";

/** A parsed `/v2/...` request path. */
export type Route =
  | { kind: "base" }
  | { kind: "token" }
  | { kind: "manifest"; name: string; reference: string }
  | { kind: "blob"; name: string; digest: string }
  | { kind: "upload-start"; name: string }
  | { kind: "upload"; name: string; uploadId: string }
  | { kind: "tags"; name: string }
  | { kind: "referrers"; name: string; digest: string };

const COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const TAG = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

function checkName(name: string): string {
  if (!name.split("/").every((c) => COMPONENT.test(c))) {
    throw new DockerError(400, "NAME_INVALID", "invalid repository name", { name });
  }
  return name;
}

/**
 * Parses the raw path after `/v2/`, matching from the right so names may contain slashes.
 * Returns null when no OCI route matches; throws `NAME_INVALID` for a malformed repository name.
 */
export function parseRoute(rest: string): Route | null {
  if (rest === "") return { kind: "base" };
  if (rest === "token") return { kind: "token" };
  let m: RegExpMatchArray | null;
  if ((m = rest.match(/^(.+)\/blobs\/uploads$/))) return { kind: "upload-start", name: checkName(m[1]!) };
  if ((m = rest.match(/^(.+)\/blobs\/uploads\/([^/]*)$/))) {
    const name = checkName(m[1]!);
    return m[2] === "" ? { kind: "upload-start", name } : { kind: "upload", name, uploadId: m[2]! };
  }
  if ((m = rest.match(/^(.+)\/blobs\/([^/]+)$/))) return { kind: "blob", name: checkName(m[1]!), digest: m[2]! };
  if ((m = rest.match(/^(.+)\/manifests\/([^/]+)$/))) {
    const name = checkName(m[1]!);
    const reference = m[2]!;
    return TAG.test(reference) || isDigest(reference) ? { kind: "manifest", name, reference } : null;
  }
  if ((m = rest.match(/^(.+)\/tags\/list$/))) return { kind: "tags", name: checkName(m[1]!) };
  if ((m = rest.match(/^(.+)\/referrers\/([^/]+)$/))) return { kind: "referrers", name: checkName(m[1]!), digest: m[2]! };
  return null;
}

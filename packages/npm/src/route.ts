import { parsePackageName, type PackageName } from "./names.js";

/** A recognised npm registry request, independent of HTTP method. */
export type NpmRoute =
  | { kind: "ping" }
  | { kind: "whoami" }
  | { kind: "login" }
  | { kind: "loginDone"; secret: string }
  | { kind: "couchUser"; user: string }
  | { kind: "security"; path: string }
  | { kind: "search" }
  | { kind: "distTags"; name: PackageName; tag: string | null }
  | { kind: "packument"; name: PackageName; rev: string | null }
  | { kind: "version"; name: PackageName; spec: string }
  | { kind: "tarball"; name: PackageName; file: string; rev: string | null }
  | { kind: "unsupported" };

const UNSUPPORTED: NpmRoute = { kind: "unsupported" };

/** Whether a decoded value is safe to use as a single path component or identifier. */
function safe(value: string): boolean {
  return value !== "" && !value.includes("/") && !value.includes("\\") && !value.includes("..");
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Reads a package name starting at `segs[i]`, handling `@scope/name`, `@scope%2fname` and plain names. */
function takeName(segs: string[], i: number): { name: PackageName; next: number } | null {
  const first = segs[i];
  if (first === undefined) return null;
  if (first.startsWith("@") && !first.includes("/")) {
    const second = segs[i + 1];
    if (second === undefined) return null;
    const name = parsePackageName(`${first}/${second}`);
    return name ? { name, next: i + 2 } : null;
  }
  const name = parsePackageName(first);
  return name ? { name, next: i + 1 } : null;
}

function parseSpecial(segs: string[]): NpmRoute {
  const [, , a, b, c, d] = segs;
  if (a === "ping" && segs.length === 3) return { kind: "ping" };
  if (a === "whoami" && segs.length === 3) return { kind: "whoami" };
  if (a === "v1" && b === "login" && segs.length === 4) return { kind: "login" };
  if (a === "v1" && b === "login" && c === "done" && d !== undefined && segs.length === 6) return safe(d) ? { kind: "loginDone", secret: d } : UNSUPPORTED;
  if (a === "v1" && b === "search" && segs.length === 4) return { kind: "search" };
  if (a === "user" && b !== undefined && segs.length === 4) return safe(b) ? { kind: "couchUser", user: b } : UNSUPPORTED;
  if (a === "npm" && b === "v1" && c === "security" && segs.length > 5) {
    const parts = segs.slice(5);
    return parts.every(safe) ? { kind: "security", path: parts.join("/") } : UNSUPPORTED;
  }
  if (a === "package") {
    const taken = takeName(segs, 3);
    if (!taken || segs[taken.next] !== "dist-tags") return UNSUPPORTED;
    const rest = segs.slice(taken.next + 1);
    if (rest.length === 0) return { kind: "distTags", name: taken.name, tag: null };
    if (rest.length === 1 && safe(rest[0]!)) return { kind: "distTags", name: taken.name, tag: rest[0]! };
  }
  return UNSUPPORTED;
}

function parsePackage(segs: string[]): NpmRoute {
  const taken = takeName(segs, 1);
  if (!taken) return UNSUPPORTED;
  const { name } = taken;
  const rest = segs.slice(taken.next);
  if (rest.length === 0) return { kind: "packument", name, rev: null };
  if (rest[0] === "-rev" && rest.length === 2 && safe(rest[1]!)) return { kind: "packument", name, rev: rest[1]! };
  if (rest[0] === "-" && rest[1] !== undefined) {
    const file = rest[1];
    if (!safe(file) || !file.endsWith(".tgz")) return UNSUPPORTED;
    if (rest.length === 2) return { kind: "tarball", name, file, rev: null };
    if (rest.length === 4 && rest[2] === "-rev" && safe(rest[3]!)) return { kind: "tarball", name, file, rev: rest[3]! };
    return UNSUPPORTED;
  }
  if (rest.length === 1 && safe(rest[0]!) && rest[0] !== "-") return { kind: "version", name, spec: rest[0]! };
  return UNSUPPORTED;
}

/**
 * Parses the part of the request path below `/npm/` (`<repo>/<npm path>`) into a repository name and an
 * {@link NpmRoute}. Scoped names are accepted as `@s/n`, `@s%2fn` and `@s%2Fn`. Returns null when there is no repository
 * or no path at all (answer 404).
 */
export function parseNpmPath(rest: string): { repo: string; route: NpmRoute } | null {
  const raw = rest.split("/");
  const segs: string[] = [];
  for (const r of raw) {
    const d = decode(r);
    if (d === null) return null;
    if (d === "." || d === "..") return null;
    segs.push(d);
  }
  const repo = segs[0];
  if (!repo || segs.length < 2 || segs.slice(1).every((s) => s === "")) return null;
  // Drop the empty segment a trailing slash leaves behind.
  if (segs[segs.length - 1] === "") segs.pop();
  const route = segs[1] === "-" ? parseSpecial(segs) : parsePackage(segs);
  return { repo, route };
}

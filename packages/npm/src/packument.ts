/** One published version as it appears in a packument. */
export interface VersionManifest {
  name: string;
  version: string;
  dist: { tarball: string; shasum: string; integrity?: string; [k: string]: unknown };
  deprecated?: string;
  [k: string]: unknown;
}

/** The full npm metadata document of a package. */
export interface Packument {
  _id: string;
  _rev?: string;
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, VersionManifest>;
  time: Record<string, string>;
  readme?: string;
  description?: string;
  [k: string]: unknown;
}

/** The install-only metadata document served for the abbreviated media type. */
export interface AbbreviatedPackument {
  name: string;
  modified: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, Partial<VersionManifest>>;
}

/** Media type of the abbreviated packument. */
export const ABBREVIATED_TYPE = "application/vnd.npm.install-v1+json";

const ABBREVIATED_FIELDS = [
  "name",
  "version",
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "bundleDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "acceptDependencies",
  "bin",
  "directories",
  "dist",
  "engines",
  "os",
  "cpu",
  "libc",
  "_hasShrinkwrap",
  "hasInstallScript",
  "deprecated",
  "funding",
] as const;

/** Whether an Accept header lists the abbreviated media type with a quality above zero. */
export function wantsAbbreviated(accept: string | null): boolean {
  if (!accept) return false;
  for (const part of accept.split(",")) {
    const [type, ...params] = part.split(";").map((s) => s.trim());
    if (type?.toLowerCase() !== ABBREVIATED_TYPE) continue;
    const q = params.find((p) => p.toLowerCase().startsWith("q="));
    const value = q ? Number(q.slice(2)) : 1;
    if (Number.isNaN(value) || value > 0) return true;
  }
  return false;
}

/** Own-property assignment that is safe for untrusted keys such as `__proto__`. */
function setOwn<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Latest timestamp among the time entries other than `modified`, or "" when there are none. */
function latestTime(time: Record<string, string>): string {
  let latest = "";
  for (const [k, v] of Object.entries(time)) if (k !== "modified" && typeof v === "string" && v > latest) latest = v;
  return latest;
}

/** The `modified` time of a (possibly incomplete) time map, falling back to the latest other entry. */
function modifiedOf(time: Record<string, string>): string {
  return typeof time["modified"] === "string" ? time["modified"] : latestTime(time);
}

/** Reduces a packument to the fields package managers need to install. */
export function abbreviate(p: Packument): AbbreviatedPackument {
  const versions: Record<string, Partial<VersionManifest>> = {};
  for (const [version, manifest] of Object.entries(p.versions ?? {})) {
    const kept: Record<string, unknown> = {};
    for (const field of ABBREVIATED_FIELDS) {
      if (manifest[field] !== undefined) kept[field] = manifest[field];
    }
    setOwn(versions, version, kept as Partial<VersionManifest>);
  }
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(p["dist-tags"] ?? {})) setOwn(tags, k, v);
  return { name: p.name, modified: modifiedOf(p.time ?? {}), "dist-tags": tags, versions };
}

/**
 * Returns a copy of the packument whose tarball URLs point at `${base}/${name}/-/${file}`, where `base` is
 * `${publicUrl}/npm/${repo}` and `name` is the packument's own name (never a version manifest's, which an upstream
 * controls). Absolute and relative upstream tarball URLs are both handled; a version without a usable tarball falls
 * back to the conventional file name, so no upstream URL survives.
 */
export function rewriteTarballs<T extends { name: string; versions: Record<string, Partial<VersionManifest>> }>(p: T, base: string): T {
  const versions: Record<string, Partial<VersionManifest>> = {};
  const name = p.name;
  const bare = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  for (const [version, manifest] of Object.entries(p.versions ?? {})) {
    const tarball = manifest.dist?.tarball;
    const fromUrl = typeof tarball === "string" ? (tarball.split(/[?#]/)[0]!.split("/").pop() ?? "") : "";
    const file = fromUrl || `${bare}-${version}.tgz`;
    const dist = { ...manifest.dist, tarball: `${base}/${name}/-/${file}` } as VersionManifest["dist"];
    setOwn(versions, version, { ...manifest, dist });
  }
  return { ...p, versions };
}

/**
 * Merges the packuments of a group's members, in member order. The first packument wins per version, dist-tag and time
 * entry; the readme comes from the first that has one; `time.modified` is the latest of all; `_rev` is dropped.
 */
export function mergePackuments(list: Packument[]): Packument {
  const first = list[0];
  if (!first) throw new Error("mergePackuments needs at least one packument");
  const merged: Packument = { ...first, "dist-tags": {}, versions: {}, time: {} };
  delete merged.readme;
  delete merged._rev;
  let modified = "";
  for (const p of list) {
    for (const [k, v] of Object.entries(p.versions ?? {})) if (!Object.hasOwn(merged.versions, k)) setOwn(merged.versions, k, v);
    for (const [k, v] of Object.entries(p["dist-tags"] ?? {})) if (!Object.hasOwn(merged["dist-tags"], k)) setOwn(merged["dist-tags"], k, v);
    const time = p.time ?? {};
    const own = modifiedOf(time);
    if (own > modified) modified = own;
    for (const [k, v] of Object.entries(time)) if (k !== "modified" && !Object.hasOwn(merged.time, k)) setOwn(merged.time, k, v);
    if (merged.readme === undefined && p.readme) merged.readme = p.readme;
  }
  if (modified) setOwn(merged.time, "modified", modified);
  return merged;
}

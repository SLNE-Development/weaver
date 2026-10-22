import { RegistryError } from "@weaver/core";

/** Checksum algorithms Maven clients may request as sidecar files. */
export type ChecksumAlgo = "md5" | "sha1" | "sha256" | "sha512";

/** All supported checksum algorithms, in the order they are generated. */
export const CHECKSUM_ALGOS: readonly ChecksumAlgo[] = ["md5", "sha1", "sha256", "sha512"];

/** Timestamp and build number of a unique snapshot deployment. */
export interface SnapshotStamp {
  /** UTC time as `yyyyMMdd.HHmmss`. */
  timestamp: string;
  buildNumber: number;
}

/** A parsed Maven artifact file path (including checksum and signature sidecars). */
export interface MavenFile {
  type: "file";
  path: string;
  /** The path without a checksum suffix. */
  basePath: string;
  groupId: string;
  artifactId: string;
  /** The version as in the directory, e.g. `1.0-SNAPSHOT`. */
  version: string;
  snapshot: boolean;
  stamp: SnapshotStamp | null;
  classifier: string | null;
  /** Everything after the first `.` of the remainder, e.g. `jar`, `tar.gz`, `jar.asc`. */
  extension: string;
  checksum: ChecksumAlgo | null;
  signature: boolean;
}

/** Any path below a Maven repository. */
export type MavenPath =
  | { type: "directory"; path: string }
  | { type: "metadata"; path: string; basePath: string; dir: string; checksum: ChecksumAlgo | null }
  | MavenFile
  | { type: "other"; path: string; basePath: string; checksum: ChecksumAlgo | null };

/** Throws the error used for every malformed request path. */
function invalid(message: string): never {
  throw new RegistryError("invalid_request", message);
}

/** Decodes one path segment and rejects traversal, separators and control characters. */
function decodeSegment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return invalid("Malformed percent-encoding in path");
  }
  if (decoded === "" || decoded === "." || decoded === "..") return invalid("Invalid path segment");
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  if (decoded.includes("/") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) return invalid("Invalid character in path segment");
  return decoded;
}

/** Escapes a string for literal use inside a regular expression. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Splits a trailing checksum suffix off a path. */
function splitChecksum(path: string): { basePath: string; checksum: ChecksumAlgo | null } {
  for (const algo of CHECKSUM_ALGOS) {
    if (path.endsWith(`.${algo}`)) return { basePath: path.slice(0, -(algo.length + 1)), checksum: algo };
  }
  return { basePath: path, checksum: null };
}

/** Parses the `[-classifier].extension` remainder after the artifact-version prefix. */
function parseRemainder(rest: string): { classifier: string | null; extension: string } | null {
  let classifier: string | null = null;
  let tail = rest;
  if (rest.startsWith("-")) {
    const dot = rest.indexOf(".");
    if (dot < 0) return null;
    classifier = rest.slice(1, dot);
    tail = rest.slice(dot);
    if (classifier === "") return null;
  }
  if (!tail.startsWith(".") || tail.length < 2) return null;
  // `lib-1.0.1.jar` in the `1.0` directory belongs to version 1.0.1, not extension `1.jar`.
  if (classifier === null && /^\.\d/.test(tail)) return null;
  return { classifier, extension: tail.slice(1) };
}

/** Classifies decoded segments below the repository root (without trailing directory slash). */
function classify(segs: string[]): MavenPath {
  const path = segs.join("/");
  const { basePath, checksum } = splitChecksum(path);
  const name = basePath.slice(basePath.lastIndexOf("/") + 1);

  if (name === "maven-metadata.xml") {
    return { type: "metadata", path, basePath, dir: segs.slice(0, -1).join("/"), checksum };
  }

  if (segs.length >= 4) {
    const artifactId = segs[segs.length - 3]!;
    const version = segs[segs.length - 2]!;
    const snapshot = version.endsWith("-SNAPSHOT");
    let stamp: SnapshotStamp | null = null;
    let remainder: string | null = null;

    if (snapshot) {
      const base = version.slice(0, -"-SNAPSHOT".length);
      const m = new RegExp(`^${escapeRegExp(`${artifactId}-${base}-`)}(\\d{8}\\.\\d{6})-(\\d+)`).exec(name);
      if (m) {
        stamp = { timestamp: m[1]!, buildNumber: Number(m[2]) };
        remainder = name.slice(m[0].length);
      }
    }
    const prefix = `${artifactId}-${version}`;
    if (remainder === null && name.startsWith(prefix) && /^[-.]/.test(name.slice(prefix.length))) remainder = name.slice(prefix.length);

    const parsed = remainder === null ? null : parseRemainder(remainder);
    if (parsed) {
      return {
        type: "file",
        path,
        basePath,
        groupId: segs.slice(0, -3).join("."),
        artifactId,
        version,
        snapshot,
        stamp,
        classifier: parsed.classifier,
        extension: parsed.extension,
        checksum,
        signature: parsed.extension.endsWith(".asc"),
      };
    }
  }
  return { type: "other", path, basePath, checksum };
}

/**
 * Splits a raw request remainder into the repository name and a decoded, validated target.
 * A bare repository name without a slash yields a `null` target.
 * @throws RegistryError `invalid_request` for traversal, empty segments or bad encoding.
 */
export function parseMavenPath(rest: string): { repo: string; target: MavenPath | null } {
  const raw = rest.split("/");
  const repo = decodeSegment(raw[0]!);
  const tail = raw.slice(1);
  if (tail.length === 0) return { repo, target: null };

  const directory = tail[tail.length - 1] === "";
  if (directory) tail.pop();
  const segs = tail.map(decodeSegment);
  if (directory) return { repo, target: { type: "directory", path: segs.length ? `${segs.join("/")}/` : "" } };
  return { repo, target: classify(segs) };
}

/**
 * Classifies a stored asset path (already decoded and validated when it was written), e.g. to
 * read the snapshot stamp of each file in a version directory.
 */
export function classifyStoredPath(path: string): MavenPath {
  return classify(path.split("/"));
}

/**
 * Rule subjects used to match mirror rules. Files yield `groupId:artifactId`. A metadata path
 * is ambiguous (artifact, snapshot or group-level), so it yields every plausible reading:
 * `groupId:artifactId` (with a trailing version directory dropped) and the group-level
 * `<full.group.path>:*`. Other paths yield the path with `/` replaced by `.`.
 * A mirror request is allowed iff the allow list is empty or some candidate matches an allow
 * pattern, and no candidate matches a deny pattern (the mirror reader adds groupId candidates
 * for patterns without `:`).
 */
export function mirrorSubjects(p: MavenPath): string[] {
  if (p.type === "file") return [`${p.groupId}:${p.artifactId}`];
  if (p.type === "metadata") {
    const parts = p.dir.split("/").filter(Boolean);
    const out = new Set<string>();
    const artifactReading = (ps: string[]) => {
      if (ps.length >= 2) out.add(`${ps.slice(0, -1).join(".")}:${ps[ps.length - 1]}`);
    };
    artifactReading(parts);
    const last = parts[parts.length - 1];
    if (last !== undefined && (last.endsWith("-SNAPSHOT") || /^\d/.test(last))) artifactReading(parts.slice(0, -1));
    if (parts.length > 0) out.add(`${parts.join(".")}:*`);
    if (out.size > 0) return [...out];
  }
  return [p.path.replaceAll("/", ".")];
}

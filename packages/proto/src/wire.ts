import { z } from "zod";
import { formatCoordinate, parseCoordinate, type VersionInfo } from "@weaver/core";

/** Header carrying how many Weaver mirrors a request has passed through; raised by one at every hop. */
export const HOPS_HEADER = "x-weaver-hops";

/** Response header carrying the SHA-256 of an archive. */
export const SHA_HEADER = "x-weaver-sha256";

/** Requests with more hops than this are refused as a mirror loop. */
export const MAX_MIRROR_HOPS = 4;

/** Whether `s` parses as a `group:name:version` coordinate. */
function isCoordinate(s: string): boolean {
  try {
    parseCoordinate(s);
    return true;
  } catch {
    return false;
  }
}

const coordinateString = z.string().refine(isCoordinate, "expected group:name:version");
const isoDate = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

/** Lowercase hex SHA-256 digests, as Weaver sends them. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const sha256Hex = z.string().regex(SHA256_PATTERN);

/** The `/api/v1` version list body: `{ versions: [{ version, isSnapshot, latestBuild, updatedAt }] }`, dates ISO. */
export const versionsBodySchema: z.ZodType<{
  versions: Array<{ version: string; isSnapshot: boolean; latestBuild: number; updatedAt: string }>;
}> = z.object({
  versions: z.array(
    z.object({
      version: z.string().min(1),
      isSnapshot: z.boolean(),
      latestBuild: count,
      updatedAt: isoDate,
    }),
  ),
});

/** `VersionInfo` as sent over `/api/v1`: coordinate and dependencies as `group:name:version` strings, dates as ISO strings. */
export type VersionInfoJson = Omit<VersionInfo, "coordinate" | "dependencies" | "createdAt" | "builds"> & {
  coordinate: string;
  dependencies: string[];
  createdAt: string;
  builds: Array<{ buildNumber: number; createdAt: string; sha256: string }>;
};

/** The `/api/v1` manifest body of one version, see {@link VersionInfoJson}. */
export const manifestBodySchema: z.ZodType<VersionInfoJson> = z.object({
  repository: z.string(),
  coordinate: coordinateString,
  buildNumber: count,
  sha256: sha256Hex,
  sizeBytes: count,
  dependencies: z.array(coordinateString),
  files: z.array(z.string()),
  publishedBy: z.string().nullable(),
  downloadCount: count,
  createdAt: isoDate,
  builds: z.array(z.object({ buildNumber: count, createdAt: isoDate, sha256: sha256Hex })),
});

/** Converts version metadata to its `/api/v1` JSON form. */
export function versionInfoToJson(info: VersionInfo): VersionInfoJson {
  return {
    repository: info.repository,
    coordinate: formatCoordinate(info.coordinate),
    buildNumber: info.buildNumber,
    sha256: info.sha256,
    sizeBytes: info.sizeBytes,
    dependencies: info.dependencies.map(formatCoordinate),
    files: info.files,
    publishedBy: info.publishedBy,
    downloadCount: info.downloadCount,
    createdAt: info.createdAt.toISOString(),
    builds: info.builds.map((b) => ({ buildNumber: b.buildNumber, createdAt: b.createdAt.toISOString(), sha256: b.sha256 })),
  };
}

/** Converts a validated `/api/v1` manifest body back to version metadata; throws `invalid_request` on a malformed coordinate. */
export function versionInfoFromJson(body: VersionInfoJson): VersionInfo {
  return {
    repository: body.repository,
    coordinate: parseCoordinate(body.coordinate),
    buildNumber: body.buildNumber,
    sha256: body.sha256,
    sizeBytes: body.sizeBytes,
    dependencies: body.dependencies.map(parseCoordinate),
    files: body.files,
    publishedBy: body.publishedBy,
    downloadCount: body.downloadCount,
    createdAt: new Date(body.createdAt),
    builds: body.builds.map((b) => ({ buildNumber: b.buildNumber, createdAt: new Date(b.createdAt), sha256: b.sha256 })),
  };
}

/**
 * Relative upstream path of a proto resource below a repository's `/api/v1/repos/<repo>` URL, each
 * segment `encodeURIComponent`-ed: `artifacts/<g>/<n>` (versions), `artifacts/<g>/<n>/<v>`
 * (manifest) or `artifacts/<g>/<n>/<v>/archive` (archive), with `?build=<b>` when `buildNumber` is given.
 */
export function protoPath(
  kind: "versions" | "manifest" | "archive",
  c: { group: string; name: string; version?: string },
  buildNumber?: number,
): string {
  const segments = [c.group, c.name];
  if (kind !== "versions") {
    if (c.version === undefined) throw new TypeError(`protoPath(${kind}) needs a version`);
    segments.push(c.version);
  }
  const path = ["artifacts", ...segments.map(encodeURIComponent), ...(kind === "archive" ? ["archive"] : [])].join("/");
  return buildNumber === undefined ? path : `${path}?build=${buildNumber}`;
}

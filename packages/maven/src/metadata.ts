import { XMLParser } from "fast-xml-parser";
import type { SnapshotStamp } from "./path.js";
import { compareMavenVersions, isSnapshotVersion } from "./version.js";

/** Version listing of one artifact (`groupId/artifactId/maven-metadata.xml`). */
export interface ArtifactMetadata {
  groupId: string;
  artifactId: string;
  versions: string[];
  /** UTC time as `yyyyMMddHHmmss`. */
  lastUpdated: string;
}

/** One resolvable file of a timestamped snapshot build. */
export interface SnapshotVersionEntry {
  classifier: string | null;
  extension: string;
  /** The timestamped version, e.g. `1.0-20261022.101010-3`. */
  value: string;
  /** UTC time as `yyyyMMddHHmmss`. */
  updated: string;
}

/** Snapshot listing of one version (`groupId/artifactId/version/maven-metadata.xml`). */
export interface SnapshotMetadata {
  groupId: string;
  artifactId: string;
  version: string;
  latest: SnapshotStamp | null;
  snapshotVersions: SnapshotVersionEntry[];
  lastUpdated: string;
}

/** One plugin prefix mapping of a group-level metadata file. */
export interface PluginEntry {
  name: string | null;
  prefix: string;
  artifactId: string;
}

/** Any recognised `maven-metadata.xml` document. */
export type ParsedMetadata =
  | { kind: "artifact"; value: ArtifactMetadata }
  | { kind: "snapshot"; value: SnapshotMetadata }
  | { kind: "plugins"; plugins: PluginEntry[] };

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Escapes the five XML special characters. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Renders `<tag>escaped</tag>` at the given indentation level (two spaces each). */
function el(level: number, tag: string, value: string): string {
  return `${"  ".repeat(level)}<${tag}>${esc(value)}</${tag}>`;
}

/** Sorts versions ascending in Maven order and drops duplicates. */
function sortedUnique(versions: string[]): string[] {
  return [...new Set(versions)].sort(compareMavenVersions);
}

/** Renders artifact-level metadata, computing `latest` and `release` from the versions. */
export function renderArtifactMetadata(m: ArtifactMetadata): string {
  const versions = sortedUnique(m.versions);
  const releases = versions.filter((v) => !isSnapshotVersion(v));
  const lines = [
    '<metadata modelVersion="1.1.0">',
    el(1, "groupId", m.groupId),
    el(1, "artifactId", m.artifactId),
    "  <versioning>",
  ];
  if (versions.length > 0) lines.push(el(2, "latest", versions[versions.length - 1]!));
  if (releases.length > 0) lines.push(el(2, "release", releases[releases.length - 1]!));
  lines.push("    <versions>", ...versions.map((v) => el(3, "version", v)), "    </versions>");
  if (m.lastUpdated !== "") lines.push(el(2, "lastUpdated", m.lastUpdated));
  lines.push("  </versioning>", "</metadata>");
  return `${XML_DECLARATION}${lines.join("\n")}\n`;
}

/** Renders snapshot-level metadata listing the latest timestamped build and its files. */
export function renderSnapshotMetadata(m: SnapshotMetadata): string {
  const lines = [
    '<metadata modelVersion="1.1.0">',
    el(1, "groupId", m.groupId),
    el(1, "artifactId", m.artifactId),
    el(1, "version", m.version),
    "  <versioning>",
  ];
  if (m.latest) {
    lines.push(
      "    <snapshot>",
      el(3, "timestamp", m.latest.timestamp),
      el(3, "buildNumber", String(m.latest.buildNumber)),
      "    </snapshot>",
    );
  }
  if (m.lastUpdated !== "") lines.push(el(2, "lastUpdated", m.lastUpdated));
  if (m.snapshotVersions.length > 0) {
    lines.push("    <snapshotVersions>");
    for (const s of m.snapshotVersions) {
      lines.push("      <snapshotVersion>");
      if (s.classifier !== null) lines.push(el(4, "classifier", s.classifier));
      lines.push(el(4, "extension", s.extension), el(4, "value", s.value));
      if (s.updated !== "") lines.push(el(4, "updated", s.updated));
      lines.push("      </snapshotVersion>");
    }
    lines.push("    </snapshotVersions>");
  }
  lines.push("  </versioning>", "</metadata>");
  return `${XML_DECLARATION}${lines.join("\n")}\n`;
}

/** Renders group-level metadata mapping plugin prefixes to artifacts. */
export function renderPluginMetadata(plugins: PluginEntry[]): string {
  const lines = ['<metadata modelVersion="1.1.0">', "  <plugins>"];
  for (const p of plugins) {
    lines.push("    <plugin>");
    if (p.name !== null) lines.push(el(3, "name", p.name));
    lines.push(el(3, "prefix", p.prefix), el(3, "artifactId", p.artifactId), "    </plugin>");
  }
  lines.push("  </plugins>", "</metadata>");
  return `${XML_DECLARATION}${lines.join("\n")}\n`;
}

const parser = new XMLParser({
  isArray: (name) => ["version", "snapshotVersion", "plugin"].includes(name),
  parseTagValue: false,
});

/** Narrows an unknown parsed XML node to a plain object, or `undefined`. */
function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Reads a parsed text node as a string, or `undefined` when absent or not text. */
function str(v: unknown): string | undefined {
  if (Array.isArray(v)) return str(v[0]);
  return typeof v === "string" ? v : undefined;
}

/** Reads a parsed node as a list (a missing or empty element yields an empty list). */
function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Parses a `maven-metadata.xml` document; `null` when it is not valid Maven metadata. */
export function parseMetadata(xml: string): ParsedMetadata | null {
  // Upstream XML is untrusted: Maven metadata never needs a DOCTYPE, and refusing it rules out
  // custom entity definitions (billion-laughs expansion).
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) return null;
  let root: Record<string, unknown> | undefined;
  try {
    root = obj(obj(parser.parse(xml))?.["metadata"]);
  } catch {
    return null;
  }
  if (!root) return null;

  if (root["plugins"] !== undefined) {
    const plugins: PluginEntry[] = [];
    for (const raw of list(obj(root["plugins"])?.["plugin"])) {
      const p = obj(raw);
      const prefix = str(p?.["prefix"]);
      const artifactId = str(p?.["artifactId"]);
      if (prefix === undefined || artifactId === undefined) return null;
      plugins.push({ name: str(p?.["name"]) ?? null, prefix, artifactId });
    }
    return { kind: "plugins", plugins };
  }

  const groupId = str(root["groupId"]);
  const artifactId = str(root["artifactId"]);
  if (groupId === undefined || artifactId === undefined) return null;
  const versioning = obj(root["versioning"]);
  const lastUpdated = str(versioning?.["lastUpdated"]) ?? "";
  const version = str(root["version"]);

  if (version !== undefined || versioning?.["snapshot"] !== undefined || versioning?.["snapshotVersions"] !== undefined) {
    if (version === undefined) return null;
    const stamp = obj(versioning?.["snapshot"]);
    const timestamp = str(stamp?.["timestamp"]);
    const buildNumber = str(stamp?.["buildNumber"]);
    if (buildNumber !== undefined && !/^\d+$/.test(buildNumber)) return null;
    const snapshotVersions: SnapshotVersionEntry[] = [];
    for (const raw of list(obj(versioning?.["snapshotVersions"])?.["snapshotVersion"])) {
      const s = obj(raw);
      const extension = str(s?.["extension"]);
      const value = str(s?.["value"]);
      if (extension === undefined || value === undefined) return null;
      snapshotVersions.push({
        classifier: str(s?.["classifier"]) ?? null,
        extension,
        value,
        updated: str(s?.["updated"]) ?? "",
      });
    }
    return {
      kind: "snapshot",
      value: {
        groupId,
        artifactId,
        version,
        latest: timestamp !== undefined && buildNumber !== undefined ? { timestamp, buildNumber: Number(buildNumber) } : null,
        snapshotVersions,
        lastUpdated,
      },
    };
  }

  const versions = list(obj(versioning?.["versions"])?.["version"])
    .map(str)
    .filter((v): v is string => v !== undefined);
  return { kind: "artifact", value: { groupId, artifactId, versions: sortedUnique(versions), lastUpdated } };
}

/**
 * Merges several artifact-level metadata documents of the same artifact: the union of all
 * versions in ascending order and the newest `lastUpdated`.
 */
export function mergeArtifactMetadata(docs: ArtifactMetadata[]): ArtifactMetadata {
  const first = docs[0];
  if (!first) throw new Error("mergeArtifactMetadata needs at least one document");
  return {
    groupId: first.groupId,
    artifactId: first.artifactId,
    versions: sortedUnique(docs.flatMap((d) => d.versions)),
    lastUpdated: docs.reduce((max, d) => (d.lastUpdated > max ? d.lastUpdated : max), ""),
  };
}

/** Formats a date as the UTC `yyyyMMddHHmmss` timestamp used in Maven metadata. */
export function formatMavenTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, "").replace(/[-:T]/g, "");
}

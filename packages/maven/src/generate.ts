import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { AssetRow, FormatDeps, Repo } from "@weaver/core";
import { component } from "@weaver/db";
import { formatMavenTimestamp, renderArtifactMetadata, renderSnapshotMetadata, type SnapshotVersionEntry } from "./metadata.js";
import { classifyStoredPath, type MavenFile, type SnapshotStamp } from "./path.js";

/** A stored timestamped snapshot file with its parsed path. */
export interface SnapshotFile {
  asset: AssetRow;
  file: MavenFile & { stamp: SnapshotStamp };
}

/** Orders two snapshot stamps: by build number, then by timestamp. */
export function compareStamps(a: SnapshotStamp, b: SnapshotStamp): number {
  if (a.buildNumber !== b.buildNumber) return a.buildNumber - b.buildNumber;
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}

/** The timestamped files (no checksums) stored directly in a hosted `-SNAPSHOT` version directory. */
export async function snapshotFiles(deps: FormatDeps, repo: Repo, dir: string): Promise<SnapshotFile[]> {
  const prefix = `${dir}/`;
  const out: SnapshotFile[] = [];
  for (const asset of await deps.assets.list(repo.id, prefix)) {
    if (asset.path.slice(prefix.length).includes("/")) continue;
    const file = classifyStoredPath(asset.path);
    if (file.type !== "file" || file.stamp === null || file.checksum !== null) continue;
    out.push({ asset, file: file as MavenFile & { stamp: SnapshotStamp } });
  }
  return out;
}

/** Reads a small stored asset (metadata) fully as UTF-8 text; null when its object is gone. */
async function readText(deps: FormatDeps, asset: AssetRow): Promise<string | null> {
  const read = await deps.assets.open(asset);
  if (!read) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of read.body as Readable) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** The newest of several dates, formatted as a Maven timestamp. */
function newest(dates: Date[]): string {
  const max = dates.reduce((m, d) => (d > m ? d : m));
  return formatMavenTimestamp(max);
}

/** Snapshot metadata of a `-SNAPSHOT` directory from its timestamped files, or null when it has none. */
async function snapshotMetadataXml(deps: FormatDeps, repo: Repo, dir: string): Promise<string | null> {
  const segs = dir.split("/");
  if (segs.length < 3) return null;
  const files = await snapshotFiles(deps, repo, dir);
  if (files.length === 0) return null;

  const best = new Map<string, SnapshotFile>();
  for (const f of files) {
    const key = `${f.file.classifier ?? ""}\u0000${f.file.extension}`;
    const current = best.get(key);
    if (!current || compareStamps(f.file.stamp, current.file.stamp) > 0) best.set(key, f);
  }
  const latest = files.reduce((m, f) => (compareStamps(f.file.stamp, m.file.stamp) > 0 ? f : m)).file.stamp;
  const version = segs[segs.length - 1]!;
  const base = version.slice(0, -"-SNAPSHOT".length);
  const snapshotVersions: SnapshotVersionEntry[] = [...best.values()]
    .sort((a, b) => {
      const ka = `${a.file.classifier ?? ""}\u0000${a.file.extension}`;
      const kb = `${b.file.classifier ?? ""}\u0000${b.file.extension}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .map((f) => ({
      classifier: f.file.classifier,
      extension: f.file.extension,
      value: `${base}-${f.file.stamp.timestamp}-${f.file.stamp.buildNumber}`,
      updated: formatMavenTimestamp(f.asset.updatedAt),
    }));
  return renderSnapshotMetadata({
    groupId: segs.slice(0, -2).join("."),
    artifactId: segs[segs.length - 2]!,
    version,
    latest,
    snapshotVersions,
    lastUpdated: newest(files.map((f) => f.asset.updatedAt)),
  });
}

/** Artifact metadata of `<group path>/<artifactId>` from its component rows, or null when there are none. */
async function artifactMetadataXml(deps: FormatDeps, repo: Repo, dir: string): Promise<string | null> {
  const segs = dir.split("/");
  if (segs.length < 2) return null;
  const groupId = segs.slice(0, -1).join(".");
  const artifactId = segs[segs.length - 1]!;
  const rows = await deps.db
    .select({ version: component.version, updatedAt: component.updatedAt })
    .from(component)
    .where(and(eq(component.repositoryId, repo.id), eq(component.namespace, groupId), eq(component.name, artifactId)));
  if (rows.length === 0) return null;
  return renderArtifactMetadata({
    groupId,
    artifactId,
    versions: rows.map((r) => r.version),
    lastUpdated: newest(rows.map((r) => r.updatedAt)),
  });
}

/** Generated (or stored plugin) metadata XML for a hosted repo directory, or null. */
export async function hostedMetadataXml(deps: FormatDeps, repo: Repo, dir: string): Promise<string | null> {
  const stored = await deps.assets.find(repo.id, dir === "" ? "maven-metadata.xml" : `${dir}/maven-metadata.xml`);
  if (stored) return readText(deps, stored);
  if (dir === "") return null;
  if (dir.endsWith("-SNAPSHOT")) return snapshotMetadataXml(deps, repo, dir);
  return artifactMetadataXml(deps, repo, dir);
}

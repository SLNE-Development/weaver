import { and, asc, desc, eq, sql } from "drizzle-orm";
import { dockerManifest, dockerManifestRef, dockerTag, type Db } from "@weaver/db";
import { isImageArtifactType } from "./client.js";
import { listReferrers } from "./hosted/referrers.js";
import type { Descriptor, Platform } from "./manifest-parse.js";

export { artifactTypeLabel, dockerSnippets, isImageArtifactType, isIndexMediaType, type DockerSnippets } from "./client.js";

/** One image of a repository as the browse view lists it. */
export interface ImageSummary {
  image: string;
  tagCount: number;
  manifestCount: number;
  /** Bytes of the distinct blobs linked to the image. */
  totalSize: number;
  /** The newest manifest push or tag move. */
  updatedAt: Date;
}

/** One tag of an image with the manifest it points at. */
export interface TagRow {
  tag: string;
  digest: string;
  mediaType: string;
  platforms: Platform[];
  totalSize: number;
  updatedAt: Date;
  lastPulledAt: Date | null;
}

/** One stored manifest with what it references, what refers to it and the tags pointing at it. */
export interface ManifestDetail {
  digest: string;
  mediaType: string;
  /** The artifact type of an attached artifact (Helm chart, signature, SBOM); null for a container image or index. */
  artifactType: string | null;
  platforms: Platform[];
  /** Byte length of the manifest itself. */
  size: number;
  /** Config plus layers, or the sum of the children of an index. */
  totalSize: number;
  tags: string[];
  /**
   * The config and layers of an image, or the child manifests of an index (with their platform, or marked as a
   * build attestation instead of the `unknown/unknown` platform), in order.
   */
  refs: Array<{ kind: "blob" | "manifest"; digest: string; mediaType: string; size: number; platform?: Platform; attestation?: true }>;
  /** Manifests whose `subject` is this one (signatures, SBOMs, attestations). */
  referrers: Descriptor[];
  createdAt: Date;
}

/** A row of a raw SQL result; timestamps and bigint aggregates may arrive as strings. */
type Raw = Record<string, unknown>;

/**
 * The images of a repository by name, `limit` per page after `cursor` (the last image of the previous page),
 * optionally only names containing `query` (case-insensitive). `next` is the cursor of the following page.
 */
export async function listImages(
  db: Db,
  repoId: string,
  opts: { query?: string; cursor?: string; limit: number },
): Promise<{ items: ImageSummary[]; next: string | null }> {
  const pattern = opts.query ? `%${opts.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const result = await db.execute(sql`
    SELECT m.image,
      count(*)::int AS manifest_count,
      (SELECT count(*) FROM docker_tag t WHERE t.repository_id = ${repoId} AND t.image = m.image)::int AS tag_count,
      (SELECT coalesce(sum(b.size), 0) FROM docker_blob_link l JOIN docker_blob b ON b.id = l.blob_id
        WHERE l.repository_id = ${repoId} AND l.image = m.image)::bigint AS total_size,
      greatest(max(m.created_at),
        (SELECT max(t.updated_at) FROM docker_tag t WHERE t.repository_id = ${repoId} AND t.image = m.image)) AS updated_at
    FROM docker_manifest m
    WHERE m.repository_id = ${repoId}
      ${pattern === null ? sql`` : sql`AND m.image ILIKE ${pattern}`}
      ${opts.cursor === undefined ? sql`` : sql`AND m.image > ${opts.cursor}`}
    GROUP BY m.image
    ORDER BY m.image
    LIMIT ${opts.limit + 1}`);
  const rows = (Array.isArray(result) ? result : (result as { rows: Raw[] }).rows) as Raw[];
  const items = rows.slice(0, opts.limit).map(
    (r): ImageSummary => ({
      image: String(r.image),
      tagCount: Number(r.tag_count),
      manifestCount: Number(r.manifest_count),
      totalSize: Number(r.total_size),
      updatedAt: new Date(r.updated_at as string | Date),
    }),
  );
  return { items, next: rows.length > opts.limit ? items.at(-1)!.image : null };
}

/** The tags of an image with their manifests, most recently moved first (ties by name). */
export async function listImageTags(db: Db, repoId: string, image: string): Promise<TagRow[]> {
  return db
    .select({
      tag: dockerTag.tag,
      digest: dockerManifest.digest,
      mediaType: dockerManifest.mediaType,
      platforms: dockerManifest.platforms,
      totalSize: dockerManifest.totalSize,
      updatedAt: dockerTag.updatedAt,
      lastPulledAt: dockerTag.lastPulledAt,
    })
    .from(dockerTag)
    .innerJoin(dockerManifest, eq(dockerManifest.id, dockerTag.manifestId))
    .where(and(eq(dockerTag.repositoryId, repoId), eq(dockerTag.image, image)))
    .orderBy(desc(dockerTag.updatedAt), asc(dockerTag.tag));
}

/** What an index says about one child: its platform, or that it is a build attestation (`unknown/unknown`). */
interface ChildInfo {
  platform?: Platform;
  attestation?: true;
}

/** The platform (or attestation marker) of each child of a stored index, by digest; empty when it is not an index. */
function childInfo(content: Buffer): Map<string, ChildInfo> {
  const out = new Map<string, ChildInfo>();
  try {
    const json = JSON.parse(content.toString("utf8")) as {
      manifests?: Array<{ digest?: unknown; platform?: Platform; annotations?: Record<string, string> }>;
    };
    for (const m of json.manifests ?? []) {
      if (typeof m.digest !== "string" || out.has(m.digest)) continue;
      const unknown = m.platform?.os === "unknown" && m.platform.architecture === "unknown";
      // buildx stores provenance and SBOM attestations as index children with the platform unknown/unknown.
      if (unknown || m.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") out.set(m.digest, { attestation: true });
      else if (m.platform) out.set(m.digest, { platform: m.platform });
    }
  } catch {
    // Stored manifests were validated on push; unreadable content just has no platforms.
  }
  return out;
}

/** The manifest `digest` of repo/image with its references, referrers and tags, or null when it is not stored there. */
export async function getManifestDetail(db: Db, repoId: string, image: string, digest: string): Promise<ManifestDetail | null> {
  const [row] = await db
    .select()
    .from(dockerManifest)
    .where(and(eq(dockerManifest.repositoryId, repoId), eq(dockerManifest.image, image), eq(dockerManifest.digest, digest)));
  if (!row) return null;
  const [refs, tags, referrers] = await Promise.all([
    db
      .select({ kind: dockerManifestRef.kind, digest: dockerManifestRef.digest, mediaType: dockerManifestRef.mediaType, size: dockerManifestRef.size })
      .from(dockerManifestRef)
      .where(eq(dockerManifestRef.manifestId, row.id))
      .orderBy(asc(dockerManifestRef.position)),
    db.select({ tag: dockerTag.tag }).from(dockerTag).where(eq(dockerTag.manifestId, row.id)).orderBy(asc(dockerTag.tag)),
    listReferrers(db, repoId, image, digest, null),
  ]);
  const children = childInfo(row.content);
  return {
    digest: row.digest,
    mediaType: row.mediaType,
    artifactType: isImageArtifactType(row.artifactType) ? null : row.artifactType,
    platforms: row.platforms,
    size: row.size,
    totalSize: row.totalSize,
    tags: tags.map((t) => t.tag),
    refs: refs.map((r) => (r.kind === "manifest" ? { ...r, ...children.get(r.digest) } : r)),
    referrers,
    createdAt: row.createdAt,
  };
}

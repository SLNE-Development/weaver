import { and, asc, eq } from "drizzle-orm";
import { dockerManifest, type Db } from "@weaver/db";
import type { Descriptor } from "../manifest-parse.js";
import { API_VERSION, type HostedReadCtx } from "./blobs.js";

/** The media type of a referrers response. */
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

/**
 * The manifests of repo/image whose `subject` is `digest`, as descriptors carrying their artifact type
 * (the manifest's `artifactType`, else its config media type) and annotations; only `artifactType`
 * matches when a filter is given. Oldest first.
 */
export async function listReferrers(
  db: Db,
  repoId: string,
  image: string,
  digest: string,
  artifactType: string | null,
): Promise<Descriptor[]> {
  const rows = await db
    .select({
      mediaType: dockerManifest.mediaType,
      digest: dockerManifest.digest,
      size: dockerManifest.size,
      artifactType: dockerManifest.artifactType,
      annotations: dockerManifest.annotations,
    })
    .from(dockerManifest)
    .where(
      and(
        eq(dockerManifest.repositoryId, repoId),
        eq(dockerManifest.image, image),
        eq(dockerManifest.subjectDigest, digest),
        artifactType === null ? undefined : eq(dockerManifest.artifactType, artifactType),
      ),
    )
    .orderBy(asc(dockerManifest.createdAt), asc(dockerManifest.digest));
  return rows.map((r) => {
    const d: Descriptor = { mediaType: r.mediaType, digest: r.digest, size: r.size };
    if (r.artifactType) d.artifactType = r.artifactType;
    if (r.annotations && Object.keys(r.annotations).length > 0) d.annotations = r.annotations;
    return d;
  });
}

/**
 * `GET .../referrers/<digest>?artifactType=`: an OCI image index of the manifests referring to `digest`
 * (empty when none, never 404), with `OCI-Filters-Applied: artifactType` when filtered.
 */
export async function serveReferrers(ctx: HostedReadCtx, req: Request, digest: string): Promise<Response> {
  const { deps, target } = ctx;
  const artifactType = new URL(req.url).searchParams.get("artifactType") || null;
  const manifests = await listReferrers(deps.db, target.repo.id, target.image, digest, artifactType);
  const headers: Record<string, string> = { ...API_VERSION, "content-type": OCI_INDEX };
  if (artifactType !== null) headers["oci-filters-applied"] = "artifactType";
  return new Response(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests }), { status: 200, headers });
}

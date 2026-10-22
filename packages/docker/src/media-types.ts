/** The manifest media types the registry accepts: Docker v2 schema 2 (manifest, list) and OCI (manifest, index). */
export const MANIFEST_MEDIA_TYPES: readonly string[] = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
];

const DIGEST = /^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/;

/** True for `sha256:<64 hex>` (and `sha512:<128 hex>`, accepted for parsing) digests. */
export function isDigest(s: string): boolean {
  return DIGEST.test(s);
}

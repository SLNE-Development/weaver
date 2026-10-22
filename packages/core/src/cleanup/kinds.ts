import type { Format } from "../repos/config.js";

/** Every rule a cleanup policy can apply, in the order of the database enum `cleanup_kind`. */
export const CLEANUP_KINDS = [
  "keep_last_snapshot_builds",
  "delete_stale_snapshots",
  "delete_not_downloaded",
  "keep_last_versions",
  "delete_untagged_manifests",
  "keep_last_tags",
] as const;

/** A rule a cleanup policy can apply. */
export type CleanupKind = (typeof CLEANUP_KINDS)[number];

/** The cleanup kinds each format supports, in the order the admin UI offers them. */
export const CLEANUP_KINDS_BY_FORMAT: Record<Format, readonly CleanupKind[]> = {
  maven: ["keep_last_snapshot_builds", "delete_stale_snapshots", "delete_not_downloaded"],
  npm: ["delete_not_downloaded", "keep_last_versions"],
  docker: ["delete_untagged_manifests", "keep_last_tags", "delete_not_downloaded"],
  proto: ["keep_last_snapshot_builds", "delete_stale_snapshots", "delete_not_downloaded"],
};

/** Whether a policy of `kind` needs a tag `pattern` (keep_last_tags); every other kind forbids one. */
export function kindUsesPattern(kind: CleanupKind): boolean {
  return kind === "keep_last_tags";
}

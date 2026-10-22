import type { Format, SearchHit } from "@weaver/core";
import { artifactHref, repositoryHref } from "@/lib/browse";

/** A repository browse URL with search params. */
function withParams(repo: string, params: Record<string, string>): string {
  return `${repositoryHref(repo)}?${new URLSearchParams(params).toString()}`;
}

/**
 * The package page of each format, by repository, namespace and name. Client-safe (no server
 * imports), so search results and the command dialog can link packages; re-exported by
 * `registry.tsx` next to `BROWSE_VIEWS`.
 */
export const BROWSE_LINKS: Partial<Record<Format, (repo: string, namespace: string, name: string) => string>> = {
  maven: (repo, groupId, artifactId) => withParams(repo, { g: groupId, a: artifactId }),
  proto: (repo, group, name) => artifactHref(repo, group, name),
  npm: (repo, scope, name) => {
    const full = scope === "" ? [name] : [scope.startsWith("@") ? scope : `@${scope}`, name];
    return `${repositoryHref(repo)}/-/npm/${full.map((part) => encodeURIComponent(part).replace(/^%40/, "@")).join("/")}`;
  },
  // No docker package page yet: images link to the repository browse page.
  docker: (repo) => repositoryHref(repo),
};

/**
 * Where a search hit is browsed: its format's package page in the hit's repository, or in the
 * group (`via`) when the caller reads it only through that group; `/browse/<repo>` for a format
 * without a package page. Null for a proto package of a mirror or read through a group: proto
 * artifact pages only exist for hosted repositories the caller reads directly.
 */
export function packageHref(hit: SearchHit): string | null {
  if (hit.format === "proto" && (hit.via !== null || hit.kind !== "hosted")) return null;
  const repo = hit.via ?? hit.repository;
  const build = BROWSE_LINKS[hit.format];
  return build ? build(repo, hit.namespace, hit.name) : repositoryHref(repo);
}

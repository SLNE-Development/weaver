export type Role = "admin" | "maintainer" | "viewer";
export type Access = "read" | "write";

/** One scope entry of an API key: a repository, an optional group prefix, and an access level. */
export interface KeyPermission {
  repositoryId: string;
  /** The repository's name, for display; matching is always by `repositoryId`. */
  repository: string;
  groupPrefix: string | null;
  access: Access;
}

export type Principal =
  | { kind: "anonymous" }
  | { kind: "user"; userId: string; role: Role }
  | { kind: "apikey"; keyId: string; userId: string; role: Role; permissions: KeyPermission[] };

/** The parts of a repository that permission checks need. */
export interface RepoRef {
  id: string;
  name: string;
  visibility: "public" | "private";
  kind?: "hosted" | "mirror" | "group";
}

/**
 * Whether `group` is covered by `prefix`. A null prefix covers every group; otherwise the group
 * must equal the prefix or continue it at a dot boundary (`dev.surf` covers `dev.surf.economy`
 * but not `dev.surfboard`).
 */
export function groupMatches(prefix: string | null, group: string): boolean {
  if (prefix === null) return true;
  return group === prefix || group.startsWith(`${prefix}.`);
}

/** The highest access a key can effectively hold for its owner's current role. */
export function maxKeyAccess(role: Role): Access {
  return role === "viewer" ? "read" : "write";
}

/** Whether an API key principal holds `access` on the repository and group via its entries, capped by the owner's current role. */
function keyGrants(
  p: Extract<Principal, { kind: "apikey" }>,
  repo: RepoRef,
  group: string,
  access: Access,
): boolean {
  const ceiling = maxKeyAccess(p.role);
  return p.permissions.some((entry) => {
    if (entry.repositoryId !== repo.id || !groupMatches(entry.groupPrefix, group)) return false;
    const effective: Access = ceiling === "read" ? "read" : entry.access;
    return access === "read" || effective === "write";
  });
}

/**
 * Whether the principal may read or write within a repository. `scope` is the proto group, or `""`
 * for formats without groups; an entry's prefix only restricts when the entry has one. Users read
 * everything but never write directly (publishing goes through keys); keys are limited to their
 * entries, capped by the owner's role at request time. Groups (`kind === "group"`) are read-only
 * for everyone.
 */
export function canAccess(p: Principal, repo: RepoRef, scope: string, access: Access): boolean {
  if (access === "write" && repo.kind === "group") return false;
  if (access === "read" && repo.visibility === "public") return true;
  switch (p.kind) {
    case "anonymous":
      return false;
    case "user":
      return access === "read";
    case "apikey":
      return keyGrants(p, repo, scope, access);
  }
}

/** Whether the principal may read everything served through `group`: read access on the group itself. */
export function canReadThroughGroup(p: Principal, group: RepoRef): boolean {
  return canAccess(p, group, "", "read");
}

/** Whether the principal may delete versions in the group: a maintainer or admin user, or a key with write access owned by one. */
export function canDeleteVersions(p: Principal, repo: RepoRef, group: string): boolean {
  if (repo.kind === "group") return false;
  switch (p.kind) {
    case "anonymous":
      return false;
    case "user":
      return p.role !== "viewer";
    case "apikey":
      return p.role !== "viewer" && keyGrants(p, repo, group, "write");
  }
}

/** Whether the principal is an admin user or a key owned by one. */
export function isAdmin(p: Principal): boolean {
  return p.kind !== "anonymous" && p.role === "admin";
}

/** Whether the principal may override dependent checks with `force`. */
export function canForce(p: Principal): boolean {
  return isAdmin(p);
}

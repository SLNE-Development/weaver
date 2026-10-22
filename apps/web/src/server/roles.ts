import type { Role } from "@weaver/core";

/** All roles, lowest to highest privilege. */
export const ROLES: readonly Role[] = ["viewer", "maintainer", "admin"];

/** Whether `value` names a Weaver role. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * The known roles in an admin-plugin role string, which may list several roles separated by
 * commas (`"admin, maintainer"`). Entries are trimmed; unknown entries are ignored.
 */
export function parseRoles(raw: string | null | undefined): Role[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(isRole);
}

/** The highest role in `raw`; a user without a known role counts as `viewer`. */
export function effectiveRole(raw: string | null | undefined): Role {
  const roles = parseRoles(raw);
  return [...ROLES].reverse().find((role) => roles.includes(role)) ?? "viewer";
}

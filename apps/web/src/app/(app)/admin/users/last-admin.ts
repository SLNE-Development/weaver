import type { Role } from "@weaver/core";

/** The fields the last-admin rule looks at. */
export interface AdminCandidate {
  id: string;
  role: Role;
  banned: boolean;
}

/**
 * The id of the only active (unbanned) admin, or `null` when there are several. That user can't
 * be demoted, banned or removed; the server enforces the same rule.
 */
export function lastAdminId(users: readonly AdminCandidate[]): string | null {
  const active = users.filter((u) => u.role === "admin" && !u.banned);
  return active.length === 1 ? active[0]!.id : null;
}

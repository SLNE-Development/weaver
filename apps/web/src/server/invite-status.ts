import { eq } from "drizzle-orm";
import type { Role } from "@weaver/core";
import { invite, type Db } from "@weaver/db";
import { hashInviteToken } from "./invite";
import { isRole } from "./roles";

/** What the `/invite/<token>` page tells the visitor about a link. */
export type InviteStatus =
  | { kind: "valid"; role: Role; note: string | null; expiresAt: Date }
  | { kind: "used" }
  | { kind: "expired" }
  | { kind: "unknown" };

/**
 * Looks up the invite behind `token` by its hash. A used invite reports `used` even after it
 * expired; an invite with a role this version doesn't know counts as `unknown`.
 */
export async function getInviteStatus(db: Db, token: string, now: Date = new Date()): Promise<InviteStatus> {
  if (!token) return { kind: "unknown" };
  const [row] = await db
    .select({ role: invite.role, note: invite.note, expiresAt: invite.expiresAt, usedAt: invite.usedAt })
    .from(invite)
    .where(eq(invite.tokenHash, hashInviteToken(token)))
    .limit(1);
  if (!row || !isRole(row.role)) return { kind: "unknown" };
  if (row.usedAt) return { kind: "used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: "expired" };
  return { kind: "valid", role: row.role, note: row.note, expiresAt: row.expiresAt };
}

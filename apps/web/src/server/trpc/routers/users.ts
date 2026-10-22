import { TRPCError } from "@trpc/server";
import { asc, eq, inArray, like } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, type Role } from "@weaver/core";
import { account, apikey, session, user, type Db, type Tx } from "@weaver/db";
import { effectiveRole, parseRoles } from "../../roles";
import { adminProcedure, router, type UserPrincipal } from "../init";
import { notFound } from "../helpers";

/** A user as the admin users table shows it. */
export interface UserSummary {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  /** Whether a ban is in effect right now (an expired ban counts as lifted). */
  banned: boolean;
  banReason: string | null;
  banExpires: Date | null;
  createdAt: Date;
  /** Connected sign-in providers, such as `github` or `discord`. */
  providers: string[];
}

type UserRow = typeof user.$inferSelect;

const DAY_MS = 86_400_000;

function isBannedNow(row: Pick<UserRow, "banned" | "banExpires">): boolean {
  return row.banned === true && (row.banExpires === null || row.banExpires.getTime() > Date.now());
}

const userId = z.object({ userId: z.string().min(1).max(200) });

/**
 * Loads the target user and locks every admin row for the rest of the transaction, so concurrent
 * changes can't remove the last admin between the check and the update.
 */
async function lockTarget(tx: Tx, id: string): Promise<{ target: UserRow; activeAdmins: string[] }> {
  const admins = await tx.select().from(user).where(like(user.role, "%admin%")).for("update");
  const [target] = await tx.select().from(user).where(eq(user.id, id)).for("update");
  if (!target) throw notFound(`User ${id} was not found`);
  const activeAdmins = admins.filter((row) => parseRoles(row.role).includes("admin") && !isBannedNow(row)).map((row) => row.id);
  return { target, activeAdmins };
}

/** Refuses to take away the last active admin. */
function assertNotLastAdmin(target: UserRow, activeAdmins: string[], what: string): void {
  if (activeAdmins.includes(target.id) && activeAdmins.length === 1) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The last admin can't be ${what}` });
  }
}

/** Refuses an admin's attempt to ban or remove their own account. */
function assertNotSelf(principal: UserPrincipal, targetId: string, what: "ban" | "remove"): void {
  if (principal.userId === targetId) {
    throw new TRPCError({ code: "FORBIDDEN", message: `You can't ${what} your own account` });
  }
}

/** Runs a user change in a transaction with its audit entry. */
async function changeUser(
  ctx: { db: Db; principal: UserPrincipal },
  id: string,
  action: string,
  change: (tx: Tx, locked: { target: UserRow; activeAdmins: string[] }) => Promise<unknown>,
): Promise<{ userId: string }> {
  await ctx.db.transaction(async (tx) => {
    const locked = await lockTarget(tx, id);
    const details = await change(tx, locked);
    await recordAudit(tx, { actor: ctx.principal, action, target: id, details: details ?? undefined });
  });
  return { userId: id };
}

/**
 * User administration (admin). Every change is audited; the last admin can't be demoted, banned or
 * removed, and admins can't ban or remove their own account.
 */
export const usersRouter = router({
  list: adminProcedure.query(async ({ ctx }): Promise<UserSummary[]> => {
    const rows = await ctx.db.select().from(user).orderBy(asc(user.name), asc(user.id));
    const accounts =
      rows.length === 0
        ? []
        : await ctx.db
            .select({ userId: account.userId, providerId: account.providerId })
            .from(account)
            .where(
              inArray(
                account.userId,
                rows.map((r) => r.id),
              ),
            );
    return rows.map((row) => {
      const banned = isBannedNow(row);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        image: row.image,
        role: effectiveRole(row.role),
        banned,
        banReason: banned ? row.banReason : null,
        banExpires: banned ? row.banExpires : null,
        createdAt: row.createdAt,
        providers: [...new Set(accounts.filter((a) => a.userId === row.id).map((a) => a.providerId))].sort(),
      };
    });
  }),

  setRole: adminProcedure
    .input(userId.extend({ role: z.enum(["admin", "maintainer", "viewer"]) }))
    .mutation(({ ctx, input }) =>
      changeUser(ctx, input.userId, "user.setRole", async (tx, { target, activeAdmins }) => {
        if (input.role !== "admin") assertNotLastAdmin(target, activeAdmins, "demoted");
        await tx.update(user).set({ role: input.role }).where(eq(user.id, target.id));
        return { from: effectiveRole(target.role), to: input.role };
      }),
    ),

  /** Bans a user (optionally until `expiresInDays`) and ends their sessions; their API keys stop working. */
  ban: adminProcedure
    .input(userId.extend({ reason: z.string().trim().max(200).optional(), expiresInDays: z.number().int().min(1).max(3650).optional() }))
    .mutation(({ ctx, input }) => {
      assertNotSelf(ctx.principal, input.userId, "ban");
      return changeUser(ctx, input.userId, "user.ban", async (tx, { target, activeAdmins }) => {
        assertNotLastAdmin(target, activeAdmins, "banned");
        const banExpires = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * DAY_MS) : null;
        await tx.update(user).set({ banned: true, banReason: input.reason || null, banExpires }).where(eq(user.id, target.id));
        await tx.delete(session).where(eq(session.userId, target.id));
        return { reason: input.reason ?? null, banExpires: banExpires?.toISOString() ?? null };
      });
    }),

  unban: adminProcedure.input(userId).mutation(({ ctx, input }) =>
    changeUser(ctx, input.userId, "user.unban", async (tx, { target }) => {
      await tx.update(user).set({ banned: false, banReason: null, banExpires: null }).where(eq(user.id, target.id));
    }),
  ),

  /** Deletes a user with their sessions, connected accounts and API keys. */
  remove: adminProcedure.input(userId).mutation(({ ctx, input }) => {
    assertNotSelf(ctx.principal, input.userId, "remove");
    return changeUser(ctx, input.userId, "user.remove", async (tx, { target, activeAdmins }) => {
      assertNotLastAdmin(target, activeAdmins, "removed");
      // API keys reference their owner without a foreign key, so they are removed explicitly.
      await tx.delete(apikey).where(eq(apikey.referenceId, target.id));
      await tx.delete(user).where(eq(user.id, target.id));
      return { name: target.name, email: target.email };
    });
  }),
});

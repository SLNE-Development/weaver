import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Role } from "@weaver/core";
import { invite, user } from "@weaver/db";
import { buildInviteUrl, generateInviteToken, hashInviteToken } from "../../invite";
import { adminProcedure, router } from "../init";
import { audited, notFound } from "../helpers";

/** Where an invite stands: usable, consumed by a sign-up, or past its expiry. */
export type InviteStatus = "open" | "used" | "expired";

/** An invite as listed; the token itself is never stored or returned again. */
export interface InviteSummary {
  id: string;
  role: Role;
  note: string | null;
  status: InviteStatus;
  createdAt: Date;
  expiresAt: Date;
  createdByName: string | null;
  usedAt: Date | null;
  usedByUserId: string | null;
  usedByName: string | null;
}

const DAY_MS = 86_400_000;

const creator = alias(user, "invite_creator");
const consumer = alias(user, "invite_consumer");

/** One-time invite links that let someone sign up with a given role (admin). Audited. */
export const invitesRouter = router({
  /** Every invite (open, used and expired), newest first. */
  list: adminProcedure.query(async ({ ctx }): Promise<InviteSummary[]> => {
    const rows = await ctx.db
      .select({
        id: invite.id,
        role: invite.role,
        note: invite.note,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        usedAt: invite.usedAt,
        usedByUserId: invite.usedByUserId,
        createdByName: creator.name,
        usedByName: consumer.name,
      })
      .from(invite)
      .leftJoin(creator, eq(creator.id, invite.createdBy))
      .leftJoin(consumer, eq(consumer.id, invite.usedByUserId))
      .orderBy(desc(invite.createdAt), desc(invite.id));
    const now = Date.now();
    return rows.map((row) => ({
      ...row,
      role: row.role as Role,
      status: row.usedAt ? "used" : row.expiresAt.getTime() <= now ? "expired" : "open",
    }));
  }),

  /**
   * Creates an invite and returns `{ id, url, expiresAt }`. The absolute URL (from
   * `BETTER_AUTH_URL`) carries the token; this is the only time it is returned, only its hash is stored.
   */
  create: adminProcedure
    .input(
      z.object({
        role: z.enum(["admin", "maintainer", "viewer"]),
        expiresInDays: z.number().int().min(1).max(30),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const token = generateInviteToken();
      const expiresAt = new Date(Date.now() + input.expiresInDays * DAY_MS);
      const created = await audited(
        ctx.db,
        (row: { id: string }) => ({
          actor: ctx.principal,
          action: "invite.create",
          target: row.id,
          details: { role: input.role, expiresAt: expiresAt.toISOString(), note: input.note ?? null },
        }),
        async (tx) =>
          (
            await tx
              .insert(invite)
              .values({
                tokenHash: hashInviteToken(token),
                role: input.role,
                note: input.note || null,
                createdBy: ctx.principal.userId,
                expiresAt,
              })
              .returning({ id: invite.id })
          )[0]!,
      );
      return { id: created.id, url: buildInviteUrl(ctx.publicUrl, token), expiresAt };
    }),

  /** Revokes (deletes) an unused invite; `PRECONDITION_FAILED` for one that was already used. */
  revoke: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await audited(ctx.db, { actor: ctx.principal, action: "invite.revoke", target: input.id }, async (tx) => {
      const removed = await tx
        .delete(invite)
        .where(and(eq(invite.id, input.id), isNull(invite.usedAt)))
        .returning({ id: invite.id });
      if (removed.length > 0) return;
      const [existing] = await tx.select({ id: invite.id }).from(invite).where(eq(invite.id, input.id));
      if (existing) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This invite was already used" });
      throw notFound(`Invite ${input.id} was not found`);
    });
    return { id: input.id };
  }),
});

import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, like, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { apikey, auditEvent, user } from "@weaver/db";
import { adminProcedure, router } from "../init";
import { escapeLike } from "../helpers";

/** One audit log entry as listed. */
export interface AuditItem {
  id: string;
  at: Date;
  actorType: "user" | "apikey" | "anonymous" | "system";
  actorId: string | null;
  /** The user's name, or the API key's name, when the actor still exists. */
  actorName: string | null;
  action: string;
  target: string;
  details: unknown;
  forced: boolean;
}

/** `at` in microseconds since the epoch: exact, unlike a JS `Date`, so cursors never skip or repeat entries. */
const atMicros = sql<string>`(extract(epoch from ${auditEvent.at}) * 1000000)::bigint`;

/** Cursor format: `<atMicros>_<id>` of the last entry of the previous page. */
const CURSOR_RE = /^(\d{1,20})_([0-9a-f-]{36})$/;

function afterCursor(cursor: string): SQL {
  const match = CURSOR_RE.exec(cursor);
  if (!match) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  const [, micros, id] = match as unknown as [string, string, string];
  return or(lt(atMicros, sql`${micros}::bigint`), and(eq(atMicros, sql`${micros}::bigint`), lt(auditEvent.id, id)))!;
}

/** The audit log (admin). */
export const auditRouter = router({
  /**
   * Entries newest first, `limit` per page; pass the returned `nextCursor` (null on the last page)
   * as `cursor` for the next one. `action` matches exactly or as a prefix (`invite` matches `invite.create`).
   */
  list: adminProcedure
    .input(
      z.object({
        cursor: z.string().max(100).nullish(),
        limit: z.number().int().min(1).max(100).default(50),
        action: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<{ items: AuditItem[]; nextCursor: string | null }> => {
      const rows = await ctx.db
        .select({
          id: auditEvent.id,
          at: auditEvent.at,
          atMicros,
          actorType: auditEvent.actorType,
          actorId: auditEvent.actorId,
          userName: user.name,
          keyName: apikey.name,
          action: auditEvent.action,
          target: auditEvent.target,
          details: auditEvent.details,
          forced: auditEvent.forced,
        })
        .from(auditEvent)
        .leftJoin(user, and(eq(auditEvent.actorType, "user"), eq(user.id, auditEvent.actorId)))
        .leftJoin(apikey, and(eq(auditEvent.actorType, "apikey"), eq(apikey.id, auditEvent.actorId)))
        .where(
          and(
            input.action
              ? or(eq(auditEvent.action, input.action), like(auditEvent.action, `${escapeLike(input.action)}.%`))
              : undefined,
            input.cursor ? afterCursor(input.cursor) : undefined,
          ),
        )
        .orderBy(desc(atMicros), desc(auditEvent.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        items: page.map(
          ({ id, at, actorType, actorId, userName, keyName, action, target, details, forced }): AuditItem => ({
            id,
            at,
            actorType,
            actorId,
            actorName: userName ?? keyName ?? null,
            action,
            target,
            details,
            forced,
          }),
        ),
        nextCursor: rows.length > input.limit && last ? `${last.atMicros}_${last.id}` : null,
      };
    }),

  /** The distinct actions in the log, for the filter. */
  actions: adminProcedure.query(async ({ ctx }) =>
    (await ctx.db.selectDistinct({ action: auditEvent.action }).from(auditEvent).orderBy(asc(auditEvent.action))).map(
      (row) => row.action,
    ),
  ),
});

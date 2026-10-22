import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, type KeyPermission } from "@weaver/core";
import { apikey, repoPermission, repository, user } from "@weaver/db";
import { authedProcedure, router } from "../init";
import { issueApiKey, issueKeyInput } from "../../api-keys";
import { notFound } from "../helpers";

export { API_KEY_PREFIX } from "../../api-keys";

/** An API key as listed: never the secret, only its first characters (`start`). */
export interface ApiKeySummary {
  id: string;
  name: string | null;
  /** The first characters of the secret, for recognising a key. */
  start: string | null;
  userId: string;
  ownerName: string | null;
  enabled: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  permissions: KeyPermission[];
}

/** Personal API keys: create (the secret is shown once), list, revoke. */
export const keysRouter = router({
  /** The caller's keys, newest first; admins may pass `all: true` for every user's keys. */
  list: authedProcedure
    .input(z.object({ all: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }): Promise<ApiKeySummary[]> => {
      const all = input?.all ?? false;
      if (all && ctx.principal.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
      const keys = await ctx.db
        .select({
          id: apikey.id,
          name: apikey.name,
          start: apikey.start,
          userId: apikey.referenceId,
          ownerName: user.name,
          enabled: apikey.enabled,
          expiresAt: apikey.expiresAt,
          lastUsedAt: apikey.lastRequest,
          createdAt: apikey.createdAt,
        })
        .from(apikey)
        .leftJoin(user, eq(user.id, apikey.referenceId))
        .where(all ? undefined : eq(apikey.referenceId, ctx.principal.userId))
        .orderBy(desc(apikey.createdAt));
      const permissions =
        keys.length === 0
          ? []
          : await ctx.db
              .select({
                apiKeyId: repoPermission.apiKeyId,
                repositoryId: repoPermission.repositoryId,
                repository: repository.name,
                groupPrefix: repoPermission.groupPrefix,
                access: repoPermission.access,
              })
              .from(repoPermission)
              .innerJoin(repository, eq(repository.id, repoPermission.repositoryId))
              .where(
                inArray(
                  repoPermission.apiKeyId,
                  keys.map((k) => k.id),
                ),
              )
              .orderBy(asc(repoPermission.id));
      return keys.map((key) => ({
        ...key,
        enabled: key.enabled ?? true,
        permissions: permissions
          .filter((p) => p.apiKeyId === key.id)
          .map(({ repositoryId, repository: repo, groupPrefix: prefix, access }) => ({
            repositoryId,
            repository: repo,
            groupPrefix: prefix,
            access,
          })),
      }));
    }),

  /**
   * Creates a key for the caller and returns `{ id, key }`; the only time the secret is returned.
   * Viewers may only grant `read` (`FORBIDDEN` otherwise); unknown repositories and entries that
   * can never grant anything (write on a group, a group prefix outside proto hosted/mirror) are `BAD_REQUEST`.
   */
  create: authedProcedure
    .input(issueKeyInput)
    .mutation(({ ctx, input }) => issueApiKey({ db: ctx.db, auth: ctx.auth }, ctx.principal, input)),

  /** Revokes (deletes) one of the caller's keys, or any key for admins; `NOT_FOUND` otherwise. */
  revoke: authedProcedure.input(z.object({ id: z.string().min(1).max(200) })).mutation(async ({ ctx, input }) => {
    const { principal } = ctx;
    const owned = principal.role === "admin" ? undefined : eq(apikey.referenceId, principal.userId);
    await ctx.db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(apikey)
        .where(and(eq(apikey.id, input.id), owned))
        .returning({ id: apikey.id, name: apikey.name, userId: apikey.referenceId });
      if (!removed) throw notFound(`API key ${input.id} was not found`);
      await recordAudit(tx, {
        actor: principal,
        action: "key.revoke",
        target: removed.id,
        details: { name: removed.name, userId: removed.userId },
      });
    });
    return { id: input.id };
  }),
});

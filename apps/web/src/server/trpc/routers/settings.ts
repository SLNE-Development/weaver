import { z } from "zod";
import { STORE_IDS, updateSettings, type ServerSettings, type StoreId } from "@weaver/core";
import { adminProcedure, publicProcedure, router } from "../init";

/** Server-wide settings. */
export const settingsRouter = router({
  /** The settings any caller may know (the layout needs them before sign-in): only `anonymousView`. */
  get: publicProcedure.query(({ ctx }): Pick<ServerSettings, "anonymousView"> => ({ anonymousView: ctx.settings.anonymousView })),

  /** Changes settings (admin), audited as `settings.update`; returns the resulting settings. */
  update: adminProcedure
    .input(z.object({ anonymousView: z.boolean().optional(), defaultCacheStore: z.enum(STORE_IDS).optional() }))
    .mutation(
      async ({ ctx, input }): Promise<ServerSettings> =>
        updateSettings(ctx.db, input, ctx.principal, {
          configuredStores: ctx.stores.configured(),
          primaryStore: ctx.stores.primary.id,
        }),
    ),

  /** The primary store id and every configured store id, for the storage pickers (admin). */
  storage: adminProcedure.query(({ ctx }): { primary: StoreId; configured: StoreId[] } => ({
    primary: ctx.stores.primary.id,
    configured: ctx.stores.configured(),
  })),
});

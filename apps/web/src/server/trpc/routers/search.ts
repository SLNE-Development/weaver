import { z } from "zod";
import { FORMATS, SEARCH_LIMIT_MAX, SEARCH_OFFSET_MAX, searchComponents, type Format, type SearchHit } from "@weaver/core";
import { browseProcedure, router } from "../init";

/** Package search across every repository the caller may read. */
export const searchRouter = router({
  /**
   * Packages matching `q` (2..200 characters) in the repositories the caller may read, directly or
   * through a group, optionally of one `format`, ranked exact, prefix, then fuzzy. Unreadable
   * repositories never show up, not even as counts. `hasMore` tells whether another page follows.
   */
  query: browseProcedure
    .input(
      z.object({
        q: z.string().trim().min(2).max(200),
        format: z.enum(FORMATS as [Format, ...Format[]]).optional(),
        limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).default(20),
        offset: z.number().int().min(0).max(SEARCH_OFFSET_MAX).default(0),
      }),
    )
    .query(({ ctx, input }): Promise<{ hits: SearchHit[]; hasMore: boolean }> =>
      searchComponents({ db: ctx.db, repos: ctx.repos }, ctx.principal, {
        text: input.q,
        ...(input.format ? { format: input.format } : {}),
        limit: input.limit,
        offset: input.offset,
      }),
    ),
});

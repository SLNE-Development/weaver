import { z } from "zod";
import { formatCoordinate, parseCoordinate, RegistryError, type Dependent } from "@weaver/core";
import { maintainerProcedure, router } from "../init";
import { coordinateString, repositoryName } from "../helpers";

/** `has_dependents` details as the routers send them: dependents with `group:name:version` coordinates. */
export interface HasDependentsDetails {
  dependents: { repository: string; coordinate: string }[];
  hiddenDependents: number;
}

/** Rewrites the coordinates in a `has_dependents` error to strings; other errors pass through. */
function withStringCoordinates(error: unknown): unknown {
  if (!(error instanceof RegistryError) || error.code !== "has_dependents") return error;
  const details = error.details as { dependents: Dependent[]; hiddenDependents: number };
  const converted: HasDependentsDetails = {
    dependents: details.dependents.map((d) => ({ repository: d.repository, coordinate: formatCoordinate(d.coordinate) })),
    hiddenDependents: details.hiddenDependents,
  };
  return new RegistryError("has_dependents", error.message, converted);
}

/** Version management (maintainers and admins). */
export const versionsRouter = router({
  /**
   * Deletes a version with all its builds. Blocked by dependents with `CONFLICT` (registry code
   * `has_dependents`, details {@link HasDependentsDetails}) unless an admin passes `force`.
   */
  delete: maintainerProcedure
    .input(z.object({ repository: repositoryName, coordinate: coordinateString, force: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = parseCoordinate(input.coordinate);
      try {
        await ctx.registry.deleteVersion(ctx.principal, input.repository, c, { force: input.force });
      } catch (error) {
        throw withStringCoordinates(error);
      }
      return { repository: input.repository, coordinate: formatCoordinate(c) };
    }),
});

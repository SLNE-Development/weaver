import { z } from "zod";
import type { Kind } from "@weaver/core";
import { getManifestDetail, listImageTags, listImages, type ImageSummary, type ManifestDetail, type TagRow } from "@weaver/docker/browse";
import { browseProcedure, router } from "../init";
import { canBrowseRepository, repositoryName, requireBrowsableRepository } from "../helpers";

/** Images per page of `docker.images`. */
export const DOCKER_IMAGES_PAGE = 50;

/** An image name below a repository (`library/nginx`, `web`), as docker accepts it. */
const imageName = z
  .string()
  .max(255)
  .regex(/^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/, "Invalid image name");

/** A `sha256:` or `sha512:` manifest digest. */
const digest = z.string().regex(/^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/, "Invalid digest");

/**
 * Read-only browsing of docker repositories. Images, tags and manifests are listed from what Weaver stores
 * (hosted pushes); groups list only their browsable members and mirrors expose whether caching is on, never
 * their upstreams, credentials or rules.
 */
export const dockerRouter = router({
  /** Kind, the members of a group the caller may browse (in order), and whether a mirror caches. */
  overview: browseProcedure
    .input(z.object({ repo: repositoryName }))
    .query(async ({ ctx, input }): Promise<{ kind: Kind; members: string[]; cacheEnabled: boolean | null }> => {
      const row = await requireBrowsableRepository(ctx.db, ctx.principal, input.repo, { format: "docker" });
      const members = row.kind === "group" ? (await ctx.repos.members(row.id)).filter((m) => canBrowseRepository(ctx.principal, m)).map((m) => m.name) : [];
      const cache = (row.config as { cache?: { enabled?: boolean } }).cache;
      return { kind: row.kind, members, cacheEnabled: row.kind === "mirror" ? cache?.enabled === true : null };
    }),

  /** The stored images of the repository by name, 50 per page after `cursor`; a group shows none (browse its members). */
  images: browseProcedure
    .input(z.object({ repo: repositoryName, query: z.string().trim().max(255).optional(), cursor: imageName.optional() }))
    .query(async ({ ctx, input }): Promise<{ items: ImageSummary[]; next: string | null }> => {
      const row = await requireBrowsableRepository(ctx.db, ctx.principal, input.repo, { format: "docker" });
      if (row.kind === "group") return { items: [], next: null };
      return listImages(ctx.db, row.id, { query: input.query || undefined, cursor: input.cursor, limit: DOCKER_IMAGES_PAGE });
    }),

  /** The tags of one image, most recently moved first. */
  tags: browseProcedure.input(z.object({ repo: repositoryName, image: imageName })).query(async ({ ctx, input }): Promise<TagRow[]> => {
    const row = await requireBrowsableRepository(ctx.db, ctx.principal, input.repo, { format: "docker" });
    return listImageTags(ctx.db, row.id, input.image);
  }),

  /** One manifest of an image with its layers or children, referrers and tags; null when it is not stored. */
  manifest: browseProcedure
    .input(z.object({ repo: repositoryName, image: imageName, digest }))
    .query(async ({ ctx, input }): Promise<ManifestDetail | null> => {
      const row = await requireBrowsableRepository(ctx.db, ctx.principal, input.repo, { format: "docker" });
      return getManifestDetail(ctx.db, row.id, input.image, input.digest);
    }),
});

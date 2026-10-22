import { TRPCError } from "@trpc/server";
import { count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { FORMATS, KINDS, RegistryError, type Format, type Kind, type Repo, type RepoService, type UpstreamView } from "@weaver/core";
import { asset, cleanupPolicy, protoArtifact, protoBuild, protoVersion, type Db, type Tx } from "@weaver/db";
import { deleteBlocked } from "@/lib/repository-settings";
import { adminProcedure, router } from "../init";
import { repositoryName } from "../helpers";

/** A repository with how many stored files it holds and their total size, as the admin pages list it. */
export type RepositoryListItem = Repo & {
  /** Stored files: assets, plus the build archives of a proto repository. */
  assetCount: number;
  storageBytes: number;
};

/** One repository as its settings page shows it. */
export type RepositoryDetails = RepositoryListItem & {
  /** Cleanup policies; only proto repositories have them. */
  policyCount: number;
  /** Proto artifacts (group:name); 0 for other formats. */
  artifactCount: number;
};

const formatInput = z.enum(FORMATS as [Format, ...Format[]]);

const upstreamInput = z.object({
  url: z.string().trim().min(1).max(2000),
  authType: z.enum(["none", "basic", "bearer"]),
  username: z.string().trim().max(200).nullable().optional(),
  /** Omitted keeps the stored secret (same URL, auth type and username); null or "" clears it. */
  secret: z.string().max(4000).nullable().optional(),
});

/** Everything but name, format and kind; the service validates `config` for the repository's format and kind. */
const settingsFields = {
  description: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  upstreams: z.array(upstreamInput).min(1).max(20).optional(),
  members: z.array(repositoryName).max(100).optional(),
  dockerRoot: z.boolean().optional(),
};

const createInput = z.object({
  name: repositoryName,
  format: formatInput,
  kind: z.enum(KINDS as [Kind, ...Kind[]]),
  ...settingsFields,
});

const updateInput = z.object({ name: repositoryName, patch: z.object(settingsFields) });

/** Stored file counts and bytes per repository id: assets, and proto build archives. */
async function storageByRepository(db: Db, ids: string[]): Promise<Map<string, { assetCount: number; storageBytes: number }>> {
  const out = new Map<string, { assetCount: number; storageBytes: number }>();
  if (ids.length === 0) return out;
  const [assets, builds] = await Promise.all([
    db
      .select({ repositoryId: asset.repositoryId, files: count(), bytes: sql<string>`coalesce(sum(${asset.size}), 0)` })
      .from(asset)
      .where(inArray(asset.repositoryId, ids))
      .groupBy(asset.repositoryId),
    db
      .select({
        repositoryId: protoArtifact.repositoryId,
        files: count(),
        bytes: sql<string>`coalesce(sum(${protoBuild.sizeBytes}), 0)`,
      })
      .from(protoBuild)
      .innerJoin(protoVersion, eq(protoVersion.id, protoBuild.versionId))
      .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
      .where(inArray(protoArtifact.repositoryId, ids))
      .groupBy(protoArtifact.repositoryId),
  ]);
  for (const row of [...assets, ...builds]) {
    const sum = out.get(row.repositoryId) ?? { assetCount: 0, storageBytes: 0 };
    sum.assetCount += row.files;
    sum.storageBytes += Number(row.bytes);
    out.set(row.repositoryId, sum);
  }
  return out;
}

async function withStorage(db: Db, repos: Repo[]): Promise<RepositoryListItem[]> {
  const storage = await storageByRepository(
    db,
    repos.map((r) => r.id),
  );
  return repos.map((repo) => ({ ...repo, ...(storage.get(repo.id) ?? { assetCount: 0, storageBytes: 0 }) }));
}

/** How many proto artifacts the repository holds. */
async function protoArtifactCount(db: Db | Tx, repositoryId: string): Promise<number> {
  const [row] = await db.select({ count: count() }).from(protoArtifact).where(eq(protoArtifact.repositoryId, repositoryId));
  return row?.count ?? 0;
}

/** Whether the service refused a name that is already taken. */
function isNameTaken(error: unknown): boolean {
  const details = error instanceof RegistryError ? (error.details as { field?: unknown; reason?: unknown } | undefined) : undefined;
  return details?.field === "name" && details.reason === "taken";
}

function notFound(name: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: `Repository ${name} was not found` });
}

/** The repository named `name`; `NOT_FOUND` when missing, `BAD_REQUEST` when it is not a `kind`. */
async function requireKind(repos: RepoService, name: string, kind: Kind): Promise<Repo> {
  const repo = await repos.get(name);
  if (!repo) throw notFound(name);
  if (repo.kind !== kind) throw new TRPCError({ code: "BAD_REQUEST", message: `Repository ${name} is not a ${kind}` });
  return repo;
}

/** Repository management (admin), delegated to the repository service, which validates and audits every change. */
export const repositoriesRouter = router({
  /** Every repository by name, with its stored file count and size. */
  list: adminProcedure.query(async ({ ctx }): Promise<RepositoryListItem[]> => withStorage(ctx.db, await ctx.repos.list())),

  /** One repository with its storage numbers and cleanup policy count; `NOT_FOUND` when missing. */
  get: adminProcedure.input(z.object({ name: repositoryName })).query(async ({ ctx, input }): Promise<RepositoryDetails> => {
    const repo = await ctx.repos.get(input.name);
    if (!repo) throw notFound(input.name);
    const [[details], [policies], artifacts] = await Promise.all([
      withStorage(ctx.db, [repo]),
      ctx.db.select({ count: count() }).from(cleanupPolicy).where(eq(cleanupPolicy.repositoryId, repo.id)),
      protoArtifactCount(ctx.db, repo.id),
    ]);
    return { ...details!, policyCount: policies?.count ?? 0, artifactCount: artifacts };
  }),

  /**
   * Creates a repository. Only name, format and kind are required (a mirror also needs an
   * upstream); everything else gets its default. `CONFLICT` when the name is taken.
   */
  create: adminProcedure.input(createInput).mutation(async ({ ctx, input }): Promise<Repo> => {
    try {
      return await ctx.repos.create(ctx.principal, input);
    } catch (error) {
      // No `cause`: the domain-error middleware would map the RegistryError back to BAD_REQUEST.
      if (isNameTaken(error)) throw new TRPCError({ code: "CONFLICT", message: `Repository ${input.name} already exists` });
      throw error;
    }
  }),

  /** Applies `patch`: omitted fields are kept, `config` is deep-merged, `upstreams` and `members` replace the lists. */
  update: adminProcedure
    .input(updateInput)
    .mutation(({ ctx, input }): Promise<Repo> => ctx.repos.update(ctx.principal, input.name, input.patch)),

  /**
   * Deletes a repository with all its content. A proto hosted repository is refused with
   * `PRECONDITION_FAILED` while it still holds artifacts (other repositories may depend on them;
   * {@link deleteBlocked}); the check runs with the repository row locked, so nothing can be
   * published in between.
   */
  delete: adminProcedure.input(z.object({ name: repositoryName })).mutation(async ({ ctx, input }) => {
    await ctx.repos.delete(ctx.principal, input.name, {
      guard: async (tx, repo) => {
        if (!deleteBlocked(repo, 1)) return;
        if (deleteBlocked(repo, await protoArtifactCount(tx, repo.id))) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Repository ${input.name} still contains artifacts; delete them first`,
          });
        }
      },
    });
    return { name: input.name };
  }),

  /** The upstreams of a mirror in order, secrets only as `hasSecret`; `BAD_REQUEST` for other kinds. */
  upstreams: adminProcedure.input(z.object({ name: repositoryName })).query(async ({ ctx, input }): Promise<UpstreamView[]> => {
    const repo = await requireKind(ctx.repos, input.name, "mirror");
    return ctx.repos.upstreams(repo.id);
  }),

  /** The members of a group in order; `BAD_REQUEST` for other kinds. */
  members: adminProcedure.input(z.object({ name: repositoryName })).query(async ({ ctx, input }): Promise<Repo[]> => {
    const repo = await requireKind(ctx.repos, input.name, "group");
    return ctx.repos.members(repo.id);
  }),

  /** The hosted and mirror repositories of `format` by name: what a group of that format can contain. */
  candidates: adminProcedure
    .input(z.object({ format: formatInput }))
    .query(async ({ ctx, input }): Promise<Repo[]> =>
      (await ctx.repos.list()).filter((repo) => repo.format === input.format && repo.kind !== "group"),
    ),
});

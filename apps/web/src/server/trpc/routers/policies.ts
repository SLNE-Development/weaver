import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  CLEANUP_KINDS,
  CLEANUP_KINDS_BY_FORMAT,
  createAssetService,
  kindUsesPattern,
  recordAudit,
  runRepoCleanup,
  type CleanupKind,
} from "@weaver/core";
import { cleanupPolicy, type Db, type Tx } from "@weaver/db";
import { enqueueCleanup, getJobState, type CleanupJobStatus } from "@weaver/jobs";
import { isValidScopePrefix, kindUsesIncludeReleases, isValidTagPattern, POLICY_TEXT_MAX, POLICY_VALUE_MAX } from "@/lib/cleanup-policies";
import { cleanupRegistry } from "../../cleanups";
import { adminProcedure, router, type TrpcContext } from "../init";
import { audited, notFound, repositoryName, requireRepository, type RepositoryRow } from "../helpers";

/** A cleanup rule of a repository. */
export interface CleanupPolicy {
  id: string;
  kind: CleanupKind;
  /** N builds to keep, or X days, depending on `kind`. */
  value: number;
  includeReleases: boolean;
  /** Scope in the format's terms: proto group, Maven groupId, npm package or docker image prefix. */
  groupPrefix: string | null;
  /** Tag glob of a keep_last_tags policy; null for every other kind. */
  pattern: string | null;
  enabled: boolean;
  createdAt: Date;
}

/** What a cleanup run would delete: `key` is stable per item, `label` names it for display. */
export interface CleanupPreviewItem {
  repository: string;
  key: string;
  label: string;
  reason: string;
}

const policyColumns = {
  id: cleanupPolicy.id,
  kind: cleanupPolicy.kind,
  value: cleanupPolicy.value,
  includeReleases: cleanupPolicy.includeReleases,
  groupPrefix: cleanupPolicy.groupPrefix,
  pattern: cleanupPolicy.pattern,
  enabled: cleanupPolicy.enabled,
  createdAt: cleanupPolicy.createdAt,
};

/**
 * Without `id` it creates a policy: `kind` and `value` are required, and the rest default to
 * `includeReleases: false`, `groupPrefix: null`, `pattern: null`, `enabled: true`. With `id` it is
 * a partial update: omitted fields keep their stored values. The resulting policy is checked
 * against the repository's format by {@link checkPolicy}.
 */
const policyInput = z.object({
  repository: repositoryName,
  /** Present to update an existing policy of the repository; omitted to create one. */
  id: z.uuid().optional(),
  kind: z.enum(CLEANUP_KINDS).optional(),
  value: z.number().int().min(1).max(POLICY_VALUE_MAX).optional(),
  includeReleases: z.boolean().optional(),
  groupPrefix: z.string().max(POLICY_TEXT_MAX).nullable().optional(),
  pattern: z.string().max(POLICY_TEXT_MAX).nullable().optional(),
  enabled: z.boolean().optional(),
});

/** Refusal for cleanup policies on mirror and group repositories. */
const HOSTED_ONLY_MESSAGE = "Cleanup policies apply to hosted repositories; mirror caches are governed by eviction settings";

const badRequest = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

/** A hosted repository by name; `NOT_FOUND` when missing, `BAD_REQUEST` for mirrors and groups. */
async function requireHosted(db: Db | Tx, name: string): Promise<RepositoryRow> {
  const repo = await requireRepository(db, name);
  if (repo.kind !== "hosted") throw badRequest(HOSTED_ONLY_MESSAGE);
  return repo;
}

/**
 * Throws `BAD_REQUEST` unless `policy` fits a repository of `repo.format`: a kind of the format, a
 * scope prefix valid for it, a pattern exactly when the kind uses one, and `includeReleases` only
 * on `delete_not_downloaded` of a format with releases (proto and maven).
 */
function checkPolicy(
  repo: RepositoryRow,
  policy: { kind: CleanupKind; includeReleases: boolean; groupPrefix: string | null; pattern: string | null },
): void {
  const { format } = repo;
  if (!CLEANUP_KINDS_BY_FORMAT[format].includes(policy.kind)) {
    throw badRequest(`${policy.kind} is not a cleanup kind for ${format} repositories`);
  }
  if (policy.groupPrefix !== null && !isValidScopePrefix(format, policy.groupPrefix)) {
    throw badRequest(`Invalid ${format === "proto" ? "group" : "scope"} prefix ${JSON.stringify(policy.groupPrefix)}`);
  }
  if (kindUsesPattern(policy.kind)) {
    if (policy.pattern === null) throw badRequest(`A ${policy.kind} policy needs a tag pattern`);
    if (!isValidTagPattern(policy.pattern)) throw badRequest(`Invalid tag pattern ${JSON.stringify(policy.pattern)}`);
  } else if (policy.pattern !== null) {
    throw badRequest(`A ${policy.kind} policy takes no pattern`);
  }
  if (policy.includeReleases && !kindUsesIncludeReleases(format, policy.kind)) {
    throw badRequest(`includeReleases does not apply to ${policy.kind} on ${format} repositories`);
  }
}

function requireQueue(ctx: TrpcContext) {
  const queue = ctx.cleanupQueue();
  if (!queue) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Background jobs are not configured (VALKEY_URL is unset)" });
  }
  return queue;
}

/** Cleanup policies per repository (admin): edit, preview (dry run) and run now as a background job. */
export const policiesRouter = router({
  list: adminProcedure.input(z.object({ repository: repositoryName })).query(async ({ ctx, input }): Promise<CleanupPolicy[]> => {
    const repo = await requireHosted(ctx.db, input.repository);
    return ctx.db
      .select(policyColumns)
      .from(cleanupPolicy)
      .where(eq(cleanupPolicy.repositoryId, repo.id))
      .orderBy(asc(cleanupPolicy.createdAt), asc(cleanupPolicy.id));
  }),

  /** The cleanup kinds a policy of the hosted repository can have, in the order the admin UI offers them. */
  kinds: adminProcedure
    .input(z.object({ repository: repositoryName }))
    .query(async ({ ctx, input }): Promise<CleanupKind[]> => [...CLEANUP_KINDS_BY_FORMAT[(await requireHosted(ctx.db, input.repository)).format]]),

  /**
   * Creates a policy, or updates the one with `id`; `NOT_FOUND` when `id` is not a policy of the
   * repository, `BAD_REQUEST` when the resulting policy does not fit the repository's format.
   */
  upsert: adminProcedure.input(policyInput).mutation(async ({ ctx, input }): Promise<CleanupPolicy> => {
    const { repository: repoName, id, ...given } = input;
    // Only the fields the caller sent; on update the others keep their stored values.
    const fields = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) as typeof given;
    return audited(
      ctx.db,
      (policy: CleanupPolicy) => ({
        actor: ctx.principal,
        action: id ? "policy.update" : "policy.create",
        target: `${repoName}/${policy.id}`,
        details: fields,
      }),
      async (tx) => {
        const repo = await requireHosted(tx, repoName);
        if (!id) {
          const { kind, value } = fields;
          if (kind === undefined || value === undefined) {
            throw badRequest("A new cleanup policy needs a kind and a value");
          }
          checkPolicy(repo, {
            kind,
            includeReleases: fields.includeReleases ?? false,
            groupPrefix: fields.groupPrefix ?? null,
            pattern: fields.pattern ?? null,
          });
          return (
            await tx
              .insert(cleanupPolicy)
              .values({ ...fields, kind, value, repositoryId: repo.id })
              .returning(policyColumns)
          )[0]!;
        }
        const matches = and(eq(cleanupPolicy.id, id), eq(cleanupPolicy.repositoryId, repo.id));
        const [stored] = await tx.select(policyColumns).from(cleanupPolicy).where(matches).for("update");
        if (!stored) throw notFound(`Cleanup policy ${id} was not found in ${repoName}`);
        if (Object.keys(fields).length === 0) return stored;
        checkPolicy(repo, { ...stored, ...fields });
        return (await tx.update(cleanupPolicy).set(fields).where(matches).returning(policyColumns))[0]!;
      },
    );
  }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await audited(ctx.db, { actor: ctx.principal, action: "policy.delete", target: input.id }, async (tx) => {
      const removed = await tx.delete(cleanupPolicy).where(eq(cleanupPolicy.id, input.id)).returning({ id: cleanupPolicy.id });
      if (removed.length === 0) throw notFound(`Cleanup policy ${input.id} was not found`);
    });
    return { id: input.id };
  }),

  /** What the repository's enabled policies would delete right now (dry run; deletes nothing). */
  preview: adminProcedure
    .input(z.object({ repository: repositoryName }))
    .query(async ({ ctx, input }): Promise<CleanupPreviewItem[]> => {
      await requireHosted(ctx.db, input.repository);
      const deps = { db: ctx.db, stores: ctx.stores, repos: ctx.repos, assets: createAssetService({ db: ctx.db, stores: ctx.stores }) };
      return runRepoCleanup(deps, cleanupRegistry(), input.repository, new Date(), { dryRun: true });
    }),

  /**
   * Enqueues a `cleanup:repo` job for the repository and returns its id; poll `policies.job`.
   * `SERVICE_UNAVAILABLE` within a few seconds when Valkey is down.
   */
  runNow: adminProcedure.input(z.object({ repository: repositoryName })).mutation(async ({ ctx, input }) => {
    await requireHosted(ctx.db, input.repository);
    const jobId = await enqueueCleanup(requireQueue(ctx), input.repository);
    await ctx.db.transaction((tx) =>
      recordAudit(tx, { actor: ctx.principal, action: "policy.runNow", target: input.repository, details: { jobId } }),
    );
    return { jobId };
  }),

  /** State of a cleanup job, with its result once completed or the failure reason once failed. */
  job: adminProcedure
    .input(z.object({ jobId: z.string().min(1).max(200) }))
    .query(({ ctx, input }): Promise<CleanupJobStatus> => getJobState(requireQueue(ctx), input.jobId)),
});

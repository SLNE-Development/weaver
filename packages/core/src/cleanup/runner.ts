import { and, asc, eq } from "drizzle-orm";
import { cleanupPolicy, repository } from "@weaver/db";
import { recordAudit } from "../audit.js";
import { RegistryError } from "../errors.js";
import type { CleanupCandidate, CleanupDeps, CleanupRegistry } from "./types.js";

/** Advisory lock key held by {@link runAllCleanups} so overlapping runs skip instead of racing. */
const CLEANUP_LOCK_KEY = 727001;

/**
 * Runs the cleanup policies of one repository through its format's {@link FormatCleanup}, passing
 * the enabled policies in createdAt order. Throws `not_found` for an unknown repository; returns []
 * for mirror and group repositories, repositories without enabled policies, and formats missing
 * from `registry`. With `dryRun` it only plans; otherwise it deletes and, when something was
 * deleted, records a `cleanup.run` audit entry by the system. Returns the planned or deleted candidates.
 */
export async function runRepoCleanup(
  deps: CleanupDeps,
  registry: CleanupRegistry,
  repoName: string,
  now: Date,
  opts: { dryRun: boolean },
): Promise<CleanupCandidate[]> {
  const repo = await deps.repos.get(repoName);
  if (!repo) throw new RegistryError("not_found", `Repository ${repoName} was not found`);
  // Mirror caches are governed by eviction settings, and groups store nothing of their own.
  if (repo.kind !== "hosted") return [];
  const cleanup = registry[repo.format];
  if (!cleanup) return [];

  const policies = await deps.db
    .select()
    .from(cleanupPolicy)
    .where(and(eq(cleanupPolicy.repositoryId, repo.id), eq(cleanupPolicy.enabled, true)))
    .orderBy(asc(cleanupPolicy.createdAt), asc(cleanupPolicy.id));
  if (policies.length === 0) return [];

  const candidates = await cleanup.run(deps, repo, policies, now, { dryRun: opts.dryRun });
  if (!opts.dryRun && candidates.length > 0) {
    await deps.db.transaction((tx) =>
      recordAudit(tx, {
        actor: "system",
        action: "cleanup.run",
        target: repo.name,
        details: { format: repo.format, deleted: candidates.length },
      }),
    );
  }
  return candidates;
}

/**
 * Runs the cleanup of every hosted repository that has an enabled policy and returns the number of
 * deletions. Holds the session advisory lock {@link CLEANUP_LOCK_KEY} for the run and returns 0 at
 * once when another run holds it. A failing repository does not stop the others; its error is
 * rethrown (aggregated) after the rest ran.
 */
export async function runAllCleanups(deps: CleanupDeps, registry: CleanupRegistry, now: Date): Promise<number> {
  const { db } = deps;
  const lockClient = await db.$client.connect();
  // Set when unlocking fails: releasing with it destroys the connection, which drops the session lock.
  let unlockError: Error | undefined;
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [
      CLEANUP_LOCK_KEY,
    ]);
    if (!rows[0]?.locked) return 0;
    try {
      const repos = await db
        .selectDistinct({ name: repository.name })
        .from(repository)
        .innerJoin(cleanupPolicy, eq(cleanupPolicy.repositoryId, repository.id))
        .where(and(eq(cleanupPolicy.enabled, true), eq(repository.kind, "hosted")))
        .orderBy(asc(repository.name));
      let deleted = 0;
      const errors: unknown[] = [];
      for (const { name } of repos) {
        try {
          deleted += (await runRepoCleanup(deps, registry, name, now, { dryRun: false })).length;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, `Cleanup failed for ${errors.length} repositories`);
      return deleted;
    } finally {
      try {
        await lockClient.query("select pg_advisory_unlock($1)", [CLEANUP_LOCK_KEY]);
      } catch (error) {
        unlockError = error instanceof Error ? error : new Error(String(error));
        console.warn("weaver: releasing the cleanup lock failed; discarding its connection", unlockError);
      }
    }
  } finally {
    lockClient.release(unlockError);
  }
}

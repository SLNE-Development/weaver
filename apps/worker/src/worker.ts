import { UnrecoverableError, Worker, type ConnectionOptions } from "bullmq";
import {
  createAssetService,
  createRepoService,
  dockerStorageBytes,
  evictCaches,
  RegistryError,
  rollupUsage,
  runAllCleanups,
  runRepoCleanup,
  toRepo,
  type CleanupDeps,
  type StoreSet,
} from "@weaver/core";
import { repository, type Db } from "@weaver/db";
import { runDockerGc } from "@weaver/docker/gc";
import { sweepLoginSessions } from "@weaver/npm";
import {
  createQueue,
  MAINTENANCE_QUEUE,
  scheduleDailyCleanup,
  scheduleHourlyEviction,
  scheduleHourlyStatsRollup,
  scheduleNpmLoginSweep,
  scheduleRepeating,
  type MaintenanceJobData,
  type MaintenanceQueue,
} from "@weaver/jobs";
import { cleanupRegistry } from "./cleanups.js";

/** Id of the job scheduler that garbage-collects docker blobs and uploads once a day. */
export const DOCKER_GC_SCHEDULER_ID = "docker-gc-daily";

/** Cron pattern of the docker garbage collection: daily at 03:30, after the cleanup policies ran. */
export const DOCKER_GC_PATTERN = "30 3 * * *";

/** Creates or updates the daily docker garbage collection scheduler; calling it again never adds a second one. */
export function scheduleDockerGc(queue: MaintenanceQueue): Promise<void> {
  return scheduleRepeating(queue, DOCKER_GC_SCHEDULER_ID, DOCKER_GC_PATTERN, { kind: "docker:gc" });
}

/** What the worker needs: the database, the object stores, the upstream-credential key and the Valkey connection. */
export interface WorkerDeps {
  db: Db;
  stores: StoreSet;
  /** AES key for upstream credentials, derived from `BETTER_AUTH_SECRET`. */
  secretKey: Buffer;
  connection: ConnectionOptions;
}

/** The services a cleanup run works with, built from the worker dependencies. */
function cleanupDeps(deps: WorkerDeps): CleanupDeps {
  return {
    db: deps.db,
    stores: deps.stores,
    assets: createAssetService({ db: deps.db, stores: deps.stores }),
    repos: createRepoService({ db: deps.db, stores: deps.stores, secretKey: deps.secretKey }),
  };
}

/** A started worker; `close` waits for the running job, then disconnects. */
export interface RunningWorker {
  worker: Worker<MaintenanceJobData, unknown>;
  close(): Promise<void>;
}

/**
 * Runs one maintenance job, dispatching on `data.kind`. An unknown repository can never succeed, so
 * it fails the job at once instead of spending its retries.
 */
export async function processMaintenanceJob(deps: WorkerDeps, data: MaintenanceJobData): Promise<unknown> {
  const now = new Date();
  switch (data.kind) {
    case "cleanup:all":
      return { deleted: await runAllCleanups(cleanupDeps(deps), cleanupRegistry(), now) };
    case "cleanup:repo":
      try {
        const deleted = await runRepoCleanup(cleanupDeps(deps), cleanupRegistry(), data.repository, now, { dryRun: false });
        return { deleted: deleted.length };
      } catch (error) {
        if (error instanceof RegistryError && error.code === "not_found") throw new UnrecoverableError(error.message);
        throw error;
      }
    case "evict:all":
      return evictCaches({ db: deps.db, assets: createAssetService({ db: deps.db, stores: deps.stores }), now });
    case "docker:gc":
      return runDockerGc({ db: deps.db, stores: deps.stores, now });
    case "npm:login-sweep":
      return sweepLoginSessions(deps.db, now);
    case "stats:rollup":
      return rollupUsage(
        {
          db: deps.db,
          repos: { list: async () => (await deps.db.select().from(repository).orderBy(repository.name)).map(toRepo) },
          storageProbes: { docker: dockerStorageBytes(deps.db) },
        },
        now,
      );
    default:
      throw new UnrecoverableError(`Unknown maintenance job kind ${JSON.stringify((data as { kind?: unknown }).kind)}`);
  }
}

/**
 * Upserts the `cleanup-daily`, `evict-hourly`, `npm-login-sweep`, `stats-hourly` and `docker-gc-daily` schedulers (idempotent) and starts a worker that
 * processes maintenance jobs one at a time.
 */
export async function startWorker(deps: WorkerDeps): Promise<RunningWorker> {
  const queue = createQueue(deps.connection);
  try {
    await scheduleDailyCleanup(queue);
    await scheduleHourlyEviction(queue);
    await scheduleNpmLoginSweep(queue);
    await scheduleHourlyStatsRollup(queue);
    await scheduleDockerGc(queue);
  } finally {
    await queue.close();
  }
  const worker = new Worker<MaintenanceJobData, unknown>(MAINTENANCE_QUEUE, (job) => processMaintenanceJob(deps, job.data), {
    connection: deps.connection,
    concurrency: 1,
  });
  worker.on("failed", (job, error) => {
    console.error(`weaver-worker: job ${job?.id ?? "?"} (${job?.name ?? "?"}) failed`, error);
  });
  worker.on("error", (error) => {
    console.error("weaver-worker: worker error", error);
  });
  await worker.waitUntilReady();
  return { worker, close: () => worker.close() };
}

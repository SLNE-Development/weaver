import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValkeyContainer, type StartedValkeyContainer } from "@testcontainers/valkey";
import {
  MAINTENANCE_QUEUE,
  createQueue,
  enqueueCleanup,
  getJobState,
  manualCleanupJobId,
  redisConnection,
  scheduleDailyCleanup,
  scheduleHourlyEviction,
  scheduleNpmLoginSweep,
  scheduleHourlyStatsRollup,
  scheduleRepeating,
  STATS_ROLLUP_PATTERN,
  STATS_SCHEDULER_ID,
  type CleanupQueue,
} from "./index.js";

describe("jobs", () => {
  let valkey: StartedValkeyContainer;
  let queue: CleanupQueue;

  beforeAll(async () => {
    valkey = await new ValkeyContainer("valkey/valkey:9.1.2-alpine").start();
    queue = createQueue(redisConnection(valkey.getConnectionUrl()));
  });

  afterAll(async () => {
    await queue?.close();
    await valkey?.stop();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it("uses the weaver-maintenance queue", () => {
    expect(queue.name).toBe(MAINTENANCE_QUEUE);
    expect(MAINTENANCE_QUEUE).toBe("weaver-maintenance");
  });

  it("enqueues a repository cleanup that waits for a worker", async () => {
    const jobId = await enqueueCleanup(queue, "releases");
    expect(jobId).toEqual(expect.any(String));

    expect(await getJobState(queue, jobId)).toEqual({ state: "waiting", result: null, failedReason: null });
    const job = await queue.getJob(jobId);
    expect(job?.data).toEqual({ kind: "cleanup:repo", repository: "releases" });
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toMatchObject({ type: "exponential" });
  });

  it("maps repeated manual runs within one minute to a single job", async () => {
    const now = new Date("2026-10-21T12:00:10Z");
    const first = await enqueueCleanup(queue, "releases", { now });
    const retry = await enqueueCleanup(queue, "releases", { now: new Date("2026-10-21T12:00:50Z") });
    expect(retry).toBe(first);
    expect(first).toBe(manualCleanupJobId("releases", now));
    expect(first).not.toContain(":");
    expect(await queue.getJobCounts("waiting")).toEqual({ waiting: 1 });

    const other = await enqueueCleanup(queue, "snapshots", { now });
    const later = await enqueueCleanup(queue, "releases", { now: new Date("2026-10-21T12:01:00Z") });
    expect(new Set([first, other, later]).size).toBe(3);
  });

  it("reports unknown for a job id that does not exist", async () => {
    expect(await getJobState(queue, "missing")).toEqual({ state: "unknown", result: null, failedReason: null });
  });

  it("reads a finished job's result after its state, never from an earlier snapshot", async () => {
    let finished = false;
    const fake = {
      getJobState: async () => {
        finished = true;
        return "completed";
      },
      getJob: async () => ({ returnvalue: finished ? { deleted: 2 } : undefined, failedReason: undefined }),
    } as unknown as CleanupQueue;
    expect(await getJobState(fake, "j")).toEqual({ state: "completed", result: { deleted: 2 }, failedReason: null });
  });

  it("registers the daily scheduler once, however often it is upserted", async () => {
    await scheduleDailyCleanup(queue);
    await scheduleDailyCleanup(queue);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ key: "cleanup-daily", pattern: "0 3 * * *" });
    expect(schedulers[0]?.template?.data).toEqual({ kind: "cleanup:all" });
    expect(schedulers[0]?.template?.opts).toMatchObject({ attempts: 3, backoff: { type: "exponential" } });
  });

  it("upserts an hourly eviction scheduler next to the daily cleanup", async () => {
    await scheduleDailyCleanup(queue);
    await scheduleHourlyEviction(queue);
    await scheduleHourlyEviction(queue);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key).sort()).toEqual(["cleanup-daily", "evict-hourly"]);
    const evict = schedulers.find((s) => s.key === "evict-hourly");
    expect(evict).toMatchObject({ pattern: "17 * * * *" });
    expect(evict?.template?.data).toEqual({ kind: "evict:all" });
  });

  it("upserts one npm login sweep scheduler every five minutes", async () => {
    await scheduleNpmLoginSweep(queue);
    await scheduleNpmLoginSweep(queue);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ key: "npm-login-sweep", pattern: "*/5 * * * *" });
    expect(schedulers[0]?.template?.data).toEqual({ kind: "npm:login-sweep" });
  });

  it("upserts an hourly stats rollup scheduler at minute 41", async () => {
    await scheduleHourlyStatsRollup(queue);
    await scheduleHourlyStatsRollup(queue);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ key: STATS_SCHEDULER_ID, pattern: STATS_ROLLUP_PATTERN });
    expect([STATS_SCHEDULER_ID, STATS_ROLLUP_PATTERN]).toEqual(["stats-hourly", "41 * * * *"]);
    expect(schedulers[0]?.template?.data).toEqual({ kind: "stats:rollup" });
  });

  it("scheduleRepeating updates the pattern of an existing scheduler id", async () => {
    await scheduleRepeating(queue, "custom", "0 1 * * *", { kind: "evict:all" });
    await scheduleRepeating(queue, "custom", "0 2 * * *", { kind: "evict:all" });

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ key: "custom", pattern: "0 2 * * *" });
  });
});

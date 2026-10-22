import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { dockerUpload, type Db } from "@weaver/db";
import { DOCKER_GC_GRACE_MS } from "./gc.js";

/** The shortest interval between two sweeps of one upload directory in one process. */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * How old a spool file without an upload row must be before it is swept; a new upload creates its file just
 * before inserting its row, and this keeps that window safe.
 */
const ORPHAN_MIN_AGE_MS = 5 * 60 * 1000;

/** Spool files are named after their upload id. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How many upload ids are looked up per query. */
const LOOKUP_BATCH = 1000;

/**
 * Deletes spool files in `uploadDir` that have no live upload row (and are older than a few minutes) or were
 * last written longer than {@link DOCKER_GC_GRACE_MS} before `now`; resolves to the number of files removed.
 * Only files named like an upload id are considered; a missing directory removes nothing.
 */
export async function sweepUploads(db: Db, uploadDir: string, now: Date): Promise<number> {
  let names: string[];
  try {
    const entries = await readdir(uploadDir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && UPLOAD_ID.test(e.name)).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  const live = new Set<string>();
  for (let i = 0; i < names.length; i += LOOKUP_BATCH) {
    const rows = await db
      .select({ id: dockerUpload.id })
      .from(dockerUpload)
      .where(inArray(dockerUpload.id, names.slice(i, i + LOOKUP_BATCH)));
    for (const r of rows) live.add(r.id);
  }

  let removed = 0;
  for (const name of names) {
    const path = join(uploadDir, name);
    let age: number;
    try {
      age = now.getTime() - (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (age > DOCKER_GC_GRACE_MS || (!live.has(name) && age > ORPHAN_MIN_AGE_MS)) {
      await rm(path, { force: true });
      removed++;
    }
  }
  return removed;
}

/** When each upload directory was last swept by this process, in epoch milliseconds. */
const lastSweep = new Map<string, number>();

/**
 * Runs {@link sweepUploads} for `uploadDir` when this process has not swept it within {@link SWEEP_INTERVAL_MS};
 * failures are logged, never thrown, so an upload never fails because of the sweep.
 */
export async function maybeSweepUploads(db: Db, uploadDir: string, now: Date = new Date()): Promise<void> {
  const last = lastSweep.get(uploadDir);
  if (last !== undefined && now.getTime() - last < SWEEP_INTERVAL_MS) return;
  lastSweep.set(uploadDir, now.getTime());
  try {
    await sweepUploads(db, uploadDir, now);
  } catch (err) {
    console.error("weaver: docker upload sweep failed", err);
  }
}

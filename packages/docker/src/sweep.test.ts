import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerUpload } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createRepoService, createStoreSetFromEnv, deriveSecretKey } from "@weaver/core";
import { DOCKER_GC_GRACE_MS } from "./gc.js";
import { sweepUploads } from "./sweep.js";

describe("upload spool sweep", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let dir: string;
  let repoId: string;

  beforeAll(async () => {
    testDb = await startTestDb();
    dir = await mkdtemp(join(tmpdir(), "weaver-sweep-"));
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: join(dir, "blobs") });
    const repos = createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("sweep") });
    const repo = await repos.create({ kind: "user", userId: "admin", role: "admin" }, { name: "hosted", format: "docker", kind: "hosted" });
    repoId = repo.id;
  });
  afterAll(async () => {
    await testDb?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("removes orphan spool files and keeps live ones", async () => {
    const uploads = join(dir, "uploads");
    await mkdir(uploads, { recursive: true });
    const live = randomUUID();
    const orphan = randomUUID();
    const staleLive = randomUUID();
    const freshOrphan = randomUUID();
    await testDb.db.insert(dockerUpload).values([
      { id: live, repositoryId: repoId, image: "app" },
      { id: staleLive, repositoryId: repoId, image: "app" },
    ]);
    for (const id of [live, orphan, staleLive, freshOrphan]) await writeFile(join(uploads, id), "bytes");
    const now = new Date();
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
    await utimes(join(uploads, orphan), minutesAgo(30), minutesAgo(30));
    const stale = new Date(now.getTime() - DOCKER_GC_GRACE_MS - 60_000);
    await utimes(join(uploads, staleLive), stale, stale);
    await utimes(join(uploads, live), minutesAgo(30), minutesAgo(30));

    expect(await sweepUploads(testDb.db, uploads, now)).toBe(2);

    // A spool file just created for an upload whose row is not inserted yet is left alone.
    expect((await readdir(uploads)).sort()).toEqual([freshOrphan, live].sort());
  });

  it("does nothing when the upload directory does not exist", async () => {
    expect(await sweepUploads(testDb.db, join(dir, "missing"), new Date())).toBe(0);
  });
});

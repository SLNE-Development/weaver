import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { asset, component, usageEvent } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { deriveSecretKey } from "../crypto.js";
import type { Principal } from "../permissions.js";
import { createRepoService, type Repo, type RepoService } from "../repos/index.js";
import { createStoreSetFromEnv, getBuffer, type StoreSet } from "../storage/index.js";
import { createAssetService, type AssetService } from "./assets.js";
import { recordUsage } from "./usage.js";

const admin: Principal = { kind: "user", userId: "admin-user", role: "admin" };
const keyPrincipal: Principal = { kind: "apikey", keyId: "key-1", userId: "user-1", role: "maintainer", permissions: [] };

/** Every file below `dir`, as paths relative to it. */
async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll("\\", "/"));
}

async function text(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

describe("asset service", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let stores: StoreSet;
  let repos: RepoService;
  let assets: AssetService;
  let repo: Repo;

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-assets-"));
    stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    repos = createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("assets-test") });
    assets = createAssetService({ db: testDb.db, stores });
  });

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, usage_event, audit_event CASCADE`);
    await rm(blobDir, { recursive: true, force: true });
    repo = await repos.create(admin, { name: "maven-hosted", format: "maven", kind: "hosted" });
  });

  it("puts an asset under a per-repo key with all digests and finds it by path", async () => {
    const row = await assets.put({ repo, path: "a/b/c.jar", body: Readable.from([Buffer.from("hello")]), contentType: "application/java-archive", origin: "hosted" });
    expect(row).toMatchObject({
      repositoryId: repo.id,
      path: "a/b/c.jar",
      store: "local",
      size: 5,
      contentType: "application/java-archive",
      md5: "5d41402abc4b2a76b9719d911017c592",
      sha1: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      origin: "hosted",
      componentId: null,
      expiresAt: null,
      lastAccessedAt: null,
    });
    expect(row.sha512).toHaveLength(128);
    expect(row.storageKey).toMatch(new RegExp(`^${repo.id}/hosted/[0-9a-f-]{36}$`));
    expect(await assets.find(repo.id, "a/b/c.jar")).toEqual(row);
    expect(await assets.find(repo.id, "a/b/missing.jar")).toBeNull();
    expect((await getBuffer(stores.primary, row.storageKey))!.toString()).toBe("hello");
  });

  it("replaces the row on a second put to the same path and deletes the previous object", async () => {
    const first = await assets.put({ repo, path: "x.txt", body: Readable.from([Buffer.from("one")]), origin: "cache" });
    const second = await assets.put({ repo, path: "x.txt", body: Readable.from([Buffer.from("two!")]), origin: "cache" });
    expect(second.id).toBe(first.id);
    expect(second.storageKey).not.toBe(first.storageKey);
    expect(second.size).toBe(4);
    expect(await filesIn(blobDir)).toEqual([second.storageKey]);
    expect(await testDb.db.select().from(asset)).toHaveLength(1);
  });

  it("writes nothing when the body length differs from contentLength", async () => {
    await expect(assets.put({ repo, path: "x.txt", body: Readable.from([Buffer.from("abc")]), origin: "hosted", contentLength: 10 })).rejects.toThrow();
    expect(await testDb.db.select().from(asset)).toHaveLength(0);
    expect(await filesIn(blobDir).catch(() => [])).toEqual([]);
  });

  it("lists assets under a prefix in path order, treating LIKE wildcards literally", async () => {
    for (const path of ["com/acme/b.pom", "com/acme/a.jar", "com/other/x.jar", "com/acme_x/y.jar"]) {
      await assets.put({ repo, path, body: Readable.from([Buffer.from(path)]), origin: "hosted" });
    }
    expect((await assets.list(repo.id, "com/acme/")).map((a) => a.path)).toEqual(["com/acme/a.jar", "com/acme/b.pom"]);
    expect((await assets.list(repo.id, "com/acme_")).map((a) => a.path)).toEqual(["com/acme_x/y.jar"]);
    expect(await assets.list(repo.id, "")).toHaveLength(4);
  });

  it("opens an asset, also as a range", async () => {
    const row = await assets.put({ repo, path: "r.bin", body: Readable.from([Buffer.from("0123456789")]), origin: "hosted" });
    const whole = await assets.open(row);
    expect(await text(whole!.body)).toBe("0123456789");
    const part = await assets.open(row, { start: 2, end: 4 });
    expect(part!.range).toEqual({ start: 2, end: 4 });
    expect(await text(part!.body)).toBe("234");
  });

  it("deletes the row and the object", async () => {
    const row = await assets.put({ repo, path: "d.bin", body: Readable.from([Buffer.from("x")]), origin: "hosted" });
    await assets.delete(row);
    expect(await assets.find(repo.id, "d.bin")).toBeNull();
    expect(await filesIn(blobDir)).toEqual([]);
  });

  it("stage writes only the object; discard deletes it", async () => {
    const staged = await assets.stage({ repo, body: Readable.from([Buffer.from("hello")]), origin: "hosted" });
    expect(staged).toMatchObject({ repositoryId: repo.id, origin: "hosted", store: "local", size: 5, sha1: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d" });
    expect(staged.storageKey).toMatch(new RegExp(`^${repo.id}/hosted/[0-9a-f-]{36}$`));
    expect(await filesIn(blobDir)).toEqual([staged.storageKey]);
    expect(await testDb.db.select().from(asset)).toHaveLength(0);
    await assets.discard(staged);
    expect(await filesIn(blobDir)).toEqual([]);
  });

  it("commit records the row and component in the caller's transaction and rolls back with it", async () => {
    const ref = { namespace: "acme", name: "ui", version: "1.0.0", metadata: { a: 1 } };
    const staged = await assets.stage({ repo, body: Readable.from([Buffer.from("abc")]), origin: "hosted" });
    await expect(
      testDb.db.transaction(async (tx) => {
        const done = await assets.commit(tx, staged, { path: "p.tgz", component: ref });
        expect(done.componentCreated).toBe(true);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await testDb.db.select().from(asset)).toHaveLength(0);
    expect(await testDb.db.select().from(component)).toHaveLength(0);

    const committed = await testDb.db.transaction((tx) => assets.commit(tx, staged, { path: "p.tgz", contentType: "application/octet-stream", component: ref }));
    await committed.finish();
    expect(committed.componentCreated).toBe(true);
    expect(committed.asset).toMatchObject({ path: "p.tgz", storageKey: staged.storageKey, size: 3, contentType: "application/octet-stream", origin: "hosted" });
    expect(await assets.find(repo.id, "p.tgz")).toEqual(committed.asset);

    const again = await assets.stage({ repo, body: Readable.from([Buffer.from("abcd")]), origin: "hosted" });
    const replaced = await testDb.db.transaction((tx) => assets.commit(tx, again, { path: "p.tgz", component: ref }));
    expect(replaced.componentCreated).toBe(false);
    expect(replaced.asset.componentId).toBe(committed.asset.componentId);
    expect((await filesIn(blobDir)).sort()).toEqual([staged.storageKey, again.storageKey].sort());
    await replaced.finish();
    expect(await filesIn(blobDir)).toEqual([again.storageKey]);
  });

  it("touch sets lastAccessedAt", async () => {
    const row = await assets.put({ repo, path: "t.bin", body: Readable.from([Buffer.from("x")]), origin: "cache" });
    await assets.touch(row.id);
    const touched = await assets.find(repo.id, "t.bin");
    expect(touched!.lastAccessedAt).toBeInstanceOf(Date);
    expect(Math.abs(touched!.lastAccessedAt!.getTime() - Date.now())).toBeLessThan(10_000);
  });

  it("upserts components by coordinate and links assets to them", async () => {
    const ref = { namespace: "com.acme", name: "money", version: "1.0.0", metadata: { packaging: "jar" } };
    const id = await assets.upsertComponent(repo.id, ref);
    expect(await assets.upsertComponent(repo.id, { namespace: "com.acme", name: "money", version: "1.0.0" })).toBe(id);
    const [row] = await testDb.db.select().from(component).where(eq(component.id, id));
    expect(row!.metadata).toEqual({ packaging: "jar" });

    const a = await assets.put({ repo, path: "m.jar", body: Readable.from([Buffer.from("x")]), origin: "hosted", component: ref });
    expect(a.componentId).toBe(id);
  });

  it("recordUsage increments asset and component counters", async () => {
    const ref = { namespace: "com.acme", name: "money", version: "1.0.0" };
    const a = await assets.put({ repo, path: "m.jar", body: Readable.from([Buffer.from("xyz")]), origin: "hosted", component: ref });
    const input = { repositoryId: repo.id, componentId: a.componentId, assetId: a.id, path: "m.jar", action: "download" as const, cache: "hit" as const, bytes: 3, principal: keyPrincipal };
    await recordUsage(testDb.db, input);
    await recordUsage(testDb.db, input);
    await recordUsage(testDb.db, { ...input, action: "upload", cache: undefined });

    const [assetRow] = await testDb.db.select().from(asset).where(eq(asset.id, a.id));
    expect(assetRow!.downloadCount).toBe(2);
    const [componentRow] = await testDb.db.select().from(component).where(eq(component.id, a.componentId!));
    expect(componentRow!.downloadCount).toBe(2);
    expect(componentRow!.lastDownloadedAt).toBeInstanceOf(Date);

    const events = await testDb.db.select().from(usageEvent).orderBy(usageEvent.id);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ repositoryId: repo.id, componentId: a.componentId, path: "m.jar", action: "download", cache: "hit", bytes: 3, userId: "user-1", apiKeyId: "key-1" });
    expect(events[2]).toMatchObject({ action: "upload", cache: null });
  });

  it("recordUsage takes the component from the asset and never throws", async () => {
    const a = await assets.put({ repo, path: "n.jar", body: Readable.from([Buffer.from("x")]), origin: "hosted", component: { namespace: "", name: "n", version: "1" } });
    await recordUsage(testDb.db, { repositoryId: repo.id, assetId: a.id, path: "n.jar", action: "download", principal: { kind: "anonymous" } });
    const [componentRow] = await testDb.db.select().from(component).where(eq(component.id, a.componentId!));
    expect(componentRow!.downloadCount).toBe(1);
    const [event] = await testDb.db.select().from(usageEvent);
    expect(event).toMatchObject({ componentId: a.componentId, userId: null, apiKeyId: null, bytes: 0 });

    // An unknown repository id violates the foreign key; recordUsage only logs.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      recordUsage(testDb.db, { repositoryId: "00000000-0000-4000-8000-0000000000ff", path: "x", action: "download", principal: admin }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

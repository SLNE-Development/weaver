import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  apikey,
  asset,
  auditEvent,
  groupMember,
  protoArtifact,
  protoBuild,
  protoVersion,
  repoPermission,
  repository,
  repositoryUpstream,
} from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { deriveSecretKey, decryptSecret } from "../crypto.js";
import { RegistryError } from "../errors.js";
import type { Principal } from "../permissions.js";
import { createStoreSetFromEnv, getBuffer, putBuffer, type StoreSet } from "../storage/index.js";
import { createRepoService, type CreateRepoInput, type RepoService } from "./service.js";

const admin: Principal = { kind: "user", userId: "admin-user", role: "admin" };
const maintainer: Principal = { kind: "user", userId: "maint-user", role: "maintainer" };
const adminKey: Principal = { kind: "apikey", keyId: "k-admin", userId: "admin-user", role: "admin", permissions: [] };
const anonymous: Principal = { kind: "anonymous" };

const secretKey = deriveSecretKey("repo-service-test-secret");
const upstream = (url = "https://repo1.maven.org/maven2") => ({ url, authType: "none" as const });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as RegistryError).code ?? `untyped: ${String(error)}`;
  }
  throw new Error("expected the call to fail, but it succeeded");
}

describe("repository service", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let stores: StoreSet;
  let repos: RepoService;

  const create = (input: CreateRepoInput, actor: Principal = admin) => repos.create(actor, input);

  async function audits(): Promise<Array<{ action: string; target: string; details: unknown }>> {
    return testDb.db
      .select({ action: auditEvent.action, target: auditEvent.target, details: auditEvent.details })
      .from(auditEvent)
      .orderBy(auditEvent.at);
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-repos-"));
    stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    repos = createRepoService({ db: testDb.db, stores, secretKey });
  });

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, audit_event, apikey CASCADE`);
  });

  it("creates repositories with default config and reads them back", async () => {
    const created = await create({ name: "releases", format: "maven", kind: "hosted" });
    expect(created).toMatchObject({
      name: "releases",
      format: "maven",
      kind: "hosted",
      description: null,
      visibility: "private",
      dockerRoot: false,
      config: { versionPolicy: "mixed", redeploy: false },
    });
    expect(await repos.get("releases")).toEqual(created);
    expect(await repos.getById(created.id)).toEqual(created);
    expect(await repos.get("ghost")).toBeNull();
    await create({ name: "alpha", format: "npm", kind: "hosted" });
    expect((await repos.list()).map((r) => r.name)).toEqual(["alpha", "releases"]);
  });

  it("create requires admin", async () => {
    expect(await codeOf(create({ name: "a", format: "npm", kind: "hosted" }, maintainer))).toBe("forbidden");
    expect(await codeOf(create({ name: "a", format: "npm", kind: "hosted" }, anonymous))).toBe("forbidden");
    expect(await codeOf(repos.update(maintainer, "a", {}))).toBe("forbidden");
    expect(await codeOf(repos.delete(maintainer, "a"))).toBe("forbidden");
    await create({ name: "a", format: "npm", kind: "hosted" }, adminKey);
    expect(await repos.get("a")).not.toBeNull();
  });

  it("rejects invalid names and config", async () => {
    expect(await codeOf(create({ name: "Bad Name", format: "npm", kind: "hosted" }))).toBe("invalid_request");
    expect(await codeOf(create({ name: "ok", format: "npm", kind: "hosted", config: { nope: 1 } }))).toBe("invalid_request");
  });

  it("names are unique across formats", async () => {
    await create({ name: "shared", format: "maven", kind: "hosted" });
    expect(await codeOf(create({ name: "shared", format: "npm", kind: "hosted" }))).toBe("invalid_request");
    expect(await codeOf(create({ name: "shared", format: "proto", kind: "hosted" }))).toBe("invalid_request");
  });

  it("group members must exist, be same format, and not be groups", async () => {
    await create({ name: "m-hosted", format: "maven", kind: "hosted" });
    await create({ name: "m-mirror", format: "maven", kind: "mirror", upstreams: [upstream()] });
    await create({ name: "n-hosted", format: "npm", kind: "hosted" });
    await create({ name: "m-group", format: "maven", kind: "group", members: ["m-hosted"] });

    expect(await codeOf(create({ name: "g1", format: "maven", kind: "group", members: ["ghost"] }))).toBe("invalid_request");
    expect(await codeOf(create({ name: "g2", format: "maven", kind: "group", members: ["n-hosted"] }))).toBe("invalid_request");
    expect(await codeOf(create({ name: "g3", format: "maven", kind: "group", members: ["m-group"] }))).toBe("invalid_request");
    expect(
      await codeOf(create({ name: "g4", format: "maven", kind: "group", members: ["m-hosted", "m-hosted"] })),
    ).toBe("invalid_request");
    expect(await codeOf(create({ name: "h1", format: "maven", kind: "hosted", members: ["m-hosted"] }))).toBe("invalid_request");

    const group = await create({ name: "public", format: "maven", kind: "group", members: ["m-mirror", "m-hosted"] });
    expect((await repos.members(group.id)).map((r) => r.name)).toEqual(["m-mirror", "m-hosted"]);
    await repos.update(admin, "public", { members: ["m-hosted", "m-mirror"] });
    expect((await repos.members(group.id)).map((r) => r.name)).toEqual(["m-hosted", "m-mirror"]);
    const hosted = (await repos.get("m-hosted"))!;
    expect((await repos.groupsContaining(hosted.id)).map((r) => r.name)).toEqual(["m-group", "public"]);
  });

  it("mirror requires at least one upstream with an http(s) url", async () => {
    expect(await codeOf(create({ name: "mi", format: "npm", kind: "mirror" }))).toBe("invalid_request");
    expect(await codeOf(create({ name: "mi", format: "npm", kind: "mirror", upstreams: [] }))).toBe("invalid_request");
    expect(await codeOf(create({ name: "mi", format: "npm", kind: "mirror", upstreams: [upstream("ftp://x.org/")] }))).toBe(
      "invalid_request",
    );
    expect(await codeOf(create({ name: "mi", format: "npm", kind: "mirror", upstreams: [upstream("not a url")] }))).toBe(
      "invalid_request",
    );
    expect(await codeOf(create({ name: "hz", format: "npm", kind: "hosted", upstreams: [upstream()] }))).toBe("invalid_request");
    const mirror = await create({
      name: "mi",
      format: "npm",
      kind: "mirror",
      upstreams: [upstream("https://registry.npmjs.org"), upstream("http://npm.internal/")],
    });
    expect((await repos.upstreams(mirror.id)).map((u) => u.url)).toEqual(["https://registry.npmjs.org", "http://npm.internal/"]);
    expect(await codeOf(repos.update(admin, "mi", { upstreams: [] }))).toBe("invalid_request");
  });

  const dockerMirror = (name: string, extra: Partial<CreateRepoInput> = {}) =>
    create({ name, format: "docker", kind: "mirror", upstreams: [upstream("https://registry-1.docker.io")], ...extra });

  it("only one docker root (second create fails with invalid_request)", async () => {
    await dockerMirror("hub", { dockerRoot: true });
    expect((await repos.dockerRoot())?.name).toBe("hub");
    expect(await codeOf(dockerMirror("quay", { dockerRoot: true }))).toBe("invalid_request");
    await dockerMirror("quay");
    expect(await codeOf(repos.update(admin, "quay", { dockerRoot: true }))).toBe("invalid_request");
    await repos.update(admin, "hub", { dockerRoot: false });
    await repos.update(admin, "quay", { dockerRoot: true });
    expect((await repos.dockerRoot())?.name).toBe("quay");
  });

  it("only a docker mirror can be the docker root", async () => {
    expect(await codeOf(create({ name: "local", format: "docker", kind: "hosted", dockerRoot: true }))).toBe("invalid_request");
    expect(await codeOf(create({ name: "dgroup", format: "docker", kind: "group", dockerRoot: true }))).toBe("invalid_request");
    expect(await codeOf(create({ name: "mvn", format: "maven", kind: "mirror", upstreams: [upstream()], dockerRoot: true }))).toBe(
      "invalid_request",
    );
    await create({ name: "local", format: "docker", kind: "hosted" });
    expect(await codeOf(repos.update(admin, "local", { dockerRoot: true }))).toBe("invalid_request");
    expect(await repos.dockerRoot()).toBeNull();
  });

  it("lets only one of two concurrent updates make a repository the docker root", async () => {
    await dockerMirror("one");
    await dockerMirror("two");
    const results = await Promise.allSettled([
      repos.update(admin, "one", { dockerRoot: true }),
      repos.update(admin, "two", { dockerRoot: true }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => (r.reason as RegistryError).code)).toEqual(["invalid_request"]);
    const roots = await testDb.db.select({ name: repository.name }).from(repository).where(eq(repository.dockerRoot, true));
    expect(roots).toHaveLength(1);
  });

  it("rejects a cache store that is not configured", async () => {
    const config = { cache: { enabled: true, store: "s3" } };
    expect(await codeOf(create({ name: "mi", format: "npm", kind: "mirror", upstreams: [upstream()], config }))).toBe(
      "invalid_request",
    );
    await create({ name: "mi", format: "npm", kind: "mirror", upstreams: [upstream()], config: { cache: { store: "local" } } });
    expect(await codeOf(repos.update(admin, "mi", { config }))).toBe("invalid_request");
    expect((await repos.get("mi"))!.config).toMatchObject({ cache: { store: "local" } });
  });

  it("reads a stale stored config leniently and repairs it on the next update", async () => {
    const [row] = await testDb.db
      .insert(repository)
      .values({
        name: "stale",
        format: "maven",
        kind: "mirror",
        config: { legacy: true, offline: "yes", cache: { enabled: true, metadataTtlSeconds: -1, old: 1 } },
      })
      .returning();
    const repo = await repos.getById(row!.id);
    expect(repo!.config).toEqual({
      cache: { enabled: true, store: null, metadataTtlSeconds: 1800, maxAgeDays: null, maxSizeBytes: null },
      offline: false,
      rules: { allow: [], deny: [] },
    });
    expect((await repos.list()).map((r) => r.name)).toEqual(["stale"]);
    const updated = await repos.update(admin, "stale", { config: { offline: true } });
    expect(updated.config).toMatchObject({ offline: true, cache: { enabled: true } });
  });

  it('docker repo named "library" is rejected', async () => {
    expect(await codeOf(create({ name: "library", format: "docker", kind: "hosted" }))).toBe("invalid_request");
    await create({ name: "library", format: "maven", kind: "hosted" });
  });

  it("updates description, visibility and merges config", async () => {
    await create({ name: "mi", format: "maven", kind: "mirror", upstreams: [upstream()] });
    const updated = await repos.update(admin, "mi", {
      description: "Maven Central",
      visibility: "public",
      config: { cache: { enabled: true, maxAgeDays: 30 }, rules: { allow: ["org.*"] } },
    });
    expect(updated).toMatchObject({ description: "Maven Central", visibility: "public" });
    expect(updated.config).toEqual({
      cache: { enabled: true, store: null, metadataTtlSeconds: 1800, maxAgeDays: 30, maxSizeBytes: null },
      offline: false,
      rules: { allow: ["org.*"], deny: [] },
    });
    const again = await repos.update(admin, "mi", { config: { offline: true } });
    expect(again.config).toMatchObject({ offline: true, cache: { enabled: true, maxAgeDays: 30 } });
    expect(await codeOf(repos.update(admin, "mi", { config: { cache: { metadataTtlSeconds: -5 } } }))).toBe("invalid_request");
    expect(await codeOf(repos.update(admin, "ghost", {}))).toBe("not_found");
  });

  it("deleting a member removes it from groups", async () => {
    await create({ name: "a", format: "npm", kind: "hosted" });
    await create({ name: "b", format: "npm", kind: "hosted" });
    const group = await create({ name: "g", format: "npm", kind: "group", members: ["a", "b"] });
    await repos.delete(admin, "a");
    expect((await repos.members(group.id)).map((r) => r.name)).toEqual(["b"]);
    expect(await codeOf(repos.delete(admin, "a"))).toBe("not_found");
  });

  it("lets a delete guard refuse the delete with the row locked", async () => {
    await create({ name: "kept", format: "maven", kind: "hosted" });
    const seen: string[] = [];
    const refuse = repos.delete(admin, "kept", {
      guard: async (_tx, repo) => {
        seen.push(`${repo.format}/${repo.name}`);
        throw new RegistryError("invalid_request", "not now");
      },
    });
    expect(await codeOf(refuse)).toBe("invalid_request");
    expect(seen).toEqual(["maven/kept"]);
    expect(await repos.get("kept")).not.toBeNull();
    await repos.delete(admin, "kept", { guard: async () => undefined });
    expect(await repos.get("kept")).toBeNull();
  });

  it("deleting a repo deletes its stored asset objects and cascades key permissions", async () => {
    const repo = await create({ name: "doomed", format: "maven", kind: "hosted" });
    const keep = await create({ name: "kept", format: "proto", kind: "hosted" });
    const proto = await create({ name: "protos", format: "proto", kind: "hosted" });
    await putBuffer(stores.primary, "doomed/a.jar", Buffer.from("jar"));
    await putBuffer(stores.primary, "protos/x.tar.gz", Buffer.from("tgz"));
    await putBuffer(stores.primary, "kept/y.tar.gz", Buffer.from("tgz"));
    const digests = { md5: "m", sha1: "s1", sha256: "s256", sha512: "s512" };
    await testDb.db.insert(asset).values({
      repositoryId: repo.id,
      path: "a.jar",
      store: "local",
      storageKey: "doomed/a.jar",
      size: 3,
      origin: "hosted",
      ...digests,
    });
    for (const [r, key] of [
      [proto, "protos/x.tar.gz"],
      [keep, "kept/y.tar.gz"],
    ] as const) {
      const [artifact] = await testDb.db.insert(protoArtifact).values({ repositoryId: r.id, group: "acme", name: "x" }).returning();
      const [version] = await testDb.db
        .insert(protoVersion)
        .values({ artifactId: artifact!.id, version: "1.0.0", isSnapshot: false })
        .returning();
      await testDb.db
        .insert(protoBuild)
        .values({ versionId: version!.id, buildNumber: 1, store: "local", storageKey: key, sha256: "x", sizeBytes: 3 });
    }
    const now = new Date();
    await testDb.db.insert(apikey).values({ id: "key-1", referenceId: "admin-user", key: "hash", createdAt: now, updatedAt: now });
    await testDb.db.insert(repoPermission).values([
      { apiKeyId: "key-1", repositoryId: repo.id, access: "read" },
      { apiKeyId: "key-1", repositoryId: keep.id, access: "read" },
    ]);

    await repos.delete(admin, "doomed");
    await repos.delete(admin, "protos");

    expect(await getBuffer(stores.primary, "doomed/a.jar")).toBeNull();
    expect(await getBuffer(stores.primary, "protos/x.tar.gz")).toBeNull();
    expect((await getBuffer(stores.primary, "kept/y.tar.gz"))?.toString()).toBe("tgz");
    expect(await testDb.db.select().from(asset)).toEqual([]);
    const perms = await testDb.db.select({ repositoryId: repoPermission.repositoryId }).from(repoPermission);
    expect(perms).toEqual([{ repositoryId: keep.id }]);
    expect(await repos.get("doomed")).toBeNull();
  });

  it("upstream secrets are stored encrypted and upstreams() never returns them", async () => {
    const mirror = await create({
      name: "private-npm",
      format: "npm",
      kind: "mirror",
      upstreams: [
        { url: "https://npm.corp.example", authType: "bearer", secret: "tok-123" },
        { url: "https://npm2.corp.example", authType: "basic", username: "bob", secret: "hunter2" },
        { url: "https://registry.npmjs.org", authType: "none" },
      ],
    });
    const rows = await testDb.db
      .select()
      .from(repositoryUpstream)
      .where(eq(repositoryUpstream.repositoryId, mirror.id))
      .orderBy(repositoryUpstream.position);
    expect(rows[0]!.secret).not.toContain("tok-123");
    expect(decryptSecret(secretKey, rows[0]!.secret!)).toBe("tok-123");
    expect(rows[2]!.secret).toBeNull();

    const views = await repos.upstreams(mirror.id);
    expect(views).toEqual([
      { id: rows[0]!.id, url: "https://npm.corp.example", authType: "bearer", username: null, hasSecret: true },
      { id: rows[1]!.id, url: "https://npm2.corp.example", authType: "basic", username: "bob", hasSecret: true },
      { id: rows[2]!.id, url: "https://registry.npmjs.org", authType: "none", username: null, hasSecret: false },
    ]);
    expect(JSON.stringify(views)).not.toMatch(/tok-123|hunter2/);
    expect((await repos.upstreamsWithSecrets(mirror.id)).map((u) => u.secret)).toEqual(["tok-123", "hunter2", null]);
    expect(JSON.stringify(await audits())).not.toMatch(/tok-123|hunter2/);
    expect(
      await codeOf(
        create({ name: "bad", format: "npm", kind: "mirror", upstreams: [{ url: "https://x.example", authType: "bearer" }] }),
      ),
    ).toBe("invalid_request");
  });

  it("update with secret undefined keeps the stored secret", async () => {
    const mirror = await create({
      name: "m",
      format: "maven",
      kind: "mirror",
      upstreams: [{ url: "https://maven.corp.example", authType: "basic", username: "bob", secret: "pw1" }],
    });
    await repos.update(admin, "m", {
      upstreams: [
        upstream("https://repo1.maven.org/maven2"),
        { url: "https://maven.corp.example", authType: "basic", username: "alice" },
      ],
    });
    const secrets = await repos.upstreamsWithSecrets(mirror.id);
    expect(secrets.map((u) => [u.url, u.username, u.secret])).toEqual([
      ["https://repo1.maven.org/maven2", null, null],
      ["https://maven.corp.example", "alice", null],
    ]);

    // Same URL, auth type and username: the secret stays; any of them changing drops it.
    await repos.update(admin, "m", {
      upstreams: [{ url: "https://maven.corp.example", authType: "basic", username: "bob", secret: "pw2" }],
    });
    await repos.update(admin, "m", { upstreams: [{ url: "https://maven.corp.example", authType: "basic", username: "bob" }] });
    expect((await repos.upstreamsWithSecrets(mirror.id)).map((u) => u.secret)).toEqual(["pw2"]);
    await repos.update(admin, "m", { upstreams: [{ url: "https://maven.corp.example/", authType: "basic", username: "bob" }] });
    expect((await repos.upstreamsWithSecrets(mirror.id)).map((u) => u.secret)).toEqual([null]);
    await repos.update(admin, "m", {
      upstreams: [{ url: "https://maven.corp.example", authType: "bearer", secret: "tok" }],
    });
    await repos.update(admin, "m", { upstreams: [{ url: "https://maven.corp.example", authType: "bearer" }] });
    expect((await repos.upstreamsWithSecrets(mirror.id)).map((u) => u.secret)).toEqual(["tok"]);
    await repos.update(admin, "m", { upstreams: [{ url: "https://maven.corp.example", authType: "basic", username: "x" }] });
    expect((await repos.upstreamsWithSecrets(mirror.id)).map((u) => u.secret)).toEqual([null]);
  });

  it("every mutation records an audit event", async () => {
    await create({ name: "x", format: "npm", kind: "hosted", description: "first" });
    await repos.update(admin, "x", { description: "second" });
    await repos.delete(admin, "x");
    expect((await audits()).map((a) => [a.action, a.target])).toEqual([
      ["repository.create", "x"],
      ["repository.update", "x"],
      ["repository.delete", "x"],
    ]);
    const [entry] = await testDb.db.select().from(auditEvent).where(eq(auditEvent.action, "repository.create"));
    expect(entry).toMatchObject({ actorType: "user", actorId: "admin-user" });
  });

  it("keeps rows consistent when a group member list is replaced", async () => {
    await create({ name: "a", format: "proto", kind: "hosted" });
    await create({ name: "b", format: "proto", kind: "hosted" });
    const group = await create({ name: "g", format: "proto", kind: "group", members: ["a"] });
    await repos.update(admin, "g", { members: ["b", "a"] });
    const rows = await testDb.db.select().from(groupMember).where(eq(groupMember.groupId, group.id)).orderBy(groupMember.position);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(await codeOf(repos.update(admin, "a", { members: ["b"] }))).toBe("invalid_request");
    expect(await testDb.db.select({ n: repository.name }).from(repository).orderBy(repository.name)).toEqual([
      { n: "a" },
      { n: "b" },
      { n: "g" },
    ]);
  });
});

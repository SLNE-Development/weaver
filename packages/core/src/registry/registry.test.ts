import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditEvent, protoBuild as build, protoDeletedRelease as deletedRelease, repository } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { packArchive, type ProtoFile } from "../archive.js";
import { createAssetService } from "../content/assets.js";
import type { Coordinate } from "../coordinates.js";
import { deriveSecretKey } from "../crypto.js";
import type { RegistryError } from "../errors.js";
import { createMirrorEngine } from "../mirror/index.js";
import type { KeyPermission, Principal, Role } from "../permissions.js";
import { createRepoService, type Repo, type RepoService } from "../repos/service.js";
import type { ServerSettings } from "../settings.js";
import { createStoreSetFromEnv, getBuffer, type ObjectStore, type StoreSet } from "../storage/index.js";
import { validateProtos } from "../validation.js";
import { createRegistry, publishRepositoryOrder, type Manifest, type Registry } from "./index.js";
import type { ProtoHostedConfig } from "../repos/config.js";

const anonymous: Principal = { kind: "anonymous" };

function key(role: Role, permissions: KeyPermission[], keyId = `key-${role}`): Principal {
  return { kind: "apikey", keyId, userId: `user-${role}`, role, permissions };
}

/** Fixed repository ids, so principals can be built before the rows exist. */
const repoIds: Record<string, string> = {
  releases: "00000000-0000-4000-8000-000000000001",
  snapshots: "00000000-0000-4000-8000-000000000002",
  shared: "00000000-0000-4000-8000-000000000003",
  alpha: "00000000-0000-4000-8000-000000000004",
  zeta: "00000000-0000-4000-8000-000000000005",
  other: "00000000-0000-4000-8000-000000000006",
  hidden: "00000000-0000-4000-8000-000000000007",
  private: "00000000-0000-4000-8000-000000000008",
  everything: "00000000-0000-4000-8000-000000000009",
};

const write = (repo: string): KeyPermission => ({ repositoryId: repoIds[repo]!, repository: repo, groupPrefix: null, access: "write" });
const read = (repo: string): KeyPermission => ({ repositoryId: repoIds[repo]!, repository: repo, groupPrefix: null, access: "read" });

const maintainer = key("maintainer", [write("releases"), write("snapshots"), read("shared")]);
const admin = key("admin", [write("releases"), write("snapshots")], "key-admin");
const maintainerWith = (...permissions: KeyPermission[]) => key("maintainer", permissions, "key-extra");

const coord = (group: string, name: string, version: string): Coordinate => ({ group, name, version });

function proto(path: string, body: string, imports: string[] = []): ProtoFile {
  const pkg = path.replace(/\/[^/]+$/, "").replaceAll("/", ".");
  const importLines = imports.map((i) => `import "${i}";`).join("\n");
  return { path, content: `syntax = "proto3";\npackage ${pkg};\n${importLines}\n${body}\n` };
}

function manifest(group: string, name: string, version: string, dependencies: string[] = []): Manifest {
  return { group, name, version, dependencies };
}

async function expectError(promise: Promise<unknown>, code: string): Promise<RegistryError> {
  try {
    await promise;
  } catch (error) {
    expect((error as RegistryError).code).toBe(code);
    return error as RegistryError;
  }
  throw new Error(`expected RegistryError ${code}, but the call succeeded`);
}

describe("registry", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let stores: StoreSet;
  let repos: RepoService;
  let registry: Registry;

  const moneyFiles = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; }")];
  const orderFiles = (v = "Order") => [
    proto(
      "acme/order/v1/order.proto",
      `message ${v} { acme.money.v1.Money total = 1; }`,
      ["acme/money/v1/money.proto"],
    ),
  ];

  /** Inserts a hosted proto repository with the given proto settings in its config. */
  async function insertRepo(name: string, settings: Partial<ProtoHostedConfig> = {}) {
    await testDb.db.insert(repository).values({ id: repoIds[name], name, format: "proto", kind: "hosted", config: settings });
  }

  /** Merges proto settings into a repository's config. */
  async function updateSettings(name: string, settings: Partial<ProtoHostedConfig>) {
    await testDb.db
      .update(repository)
      .set({ config: sql`${repository.config} || ${JSON.stringify(settings)}::jsonb` })
      .where(eq(repository.name, name));
  }

  async function publishMoney(
    principal = maintainer,
    repo = "releases",
    version = "1.0.0",
    files = moneyFiles,
  ) {
    return registry.publish(principal, {
      repository: repo,
      manifest: manifest("acme", "money", version),
      archive: await packArchive(files),
    });
  }

  async function publishOrder(principal = maintainer, repo = "releases", deps = ["acme:money:1.0.0"]) {
    return registry.publish(principal, {
      repository: repo,
      manifest: manifest("acme", "order", "1.0.0", deps),
      archive: await packArchive(orderFiles()),
    });
  }

  async function auditActions(): Promise<{ action: string; forced: boolean; target: string }[]> {
    return testDb.db
      .select({ action: auditEvent.action, forced: auditEvent.forced, target: auditEvent.target })
      .from(auditEvent)
      .orderBy(auditEvent.at);
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-registry-"));
    stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    repos = createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("registry-test-secret") });
    registry = createRegistry({ db: testDb.db, stores, repos });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, audit_event CASCADE`);
    await insertRepo("releases", { allowSnapshots: false });
    await insertRepo("snapshots", { allowReleases: false });
  });

  it("records the primary store on the build and serves the archive from that store", async () => {
    await publishMoney();
    const [row] = await testDb.db.select({ store: build.store }).from(build);
    expect(row?.store).toBe("local");

    // The primary moved to another store; the archive is still read from the one it was written to.
    const wrong = () => Promise.reject(new Error("read from the wrong store"));
    const elsewhere: ObjectStore = { id: "s3", put: wrong, get: wrong, head: wrong, delete: wrong, deleteMany: wrong };
    const moved: StoreSet = { primary: elsewhere, get: (id) => stores.get(id), configured: () => ["local", "s3"] };
    const archive = await createRegistry({ db: testDb.db, stores: moved, repos }).download(
      maintainer,
      "releases",
      coord("acme", "money", "1.0.0"),
    );
    expect(archive.data.length).toBeGreaterThan(0);
  });

  it("ignores repositories of other formats", async () => {
    await testDb.db.insert(repository).values({ name: "maven-releases", format: "maven", kind: "hosted" });
    await expectError(publishMoney(key("maintainer", [write("maven-releases")]), "maven-releases"), "not_found");
  });

  it("publishes a release as build 1 and exposes files and dependencies", async () => {
    const money = await publishMoney();
    expect(money).toMatchObject({ coordinate: coord("acme", "money", "1.0.0"), buildNumber: 1, redeployed: false });
    expect(money.sha256).toMatch(/^[0-9a-f]{64}$/);

    await publishOrder();
    const info = await registry.getManifest(maintainer, "releases", coord("acme", "order", "1.0.0"));
    expect(info.files).toEqual(["acme/order/v1/order.proto"]);
    expect(info.dependencies).toEqual([coord("acme", "money", "1.0.0")]);
    expect(info.buildNumber).toBe(1);
    // The fixture principal has no user row, as after the publisher was deleted: no raw id leaks.
    expect(info.publishedBy).toBeNull();
    expect(info.builds).toHaveLength(1);

    const file = await registry.getFile(maintainer, "releases", coord("acme", "order", "1.0.0"), "acme/order/v1/order.proto");
    expect(file).toContain("message Order");

    const versions = await registry.listVersions(maintainer, "releases", "acme", "money");
    expect(versions).toEqual([
      expect.objectContaining({ version: "1.0.0", isSnapshot: false, latestBuild: 1 }),
    ]);
  });

  it("publishes and downloads a name containing '..' on local storage", async () => {
    await registry.publish(maintainer, {
      repository: "releases",
      manifest: manifest("acme", "foo..bar", "1.0.0"),
      archive: await packArchive(moneyFiles),
    });
    const downloaded = await registry.download(maintainer, "releases", coord("acme", "foo..bar", "1.0.0"));
    expect(downloaded.filename).toBe("foo..bar-1.0.0.tar.gz");
  });

  it("records the publishing key and user on the build", async () => {
    await publishMoney();
    const [row] = await testDb.db.select().from(build);
    expect(row?.publishedByKeyId).toBe("key-maintainer");
    expect(row?.publishedByUserId).toBe("user-maintainer");
  });

  it("rejects republishing an immutable release and replaces it when redeploy is allowed", async () => {
    await publishMoney();
    await expectError(publishMoney(), "immutable");

    await updateSettings("releases", { allowRedeploy: true });
    const [before] = await testDb.db.select().from(build);
    const replaced = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; string currency = 2; }")];
    const result = await publishMoney(maintainer, "releases", "1.0.0", replaced);
    expect(result).toMatchObject({ buildNumber: 1, redeployed: true });

    const file = await registry.getFile(maintainer, "releases", coord("acme", "money", "1.0.0"), "acme/money/v1/money.proto");
    expect(file).toContain("currency");
    const builds = await testDb.db.select().from(build);
    expect(builds).toHaveLength(1);
    expect(await getBuffer(stores.primary, before!.storageKey)).toBeNull();
    expect(await getBuffer(stores.primary, builds[0]!.storageKey)).not.toBeNull();
  });

  it("blocks redeploying a release that has dependents unless an admin forces it", async () => {
    await updateSettings("releases", { allowRedeploy: true });
    await publishMoney();
    await publishOrder();

    const blocked = await expectError(publishMoney(), "has_dependents");
    expect(blocked.details).toEqual({
      dependents: [{ repository: "releases", coordinate: coord("acme", "order", "1.0.0") }],
      hiddenDependents: 0,
    });

    await expectError(
      registry.publish(maintainer, {
        repository: "releases",
        manifest: manifest("acme", "money", "1.0.0"),
        archive: await packArchive(moneyFiles),
        force: true,
      }),
      "forbidden",
    );

    const forced = await registry.publish(admin, {
      repository: "releases",
      manifest: manifest("acme", "money", "1.0.0"),
      archive: await packArchive(moneyFiles),
      force: true,
    });
    expect(forced.redeployed).toBe(true);
    const audit = await auditActions();
    expect(audit.at(-1)).toMatchObject({ action: "redeploy", forced: true });
  });

  it("creates a new build for every snapshot publish and serves the newest", async () => {
    for (const expected of [1, 2, 3]) {
      const r = await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
      expect(r.buildNumber).toBe(expected);
    }
    const info = await registry.getManifest(maintainer, "snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"));
    expect(info.buildNumber).toBe(3);
    expect(info.builds.map((b) => b.buildNumber)).toEqual([1, 2, 3]);
  });

  it("downloads a specific snapshot build on request, and not_found once it is gone", async () => {
    const snapshot = coord("acme", "money", "1.0.0-SNAPSHOT");
    const first = await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
    const changed = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; string currency = 2; }")];
    const second = await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT", changed);
    expect(second.sha256).not.toBe(first.sha256);

    expect((await registry.download(maintainer, "snapshots", snapshot)).sha256).toBe(second.sha256);
    expect((await registry.download(maintainer, "snapshots", snapshot, { buildNumber: 1 })).sha256).toBe(first.sha256);
    expect((await registry.getManifest(maintainer, "snapshots", snapshot, { buildNumber: 1 })).sha256).toBe(first.sha256);
    await expectError(registry.download(maintainer, "snapshots", snapshot, { buildNumber: 3 }), "not_found");

    await testDb.db.delete(build).where(eq(build.buildNumber, 1));
    await expectError(registry.download(maintainer, "snapshots", snapshot, { buildNumber: 1 }), "not_found");
  });

  /** A registry whose validation holds publishes until two arrive, then lets both into their transactions at once. */
  function racingRegistry(): Registry {
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((r) => (release = r));
    return createRegistry({
      db: testDb.db,
      stores,
      repos,
      validate: async () => {
        if (++arrived === 2) release();
        await together;
        return [];
      },
    });
  }

  // The version upsert's row lock already serializes these two transactions; the advisory lock is a
  // second guard. What this pins down is the outcome: distinct, consecutive build numbers.
  it("gives concurrent snapshot publishes distinct consecutive build numbers", async () => {
    const racing = racingRegistry();
    const publishSnapshot = async () =>
      racing.publish(maintainer, {
        repository: "snapshots",
        manifest: manifest("acme", "money", "1.0.0-SNAPSHOT"),
        archive: await packArchive(moneyFiles),
      });
    const results = await Promise.all([publishSnapshot(), publishSnapshot()]);
    expect(results.map((r) => r.buildNumber).sort()).toEqual([1, 2]);
  });

  it("lets only one of two concurrent publishes of the same release win", async () => {
    const racing = racingRegistry();
    const publishRelease = async () =>
      racing.publish(maintainer, {
        repository: "releases",
        manifest: manifest("acme", "money", "1.0.0"),
        archive: await packArchive(moneyFiles),
      });
    const results = await Promise.allSettled([publishRelease(), publishRelease()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected?.reason as RegistryError).code).toBe("immutable");
    const keys = (await testDb.db.select({ storageKey: build.storageKey }).from(build)).map((r) => r.storageKey);
    expect(keys).toHaveLength(1);
  });

  it("rejects a release that depends on a snapshot", async () => {
    await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
    await expectError(
      registry.publish(key("maintainer", [write("releases"), read("snapshots")]), {
        repository: "releases",
        manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0-SNAPSHOT"]),
        archive: await packArchive(orderFiles()),
      }),
      "validation_failed",
    );
  });

  it("does not disclose a private repository the key can't read when publishing", async () => {
    const outsider = key("maintainer", [write("snapshots")], "key-outsider");
    const hidden = await expectError(publishMoney(outsider, "releases"), "not_found");
    const missing = await expectError(publishMoney(outsider, "absent"), "not_found");
    expect(hidden.message.replace("releases", "X")).toBe(missing.message.replace("absent", "X"));
  });

  it("rejects version kinds the repository does not accept", async () => {
    await expectError(publishMoney(maintainer, "releases", "1.0.0-SNAPSHOT"), "invalid_request");
    await expectError(publishMoney(maintainer, "snapshots", "1.0.0"), "invalid_request");
  });

  it("rejects publishing to a proto group as method_not_allowed, before the write check", async () => {
    await testDb.db.insert(repository).values({ id: repoIds.everything, name: "everything", format: "proto", kind: "group" });
    const key = maintainerWith(write("everything"));
    // Groups are read-only in the permission model; the kind check answers first, so this is not `forbidden`.
    const error = await expectError(publishMoney(key, "everything"), "method_not_allowed");
    expect(error.message).toBe("Repository everything is a group; publish to a hosted repository");
  });

  it("does not disclose an unreadable group when publishing to it", async () => {
    await testDb.db.insert(repository).values({ id: repoIds.everything, name: "everything", format: "proto", kind: "group" });
    await expectError(publishMoney(maintainerWith(write("snapshots")), "everything"), "not_found");
  });

  it("rejects an invalid manifest", async () => {
    await expectError(
      registry.publish(maintainer, {
        repository: "releases",
        manifest: { group: "Acme!", name: "money", version: "1.0.0", dependencies: [] },
        archive: await packArchive(moneyFiles),
      }),
      "invalid_request",
    );
  });

  it("rejects an undeclared import with the offending path", async () => {
    await publishMoney();
    const error = await expectError(publishOrder(maintainer, "releases", []), "validation_failed");
    const issues = (error.details as { issues: { path: string }[] }).issues;
    expect(issues[0]?.path).toBe("acme/order/v1/order.proto");
  });

  it("rejects files that collide with a dependency", async () => {
    await publishMoney();
    await expectError(
      registry.publish(maintainer, {
        repository: "releases",
        manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0"]),
        archive: await packArchive([...moneyFiles, ...orderFiles()]),
      }),
      "validation_failed",
    );
  });

  /** A registry using real validation that records the dependency files of every publish. */
  function spyingRegistry(): { registry: Registry; dependencyFiles: ProtoFile[][] } {
    const dependencyFiles: ProtoFile[][] = [];
    return {
      dependencyFiles,
      registry: createRegistry({
        db: testDb.db,
        stores,
        repos,
        validate: async (input) => {
          dependencyFiles.push(input.dependencyFiles);
          return validateProtos(input);
        },
      }),
    };
  }

  const currencyMoney = [
    proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; }\nmessage Currency { string code = 1; }"),
  ];
  const currencyOrder = [
    proto("acme/order/v1/order.proto", "message Order { acme.money.v1.Currency currency = 1; }", [
      "acme/money/v1/money.proto",
    ]),
  ];

  it("validates against the dependency copy in the repository with the lowest resolutionPriority", async () => {
    // Inserted, and named, in the opposite order of their priority so neither decides the outcome.
    await insertRepo("alpha", { resolutionPriority: 10 });
    await insertRepo("zeta", { resolutionPriority: 5 });
    await publishMoney(key("maintainer", [write("alpha")], "key-alpha"), "alpha");
    await publishMoney(key("maintainer", [write("zeta")], "key-zeta"), "zeta", "1.0.0", currencyMoney);

    const spy = spyingRegistry();
    const reader = key("maintainer", [write("releases"), read("alpha"), read("zeta")], "key-reader");
    const result = await spy.registry.publish(reader, {
      repository: "releases",
      manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0"]),
      archive: await packArchive(currencyOrder),
    });
    expect(result.buildNumber).toBe(1);
    expect(spy.dependencyFiles).toEqual([currencyMoney]);
  });

  it("skips repositories the publishing key can't read when resolving dependencies", async () => {
    await insertRepo("shared", { resolutionPriority: 10 });
    await insertRepo("other", { resolutionPriority: 5 });
    const sharedWriter = key("maintainer", [write("shared")], "key-shared");
    const otherWriter = key("maintainer", [write("other")], "key-other");
    // "other" has the lower priority value but this key can't read it, so "shared" is used.
    await publishMoney(otherWriter, "other");
    await publishMoney(sharedWriter, "shared", "1.0.0", currencyMoney);

    const spy = spyingRegistry();
    await spy.registry.publish(maintainer, {
      repository: "releases",
      manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0"]),
      archive: await packArchive(currencyOrder),
    });
    expect(spy.dependencyFiles).toEqual([currencyMoney]);
  });

  it("resolves dependencies from a repository the key reads only for the dependency's group", async () => {
    await insertRepo("shared");
    await publishMoney(key("maintainer", [write("shared")], "key-shared"), "shared");
    const scoped = key("maintainer", [write("releases"), { ...read("shared"), groupPrefix: "acme" }], "key-scoped");
    await expect(publishOrder(scoped)).resolves.toMatchObject({ buildNumber: 1 });

    const elsewhere = key("maintainer", [write("releases"), { ...read("shared"), groupPrefix: "corp" }], "key-elsewhere");
    await registry.deleteVersion(admin, "releases", coord("acme", "order", "1.0.0"));
    await expectError(publishOrder(elsewhere), "validation_failed");
  });

  it("prefers the target repository over higher-priority repositories", async () => {
    await insertRepo("shared", { resolutionPriority: 1 });
    await publishMoney(key("maintainer", [write("shared")], "key-shared"), "shared");
    await publishMoney(maintainer, "releases", "1.0.0", currencyMoney);
    const spy = spyingRegistry();
    await spy.registry.publish(maintainer, {
      repository: "releases",
      manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0"]),
      archive: await packArchive(currencyOrder),
    });
    expect(spy.dependencyFiles).toEqual([currencyMoney]);
  });

  it("does not resolve dependencies from private repositories the key can't read", async () => {
    await insertRepo("hidden");
    await publishMoney(key("maintainer", [write("hidden")], "key-hidden"), "hidden");
    const error = await expectError(publishOrder(), "validation_failed");
    expect(error.message).toMatch(/dependency not found/i);
  });

  it("requires write permission and authentication to publish", async () => {
    await expectError(publishMoney(key("maintainer", [read("releases")])), "forbidden");
    await testDb.db.update(repository).set({ visibility: "public" }).where(eq(repository.name, "releases"));
    await expectError(publishMoney(key("maintainer", [])), "forbidden");
    await testDb.db.update(repository).set({ visibility: "private" }).where(eq(repository.name, "releases"));
    await expectError(publishMoney(key("viewer", [write("releases")])), "forbidden");
    await expectError(publishMoney({ kind: "user", userId: "u1", role: "admin" }), "forbidden");
    await expectError(publishMoney(anonymous), "unauthorized");
  });

  it("reads public repositories anonymously and hides private ones", async () => {
    await testDb.db.update(repository).set({ visibility: "public" }).where(eq(repository.name, "releases"));
    await publishMoney();
    const info = await registry.getManifest(anonymous, "releases", coord("acme", "money", "1.0.0"));
    expect(info.files).toEqual(["acme/money/v1/money.proto"]);

    await insertRepo("private");
    await publishMoney(key("maintainer", [write("private")], "key-private"), "private");
    await expectError(registry.getManifest(anonymous, "private", coord("acme", "money", "1.0.0")), "not_found");
    await expectError(registry.listVersions(anonymous, "private", "acme", "money"), "not_found");
    await expectError(registry.download(anonymous, "private", coord("acme", "money", "1.0.0")), "not_found");
  });

  it("counts downloads on the served build", async () => {
    const published = await publishMoney();
    const download = await registry.download(maintainer, "releases", coord("acme", "money", "1.0.0"));
    expect(download.sha256).toBe(published.sha256);
    expect(download.filename).toBe("money-1.0.0.tar.gz");
    expect(download.data.length).toBeGreaterThan(0);

    const info = await registry.getManifest(maintainer, "releases", coord("acme", "money", "1.0.0"));
    expect(info.downloadCount).toBe(1);
    const [row] = await testDb.db.select().from(build);
    expect(row?.lastDownloadedAt).toBeInstanceOf(Date);
  });

  it("lists dependents across repositories", async () => {
    await publishMoney();
    await publishOrder();
    expect(await registry.listDependents(coord("acme", "money", "1.0.0"))).toEqual([
      { repository: "releases", coordinate: coord("acme", "order", "1.0.0") },
    ]);
    expect(await registry.listDependents(coord("acme", "order", "1.0.0"))).toEqual([]);
  });

  it("blocks deleting a depended-on version", async () => {
    await publishMoney();
    await publishOrder();
    const blocked = await expectError(
      registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0")),
      "has_dependents",
    );
    expect(blocked.details).toEqual({
      dependents: [{ repository: "releases", coordinate: coord("acme", "order", "1.0.0") }],
      hiddenDependents: 0,
    });
    await expectError(
      registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0"), { force: true }),
      "forbidden",
    );
    expect(await testDb.db.select().from(build)).toHaveLength(2);
  });

  it("deletes a version without dependents including its blobs", async () => {
    await publishMoney();
    await publishOrder();
    const keysBefore = (await testDb.db.select({ storageKey: build.storageKey }).from(build)).map((r) => r.storageKey);

    await registry.deleteVersion(maintainer, "releases", coord("acme", "order", "1.0.0"));
    await expectError(registry.getManifest(maintainer, "releases", coord("acme", "order", "1.0.0")), "not_found");
    const keysAfter = (await testDb.db.select({ storageKey: build.storageKey }).from(build)).map((r) => r.storageKey);
    expect(keysAfter).toHaveLength(1);
    const removed = keysBefore.filter((k) => !keysAfter.includes(k));
    expect(removed).toHaveLength(1);
    expect(await getBuffer(stores.primary, removed[0]!)).toBeNull();

    // With its only dependent gone, money can be deleted too.
    await registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0"));
    expect(await testDb.db.select().from(build)).toHaveLength(0);
  });

  describe("re-publishing a deleted release", () => {
    const money = coord("acme", "money", "1.0.0");
    const changed = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; string currency = 2; }")];

    const tombstones = () => testDb.db.select().from(deletedRelease);

    it("records a tombstone with the deleted archive's sha256", async () => {
      const published = await publishMoney();
      await registry.deleteVersion(maintainer, "releases", money);
      const rows = await tombstones();
      expect(rows).toEqual([
        expect.objectContaining({ group: "acme", name: "money", version: "1.0.0", sha256: published.sha256 }),
      ]);
    });

    it("refuses different content while redeploy is off", async () => {
      await publishMoney();
      await registry.deleteVersion(maintainer, "releases", money);
      const error = await expectError(publishMoney(maintainer, "releases", "1.0.0", changed), "immutable");
      expect(error.message).toBe(
        "Release acme:money:1.0.0 was deleted; re-publishing is only allowed with identical content (or enable redeploy)",
      );
      expect(await tombstones()).toHaveLength(1);
      expect(await testDb.db.select().from(build)).toHaveLength(0);
    });

    it("allows identical content and removes the tombstone", async () => {
      const first = await publishMoney();
      await registry.deleteVersion(maintainer, "releases", money);
      const again = await publishMoney();
      expect(again).toMatchObject({ sha256: first.sha256, buildNumber: 1, redeployed: false });
      expect(await tombstones()).toHaveLength(0);
    });

    it("allows different content when the repository allows redeploy", async () => {
      await publishMoney();
      await registry.deleteVersion(maintainer, "releases", money);
      await updateSettings("releases", { allowRedeploy: true });
      await expect(publishMoney(maintainer, "releases", "1.0.0", changed)).resolves.toMatchObject({ buildNumber: 1 });
      expect(await tombstones()).toHaveLength(0);
    });

    it("leaves snapshots unaffected", async () => {
      await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
      await registry.deleteVersion(maintainer, "snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"));
      expect(await tombstones()).toHaveLength(0);
      await expect(publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT", changed)).resolves.toMatchObject({
        buildNumber: 1,
      });
    });

    it("scopes tombstones to the repository", async () => {
      await insertRepo("other");
      const other = key("maintainer", [write("releases"), write("other")]);
      await publishMoney(other);
      await registry.deleteVersion(other, "releases", money);
      await expect(publishMoney(other, "other", "1.0.0", changed)).resolves.toMatchObject({ buildNumber: 1 });
    });
  });

  it("lists only readable dependents and counts the hidden ones", async () => {
    await insertRepo("hidden");
    await publishMoney();
    await publishOrder();
    await publishOrder(key("maintainer", [write("hidden"), read("releases")], "key-hidden"), "hidden");

    const blocked = await expectError(
      registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0")),
      "has_dependents",
    );
    expect(blocked.details).toEqual({
      dependents: [{ repository: "releases", coordinate: coord("acme", "order", "1.0.0") }],
      hiddenDependents: 1,
    });
    // Users browse every repository, so an admin user sees both dependents.
    const asAdminUser = await expectError(
      registry.deleteVersion({ kind: "user", userId: "u-admin", role: "admin" }, "releases", coord("acme", "money", "1.0.0")),
      "has_dependents",
    );
    expect(asAdminUser.details).toMatchObject({ hiddenDependents: 0 });
    expect((asAdminUser.details as { dependents: unknown[] }).dependents).toHaveLength(2);
  });

  it("lets an admin force-delete a depended-on version", async () => {
    await publishMoney();
    await publishOrder();
    await registry.deleteVersion(admin, "releases", coord("acme", "money", "1.0.0"), { force: true });
    const audit = await auditActions();
    expect(audit.at(-1)).toMatchObject({ action: "delete", forced: true, target: "releases/acme:money:1.0.0" });
  });

  it("requires delete permission", async () => {
    await publishMoney();
    await expectError(
      registry.deleteVersion(key("viewer", [read("releases")]), "releases", coord("acme", "money", "1.0.0")),
      "forbidden",
    );
    await expectError(registry.deleteVersion(anonymous, "releases", coord("acme", "money", "1.0.0")), "unauthorized");
  });

  it("writes an audit row for every mutation", async () => {
    await updateSettings("releases", { allowRedeploy: true });
    await publishMoney();
    await publishMoney();
    await registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0"));
    const audit = await auditActions();
    expect(audit.map((a) => a.action)).toEqual(["publish", "redeploy", "delete"]);
    expect(audit.every((a) => a.target === "releases/acme:money:1.0.0" && !a.forced)).toBe(true);
    const actors = await testDb.db
      .select({ actorType: auditEvent.actorType, actorId: auditEvent.actorId })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "publish")));
    expect(actors).toEqual([{ actorType: "apikey", actorId: "key-maintainer" }]);
  });

  describe("on the repository model", () => {
    const writeOn = (r: Repo): KeyPermission => ({ repositoryId: r.id, repository: r.name, groupPrefix: null, access: "write" });
    const readOn = (r: Repo): KeyPermission => ({ repositoryId: r.id, repository: r.name, groupPrefix: null, access: "read" });
    const upstreamUrl = "https://upstream.invalid/api/v1/repos/remote";

    function createHosted(name: string, config: Partial<ProtoHostedConfig> = {}): Promise<Repo> {
      return repos.create(admin, { name, format: "proto", kind: "hosted", config });
    }

    function createMirror(name: string): Promise<Repo> {
      return repos.create(admin, { name, format: "proto", kind: "mirror", upstreams: [{ url: upstreamUrl, authType: "none" }] });
    }

    /** A registry whose validation accepts everything and records the dependency files of every publish. */
    function stubRegistry(): { registry: Registry; dependencyFiles: ProtoFile[][] } {
      const dependencyFiles: ProtoFile[][] = [];
      return {
        dependencyFiles,
        registry: createRegistry({
          db: testDb.db,
          stores,
          repos,
          validate: async (input) => {
            dependencyFiles.push(input.dependencyFiles);
            return [];
          },
        }),
      };
    }

    it("publish to a group is method_not_allowed", async () => {
      await createHosted("member");
      const group = await repos.create(admin, { name: "all", format: "proto", kind: "group", members: ["member"] });
      const err = await expectError(publishMoney(key("maintainer", [writeOn(group)], "key-group"), "all"), "method_not_allowed");
      expect(err.code).toBe("method_not_allowed");
      expect(err.status).toBe(405);
      expect(err.message).toBe("Repository all is a group; publish to a hosted repository");
    });

    it("publish to a proto mirror is method_not_allowed", async () => {
      const mirror = await createMirror("remote");
      const err = await expectError(publishMoney(key("maintainer", [writeOn(mirror)], "key-mirror"), "remote"), "method_not_allowed");
      expect(err.status).toBe(405);
      expect(err.message).toBe("Repository remote is a mirror; publish to a hosted repository");
    });

    it("deleteVersion on a group is method_not_allowed", async () => {
      await createHosted("member");
      const group = await repos.create(admin, { name: "all", format: "proto", kind: "group", members: ["member"] });
      const err = await expectError(
        registry.deleteVersion(key("admin", [writeOn(group)], "key-group-admin"), "all", coord("acme", "money", "1.0.0")),
        "method_not_allowed",
      );
      expect(err.status).toBe(405);
      await expectError(
        registry.deleteVersion({ kind: "user", userId: "u-admin", role: "admin" }, "all", coord("acme", "money", "1.0.0")),
        "method_not_allowed",
      );
    });

    it("hosted reads of a non-proto repo are not_found", async () => {
      await repos.create(admin, { name: "npm-hosted", format: "npm", kind: "hosted", visibility: "public" });
      await expectError(registry.listVersions(admin, "npm-hosted", "g", "n"), "not_found");
    });

    it("publish resolves dependencies from hosted repos by resolutionPriority", async () => {
      // Created, and named, against their priority order so neither decides the outcome.
      const high = await createHosted("high", { resolutionPriority: 10 });
      const low = await createHosted("low", { resolutionPriority: 5 });
      const target = await createHosted("target");
      await publishMoney(key("maintainer", [writeOn(high)], "key-high"), "high");
      await publishMoney(key("maintainer", [writeOn(low)], "key-low"), "low", "1.0.0", currencyMoney);

      const stub = stubRegistry();
      await stub.registry.publish(key("maintainer", [writeOn(target), readOn(high), readOn(low)], "key-target"), {
        repository: "target",
        manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0"]),
        archive: await packArchive(currencyOrder),
      });
      expect(stub.dependencyFiles).toEqual([currencyMoney]);
    });

    it("publish ignores mirrors", async () => {
      const mirror = await createMirror("remote");
      const target = await createHosted("target");
      const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new Error("upstream contacted")));
      const settings = (): Promise<ServerSettings> => Promise.resolve({ anonymousView: false, defaultCacheStore: "local" });
      const engine = createMirrorEngine({
        db: testDb.db,
        stores,
        repos,
        assets: createAssetService({ db: testDb.db, stores }),
        settings,
        fetchImpl,
      });

      const publisher = key("maintainer", [writeOn(target), readOn(mirror)], "key-target");
      const order = await publishRepositoryOrder(testDb.db, publisher, target);
      expect(order.map((r) => r.name)).not.toContain("remote");
      const err = await expectError(publishOrder(publisher, "target"), "validation_failed");
      expect(err.message).toBe("Dependency not found: acme:money:1.0.0");
      await engine.drain();
      expect(fetchImpl).toHaveBeenCalledTimes(0);
    });

    it("publish sees a hosted repo through a readable group", async () => {
      const hidden = await createHosted("private-hosted");
      const target = await createHosted("target");
      const group = await repos.create(admin, { name: "all", format: "proto", kind: "group", members: ["private-hosted"] });
      await publishMoney(key("maintainer", [writeOn(hidden)], "key-hidden"), "private-hosted");

      const result = await publishOrder(key("maintainer", [readOn(group), writeOn(target)], "key-target"), "target");
      expect(result.buildNumber).toBe(1);
    });

    it("publish sees a hosted repo through a group-prefix entry on a containing group, per coordinate", async () => {
      const hidden = await createHosted("private-hosted");
      const target = await createHosted("target");
      const group = await repos.create(admin, { name: "all", format: "proto", kind: "group", members: ["private-hosted"] });
      await publishMoney(key("maintainer", [writeOn(hidden)], "key-hidden"), "private-hosted");
      const prefixed = (prefix: string): KeyPermission => ({ ...readOn(group), groupPrefix: prefix });

      const err = await expectError(
        publishOrder(key("maintainer", [prefixed("other"), writeOn(target)], "key-other"), "target"),
        "validation_failed",
      );
      expect(err.message).toBe("Dependency not found: acme:money:1.0.0");
      const result = await publishOrder(key("maintainer", [prefixed("acme"), writeOn(target)], "key-acme"), "target");
      expect(result.buildNumber).toBe(1);
    });

    it("publish skips hosted repos the publisher cannot read", async () => {
      const hidden = await createHosted("private-hosted");
      const target = await createHosted("target");
      await repos.create(admin, { name: "all", format: "proto", kind: "group", members: ["private-hosted"] });
      await publishMoney(key("maintainer", [writeOn(hidden)], "key-hidden"), "private-hosted");

      const err = await expectError(publishOrder(key("maintainer", [writeOn(target)], "key-target"), "target"), "validation_failed");
      expect(err.message).toBe("Dependency not found: acme:money:1.0.0");
    });

    it("hosted.node returns the newest snapshot build without permission checks", async () => {
      const snapshot = coord("acme", "money", "1.0.0-SNAPSHOT");
      await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
      const second = await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT", currencyMoney);
      const repo = (await repos.get("snapshots"))!;

      const node = await registry.hosted.node(repo, snapshot);
      expect(node).toEqual({ coordinate: snapshot, repository: "snapshots", buildNumber: 2, sha256: second.sha256, dependencies: [] });
      expect((await registry.hosted.node(repo, snapshot, 1))?.buildNumber).toBe(1);
      expect(await registry.hosted.node(repo, coord("acme", "absent", "1.0.0"))).toBeNull();

      expect((await registry.hosted.versions(repo, "acme", "money")).map((v) => v.version)).toEqual(["1.0.0-SNAPSHOT"]);
      expect(await registry.hosted.versions(repo, "acme", "absent")).toEqual([]);
      expect((await registry.hosted.manifest(repo, snapshot))?.buildNumber).toBe(2);
      expect((await registry.hosted.manifest(repo, snapshot, { buildNumber: 1 }))?.buildNumber).toBe(1);
      expect(await registry.hosted.manifest(repo, coord("acme", "absent", "1.0.0"))).toBeNull();
    });

    it("hosted.archive counts one download", async () => {
      const published = await publishMoney();
      const repo = (await repos.get("releases"))!;
      const c = coord("acme", "money", "1.0.0");

      const archive = await registry.hosted.archive(repo, c);
      const [row] = await testDb.db.select().from(build);
      expect(archive).toMatchObject({ sha256: published.sha256, filename: "money-1.0.0.tar.gz", buildId: row!.id });
      expect(archive!.data.length).toBeGreaterThan(0);
      expect(row?.downloadCount).toBe(1);
      expect(await registry.hosted.archive(repo, c, { buildNumber: 2 })).toBeNull();
      expect((await testDb.db.select().from(build))[0]?.downloadCount).toBe(1);
    });
  });
});

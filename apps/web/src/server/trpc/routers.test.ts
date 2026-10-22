import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { ValkeyContainer, type StartedValkeyContainer } from "@testcontainers/valkey";
import { eq, sql } from "drizzle-orm";
import {
  createRegistry,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  type StoreSet,
  packArchive,
  type Principal,
  type ProtoFile,
  type Registry,
  type RepoService,
  type Role,
} from "@weaver/core";
import {
  apikey,
  asset,
  auditEvent,
  cleanupPolicy,
  component,
  dockerManifest,
  dockerTag,
  invite,
  npmPackage,
  protoBuild as build,
  repoPermission,
  repository,
  session,
  storageSnapshot,
  usageDaily,
  usageDailyToken,
  usageEvent,
  user,
  type Db,
} from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createQueue, producerConnection, type CleanupQueue } from "@weaver/jobs";
import { createAuth, type Auth, type AuthEnv } from "../auth";
import { API_KEY_PREFIX } from "./routers/keys";
import { appRouter, createCaller, type RouterInputs } from "./root";
import { createTrpcContext, INTERNAL_ERROR_MESSAGE, type TrpcContext } from "./init";

const BASE = "http://localhost:3000";

const authEnv: AuthEnv = {
  BETTER_AUTH_SECRET: "trpc-test-secret-trpc-test-secret-012345",
  BETTER_AUTH_URL: BASE,
  INITIAL_ADMIN: undefined,
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  DISCORD_CLIENT_ID: undefined,
  DISCORD_CLIENT_SECRET: undefined,
};

let testDb: Awaited<ReturnType<typeof startTestDb>>;
let db: Db;
let auth: Auth;
let registry: Registry;
let stores: StoreSet;
let repos: RepoService;
let blobDir: string;
let valkey: StartedValkeyContainer;
let liveQueue: CleanupQueue;
let deadQueue: CleanupQueue;

const people = { admin: "", maintainer: "", viewer: "" };
/** Ids of the fixture repositories, refreshed before every test. */
const repoIds = { shared: "", internal: "" };

const anonymous: Principal = { kind: "anonymous" };
const asUser = (userId: string, role: Role): Principal => ({ kind: "user", userId, role });
const admin = () => asUser(people.admin, "admin");
const maintainer = () => asUser(people.maintainer, "maintainer");
const viewer = () => asUser(people.viewer, "viewer");

/** A publishing key principal with write access to both fixture repositories. */
const publisher = (): Principal => ({
  kind: "apikey",
  keyId: "fixture-key",
  userId: people.maintainer,
  role: "admin",
  permissions: [
    { repositoryId: repoIds.shared, repository: "shared", groupPrefix: null, access: "write" },
    { repositoryId: repoIds.internal, repository: "internal", groupPrefix: null, access: "write" },
  ],
});

function contextFor(principal: Principal, overrides: Partial<TrpcContext> = {}): TrpcContext {
  return {
    db,
    registry,
    stores,
    repos,
    auth,
    principal,
    settings: { anonymousView: false, defaultCacheStore: "local" },
    publicUrl: BASE,
    cleanupQueue: () => liveQueue,
    ...overrides,
  };
}

function call(principal: Principal, overrides: Partial<TrpcContext> = {}) {
  return createCaller(contextFor(principal, overrides));
}

/** Format and kind of the proto fixture repositories. */
const protoHosted = { format: "proto", kind: "hosted" } as const;

const anonymousViewOn = { settings: { anonymousView: true, defaultCacheStore: "local" as const } };

async function createUser(role: string, name = `${role} user`) {
  const now = new Date();
  const [row] = await db
    .insert(user)
    .values({ id: randomUUID(), name, email: `${randomUUID()}@example.com`, role, createdAt: now, updatedAt: now })
    .returning();
  return row!;
}

function proto(path: string, body: string, imports: string[] = []): ProtoFile {
  const pkg = path.replace(/\/[^/]+$/, "").replaceAll("/", ".");
  const importLines = imports.map((i) => `import "${i}";`).join("\n");
  return { path, content: `syntax = "proto3";\npackage ${pkg};\n${importLines}\n${body}\n` };
}

const moneyFiles = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; }")];
const orderFiles = [
  proto("acme/order/v1/order.proto", "message Order { acme.money.v1.Money total = 1; }", ["acme/money/v1/money.proto"]),
];

async function publish(repository: string, coordinate: string, files: ProtoFile[], dependencies: string[] = []) {
  const [group, name, version] = coordinate.split(":") as [string, string, string];
  await registry.publish(publisher(), {
    repository,
    manifest: { group, name, version, dependencies },
    archive: await packArchive(files),
  });
}

/** The TRPCError `promise` rejects with; fails the test when it resolves. */
async function errorOf(promise: Promise<unknown>): Promise<TRPCError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return (error as TRPCError).code;
}

beforeAll(async () => {
  [testDb, valkey] = await Promise.all([startTestDb(), new ValkeyContainer("valkey/valkey:9.1.2-alpine").start()]);
  db = testDb.db;
  auth = createAuth(db, authEnv);
  blobDir = await mkdtemp(join(tmpdir(), "weaver-trpc-"));
  stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
  repos = createRepoService({ db, stores, secretKey: deriveSecretKey(authEnv.BETTER_AUTH_SECRET) });
  registry = createRegistry({ db, stores, repos });
  liveQueue = createQueue(producerConnection(valkey.getConnectionUrl()));
  deadQueue = createQueue(producerConnection("redis://127.0.0.1:1"), { onError: () => undefined });
});

afterAll(async () => {
  await Promise.all([liveQueue?.close(), deadQueue?.close().catch(() => undefined)]);
  await testDb?.stop();
  await valkey?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE repository, audit_event, invite, apikey, "user" CASCADE`);
  people.admin = (await createUser("admin", "Ada Admin")).id;
  people.maintainer = (await createUser("maintainer", "Max Maintainer")).id;
  people.viewer = (await createUser("viewer", "Vic Viewer")).id;
  await call(admin()).repositories.create({ ...protoHosted, name: "shared", visibility: "public", description: "Public contracts" });
  await call(admin()).repositories.create({ ...protoHosted, name: "internal", visibility: "private" });
  for (const row of await db.select({ id: repository.id, name: repository.name }).from(repository)) {
    if (row.name === "shared" || row.name === "internal") repoIds[row.name] = row.id;
  }
});

describe("createTrpcContext", () => {
  it("builds an anonymous context with the stored settings and the public URL", async () => {
    await call(admin()).settings.update({ anonymousView: true });
    const ctx = await createTrpcContext({ headers: new Headers() }, { db, registry, repos, auth, stores });
    expect(ctx.principal).toEqual({ kind: "anonymous" });
    expect(ctx.settings).toEqual({ anonymousView: true, defaultCacheStore: "local" });
    expect(ctx.publicUrl).toBe(BASE);
    await call(admin()).settings.update({ anonymousView: false });
  });

  it("refuses invalid credentials with UNAUTHORIZED", async () => {
    const context = createTrpcContext({ headers: new Headers({ authorization: "Bearer nope" }) }, { db, registry, repos, auth, stores });
    const error = await context.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("UNAUTHORIZED");
  });
});

describe("procedures", () => {
  it("refuses anonymous browsing while anonymous view is off", async () => {
    expect(await codeOf(call(anonymous).browse.repositories())).toBe("UNAUTHORIZED");
  });

  it("lets anonymous visitors browse only public repositories while anonymous view is on", async () => {
    const repos = await call(anonymous, anonymousViewOn).browse.repositories();
    expect(repos.map((r) => r.name)).toEqual(["shared"]);
    const all = await call(viewer()).browse.repositories();
    expect(all.map((r) => r.name)).toEqual(["internal", "shared"]);
  });

  it("requires a signed-in user for authed procedures and the role for maintainer and admin ones", async () => {
    expect(await codeOf(call(anonymous, anonymousViewOn).keys.list())).toBe("UNAUTHORIZED");
    expect(await codeOf(call(viewer()).repositories.create({ ...protoHosted, name: "mine" }))).toBe("FORBIDDEN");
    expect(await codeOf(call(viewer()).versions.delete({ repository: "shared", coordinate: "acme:money:1.0.0" }))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(call(maintainer()).users.list())).toBe("FORBIDDEN");
  });

  it("formats registry errors with their code and details over HTTP", async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    await publish("shared", "acme:order:1.0.0", orderFiles, ["acme:money:1.0.0"]);
    const res = await fetchRequestHandler({
      endpoint: "/api/trpc",
      router: appRouter,
      req: new Request(`${BASE}/api/trpc/versions.delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { repository: "shared", coordinate: "acme:money:1.0.0" } }),
      }),
      createContext: () => contextFor(maintainer()),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { json: { data: Record<string, unknown> } } };
    expect(body.error.json.data).toMatchObject({
      code: "CONFLICT",
      registry: {
        code: "has_dependents",
        details: { dependents: [{ repository: "shared", coordinate: "acme:order:1.0.0" }], hiddenDependents: 0 },
      },
    });
  });
});

describe("browse", () => {
  beforeEach(async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    await publish("shared", "acme:money:1.1.0", moneyFiles);
    await publish("shared", "acme:order:1.0.0", orderFiles, ["acme:money:1.0.0"]);
    await publish("internal", "corp.secret:vault:2.0.0", moneyFiles);
  });

  it("hides a private repository's versions from anonymous visitors as not found", async () => {
    const caller = call(anonymous, anonymousViewOn);
    expect(await codeOf(caller.browse.version({ repository: "internal", coordinate: "corp.secret:vault:2.0.0" }))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(caller.browse.artifacts({ repository: "internal" }))).toBe("NOT_FOUND");
  });

  it("returns a version with string coordinates and its readable dependents", async () => {
    const info = await call(anonymous, anonymousViewOn).browse.version({
      repository: "shared",
      coordinate: "acme:money:1.0.0",
    });
    expect(info).toMatchObject({
      repository: "shared",
      coordinate: "acme:money:1.0.0",
      buildNumber: 1,
      dependencies: [],
      files: ["acme/money/v1/money.proto"],
      dependents: [{ repository: "shared", coordinate: "acme:order:1.0.0" }],
    });
    expect(info.createdAt).toBeInstanceOf(Date);
    const order = await call(viewer()).browse.version({ repository: "shared", coordinate: "acme:order:1.0.0" });
    expect(order.dependencies).toEqual(["acme:money:1.0.0"]);
  });

  it("rejects a malformed coordinate as a bad request", async () => {
    expect(await codeOf(call(viewer()).browse.version({ repository: "shared", coordinate: "nope" }))).toBe("BAD_REQUEST");
  });

  it("lists artifacts and versions, and serves files", async () => {
    const caller = call(viewer());
    expect(await caller.browse.artifacts({ repository: "shared" })).toEqual([
      { group: "acme", name: "money", latestVersion: "1.1.0", versionCount: 2, updatedAt: expect.any(Date) },
      { group: "acme", name: "order", latestVersion: "1.0.0", versionCount: 1, updatedAt: expect.any(Date) },
    ]);
    expect((await caller.browse.artifacts({ repository: "shared", search: "ORD" })).map((a) => a.name)).toEqual(["order"]);
    const versions = await caller.browse.versions({ repository: "shared", group: "acme", name: "money" });
    expect(versions.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    const file = await caller.browse.file({
      repository: "shared",
      coordinate: "acme:money:1.0.0",
      path: "acme/money/v1/money.proto",
    });
    expect(file.content).toContain("message Money");
  });

  it("search.query returns only readable packages for a key-less session viewer", async () => {
    const labels = async (caller: ReturnType<typeof call>, q: string) =>
      (await caller.search.query({ q })).hits.map((h) => `${h.repository}/${h.label}`);
    expect(await labels(call(viewer()), "MONEY")).toEqual(["shared/acme:money"]);
    // "acme:ord" is also tried as "acme" (a trailing segment may be a version); the closer match ranks first.
    expect((await labels(call(viewer()), "acme:ord"))[0]).toBe("shared/acme:order");
    expect(await labels(call(viewer()), "corp.SEC")).toEqual(["internal/corp.secret:vault"]);
    expect(await labels(call(anonymous, anonymousViewOn), "vault")).toEqual([]);
    expect(await labels(call(anonymous, anonymousViewOn), "acme")).toEqual(["shared/acme:money", "shared/acme:order"]);
    expect((await call(viewer()).search.query({ q: "100%_" })).hits).toEqual([]);

    const page = await call(viewer()).search.query({ q: "acme", limit: 1 });
    expect(page.hasMore).toBe(true);
    expect(page.hits).toHaveLength(1);
    expect(page.hits[0]).toMatchObject({ repository: "shared", via: null, format: "proto", kind: "hosted", latestVersion: expect.any(String) });
    // Hits name the repository, never its config or id.
    expect(Object.keys(page.hits[0]!).sort()).toEqual(
      ["downloads", "format", "kind", "label", "latestVersion", "name", "namespace", "repository", "updatedAt", "versionCount", "via"].sort(),
    );
    expect((await call(viewer()).search.query({ q: "money", format: "maven" })).hits).toEqual([]);
  });

  it("search.query: anonymous with anonymousView off → UNAUTHORIZED", async () => {
    expect(await codeOf(call(anonymous).search.query({ q: "money" }))).toBe("UNAUTHORIZED");
  });

  it("search.query: q of one character → BAD_REQUEST", async () => {
    expect(await codeOf(call(viewer()).search.query({ q: "m" }))).toBe("BAD_REQUEST");
    expect(await codeOf(call(viewer()).search.query({ q: " : " }))).toBe("BAD_REQUEST");
    expect(await codeOf(call(viewer()).search.query({ q: "money", limit: 51 }))).toBe("BAD_REQUEST");
  });

  it("scopes dashboard stats to what the caller can see", async () => {
    const all = await call(viewer()).dashboard.stats();
    expect(all).toMatchObject({ repositories: 2, artifacts: 3, versions: 4 });
    expect(all.recentPublishes[0]).toMatchObject({ repository: "internal", coordinate: "corp.secret:vault:2.0.0" });
    const visible = await call(anonymous, anonymousViewOn).dashboard.stats();
    expect(visible).toMatchObject({ repositories: 1, artifacts: 2, versions: 3 });
    expect(visible.recentPublishes.map((p) => p.repository)).not.toContain("internal");
  });

  it("shows the publisher's name, and no raw user id once the user is deleted", async () => {
    const before = await call(viewer()).dashboard.stats();
    expect(before.recentPublishes[0]?.publishedBy).toBe("Max Maintainer");
    const version = { repository: "shared", coordinate: "acme:money:1.0.0" };
    expect((await call(viewer()).browse.version(version)).publishedBy).toBe("Max Maintainer");

    await db.update(build).set({ publishedByUserId: "deleted-user-id" });
    const after = await call(viewer()).dashboard.stats();
    expect(after.recentPublishes.map((p) => p.publishedBy)).toEqual(after.recentPublishes.map(() => null));
    expect((await call(viewer()).browse.version(version)).publishedBy).toBeNull();
  });
});

describe("versions.delete", () => {
  it("deletes through the registry and reports dependents as a conflict", async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    await publish("shared", "acme:order:1.0.0", orderFiles, ["acme:money:1.0.0"]);
    expect(await codeOf(call(maintainer()).versions.delete({ repository: "shared", coordinate: "acme:money:1.0.0" }))).toBe(
      "CONFLICT",
    );
    expect(
      await codeOf(call(maintainer()).versions.delete({ repository: "shared", coordinate: "acme:money:1.0.0", force: true })),
    ).toBe("FORBIDDEN");
    await call(admin()).versions.delete({ repository: "shared", coordinate: "acme:money:1.0.0", force: true });
    expect(await codeOf(call(admin()).browse.version({ repository: "shared", coordinate: "acme:money:1.0.0" }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("keys", () => {
  it("refuses write entries for a viewer", async () => {
    const create = call(viewer()).keys.create({
      name: "ci",
      permissions: [{ repository: "shared", groupPrefix: null, access: "write" }],
    });
    expect(await codeOf(create)).toBe("FORBIDDEN");
    expect(await db.select().from(apikey)).toEqual([]);
  });

  it("creates a key once with its secret and never lists the secret", async () => {
    const created = await call(maintainer()).keys.create({
      name: "ci",
      expiresInDays: 30,
      permissions: [
        { repository: "shared", groupPrefix: "acme", access: "write" },
        { repository: "internal", access: "read" },
      ],
    });
    expect(created.key.startsWith(API_KEY_PREFIX)).toBe(true);

    const listed = await call(maintainer()).keys.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      name: "ci",
      userId: people.maintainer,
      ownerName: "Max Maintainer",
      permissions: expect.arrayContaining([
        { repositoryId: repoIds.shared, repository: "shared", groupPrefix: "acme", access: "write" },
        { repositoryId: repoIds.internal, repository: "internal", groupPrefix: null, access: "read" },
      ]),
    });
    expect(listed[0]!.expiresAt).toBeInstanceOf(Date);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect(listed[0]).not.toHaveProperty("key");

    // The key works against the REST principal resolution with its permissions.
    const verified = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(verified.valid).toBe(true);
    const [audit] = await db.select().from(auditEvent).where(eq(auditEvent.action, "key.create"));
    expect(audit).toMatchObject({ actorType: "user", actorId: people.maintainer, target: created.id });
  });

  it("rejects unknown repositories", async () => {
    const create = call(maintainer()).keys.create({
      name: "ci",
      permissions: [{ repository: "ghost", access: "read" }],
    });
    expect(await codeOf(create)).toBe("BAD_REQUEST");
    expect(await db.select().from(apikey)).toEqual([]);
  });

  it("rejects entries that can never grant anything", async () => {
    await call(admin()).repositories.create({ name: "libs", format: "maven", kind: "hosted" });
    await call(admin()).repositories.create({ name: "protos", format: "proto", kind: "group", members: ["shared"] });
    const write = call(maintainer()).keys.create({ name: "ci", permissions: [{ repository: "protos", access: "write" }] });
    await expect(write).rejects.toThrow(/protos is a group/);
    expect(await codeOf(call(maintainer()).keys.create({ name: "ci", permissions: [{ repository: "protos", access: "write" }] }))).toBe(
      "BAD_REQUEST",
    );
    for (const repo of ["libs", "protos"]) {
      const prefix = call(maintainer()).keys.create({ name: "ci", permissions: [{ repository: repo, groupPrefix: "acme", access: "read" }] });
      await expect(prefix).rejects.toThrow(/group prefix/i);
    }
    expect(await db.select().from(apikey)).toEqual([]);
    await call(maintainer()).keys.create({ name: "ok", permissions: [{ repository: "protos", access: "read" }] });
  });

  it("deletes the Better Auth key again when storing its permissions fails", async () => {
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("insert failed"));
    try {
      const create = call(maintainer()).keys.create({ name: "ci", permissions: [{ repository: "shared", access: "read" }] });
      await expect(create).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await db.select().from(apikey)).toEqual([]);
  });

  it("lets owners revoke their keys, and admins list and revoke all keys", async () => {
    const own = await call(maintainer()).keys.create({ name: "mine", permissions: [{ repository: "shared", access: "read" }] });
    const other = await call(viewer()).keys.create({ name: "theirs", permissions: [{ repository: "shared", access: "read" }] });

    expect((await call(viewer()).keys.list()).map((k) => k.name)).toEqual(["theirs"]);
    expect(await codeOf(call(viewer()).keys.list({ all: true }))).toBe("FORBIDDEN");
    expect((await call(admin()).keys.list({ all: true })).map((k) => k.name).sort()).toEqual(["mine", "theirs"]);

    expect(await codeOf(call(viewer()).keys.revoke({ id: own.id }))).toBe("NOT_FOUND");
    await call(maintainer()).keys.revoke({ id: own.id });
    await call(admin()).keys.revoke({ id: other.id });
    expect(await db.select().from(apikey)).toEqual([]);
    expect(await db.select().from(repoPermission)).toEqual([]);
  });
});

describe("repositories", () => {
  const npmMirror: RouterInputs["repositories"]["create"] = {
    name: "npmjs",
    format: "npm",
    kind: "mirror",
    upstreams: [{ url: "https://registry.npmjs.org", authType: "bearer", secret: "s3cret" }],
  };

  it("creates repositories for admins only, filling in the defaults", async () => {
    expect(await codeOf(call(maintainer()).repositories.create(npmMirror))).toBe("FORBIDDEN");
    const mirror = await call(admin()).repositories.create(npmMirror);
    expect(mirror).toMatchObject({
      name: "npmjs",
      format: "npm",
      kind: "mirror",
      visibility: "private",
      description: null,
      dockerRoot: false,
      config: {
        cache: { enabled: false, store: null, metadataTtlSeconds: 1800, maxAgeDays: null, maxSizeBytes: null },
        offline: false,
        rules: { allow: [], deny: [] },
      },
    });
    const maven = await call(admin()).repositories.create({ name: "libs", format: "maven", kind: "hosted" });
    expect(maven.config).toEqual({ versionPolicy: "mixed", redeploy: false });
    expect(JSON.stringify(await call(admin()).repositories.upstreams({ name: "npmjs" }))).not.toContain("s3cret");
  });

  it("refuses taken and invalid names and invalid kind input", async () => {
    const caller = call(admin());
    expect(await codeOf(caller.repositories.create({ ...protoHosted, name: "shared" }))).toBe("CONFLICT");
    expect(await codeOf(caller.repositories.create({ name: "npmjs", format: "npm", kind: "shared" as "hosted" }))).toBe("BAD_REQUEST");
    expect(await codeOf(caller.repositories.create({ ...protoHosted, name: "Bad Name" }))).toBe("BAD_REQUEST");
    expect(await codeOf(caller.repositories.create({ name: "m", format: "maven", kind: "mirror" }))).toBe("BAD_REQUEST");
  });

  it("lists repositories with their asset counts and sizes, and reads one", async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    const caller = call(admin());
    const list = await caller.repositories.list();
    expect(list.map((r) => r.name)).toEqual(["internal", "shared"]);
    expect(list.find((r) => r.name === "internal")).toMatchObject({ format: "proto", kind: "hosted", assetCount: 0, storageBytes: 0 });
    const shared = list.find((r) => r.name === "shared")!;
    expect(shared.assetCount).toBe(1);
    expect(shared.storageBytes).toBeGreaterThan(0);
    expect(await caller.repositories.get({ name: "shared" })).toMatchObject({
      name: "shared",
      assetCount: 1,
      policyCount: 0,
      artifactCount: 1,
    });
    expect(await codeOf(caller.repositories.get({ name: "ghost" }))).toBe("NOT_FOUND");
    expect(await codeOf(call(maintainer()).repositories.list())).toBe("FORBIDDEN");
  });

  it("updates with a patch, deep-merging the config and auditing", async () => {
    const caller = call(admin());
    const updated = await caller.repositories.update({
      name: "internal",
      patch: { config: { allowRedeploy: true, resolutionPriority: 5 } },
    });
    expect(updated).toMatchObject({
      name: "internal",
      visibility: "private",
      config: { allowRedeploy: true, allowReleases: true, resolutionPriority: 5 },
    });
    await caller.repositories.create(npmMirror);
    const cached = await caller.repositories.update({ name: "npmjs", patch: { config: { cache: { enabled: true } } } });
    expect(cached.config).toMatchObject({ cache: { enabled: true, metadataTtlSeconds: 1800 } });
    expect(await codeOf(caller.repositories.update({ name: "ghost", patch: { visibility: "public" } }))).toBe("NOT_FOUND");
    const actions = (await db.select({ action: auditEvent.action }).from(auditEvent)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["repository.create", "repository.update"]));
  });

  it("keeps an upstream's stored secret when the update omits it", async () => {
    const caller = call(admin());
    await caller.repositories.create(npmMirror);
    await caller.repositories.update({
      name: "npmjs",
      patch: {
        upstreams: [
          { url: "https://mirror.example.com/npm", authType: "none" },
          { url: "https://registry.npmjs.org", authType: "bearer" },
        ],
      },
    });
    const upstreams = await caller.repositories.upstreams({ name: "npmjs" });
    expect(upstreams).toEqual([
      expect.objectContaining({ url: "https://mirror.example.com/npm", authType: "none", hasSecret: false }),
      expect.objectContaining({ url: "https://registry.npmjs.org", authType: "bearer", hasSecret: true }),
    ]);
    const [, kept] = await repos.upstreamsWithSecrets((await repos.get("npmjs"))!.id);
    expect(kept!.secret).toBe("s3cret");
  });

  it("lists group members in order and offers only hosted and mirror repos of the format as candidates", async () => {
    const caller = call(admin());
    await caller.repositories.create(npmMirror);
    await caller.repositories.create({ name: "npm-local", format: "npm", kind: "hosted" });
    await caller.repositories.create({ name: "maven-local", format: "maven", kind: "hosted" });
    await caller.repositories.create({ name: "npm-all", format: "npm", kind: "group", members: ["npmjs", "npm-local"] });
    expect((await caller.repositories.members({ name: "npm-all" })).map((r) => r.name)).toEqual(["npmjs", "npm-local"]);
    expect((await caller.repositories.candidates({ format: "npm" })).map((r) => r.name)).toEqual(["npm-local", "npmjs"]);
    expect((await caller.repositories.candidates({ format: "proto" })).map((r) => r.name)).toEqual(["internal", "shared"]);
    expect(await codeOf(caller.repositories.members({ name: "npmjs" }))).toBe("BAD_REQUEST");
    expect(await codeOf(caller.repositories.upstreams({ name: "npm-all" }))).toBe("BAD_REQUEST");
    expect(await codeOf(call(maintainer()).repositories.candidates({ format: "npm" }))).toBe("FORBIDDEN");
  });

  it("refuses to delete a proto repository that still has artifacts, and deletes other formats with their content", async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    expect(await codeOf(call(admin()).repositories.delete({ name: "shared" }))).toBe("PRECONDITION_FAILED");
    await call(admin()).repositories.delete({ name: "internal" });
    await call(admin()).repositories.create({ name: "libs", format: "maven", kind: "hosted" });
    const [libs] = await db.select({ id: repository.id }).from(repository).where(eq(repository.name, "libs"));
    await db.insert(asset).values({
      repositoryId: libs!.id,
      path: "a.jar",
      store: "local",
      storageKey: "libs/a.jar",
      size: 3,
      origin: "hosted",
      md5: "m",
      sha1: "s1",
      sha256: "s256",
      sha512: "s512",
    });
    await call(admin()).repositories.delete({ name: "libs" });
    expect((await call(admin()).repositories.list()).map((r) => r.name)).toEqual(["shared"]);
  });

});

describe("browse by format", () => {
  it("lists format and kind, reads a repository, and serves proto listings only for proto repositories", async () => {
    await call(admin()).repositories.create({ name: "libs", format: "maven", kind: "hosted" });
    const listed = await call(viewer()).browse.repositories();
    expect(listed.find((r) => r.name === "libs")).toMatchObject({ format: "maven", kind: "hosted", artifactCount: 0 });
    expect(listed.find((r) => r.name === "shared")).toMatchObject({ format: "proto", kind: "hosted" });
    expect(await call(viewer()).browse.repository({ name: "libs" })).toMatchObject({ name: "libs", format: "maven" });
    expect(await codeOf(call(anonymous, anonymousViewOn).browse.repository({ name: "internal" }))).toBe("NOT_FOUND");
    expect(await codeOf(call(viewer()).browse.artifacts({ repository: "libs" }))).toBe("BAD_REQUEST");
  });
});

describe("proto browse by kind", () => {
  const upstreamUrl = "https://protos.example.com/api/v1";

  /** Creates the public proto mirror `upstream-protos`, caching or not, and returns its id. */
  async function createMirror(caching: boolean) {
    await call(admin()).repositories.create({
      name: "upstream-protos",
      format: "proto",
      kind: "mirror",
      visibility: "public",
      upstreams: [
        { url: upstreamUrl, authType: "none" },
        { url: "https://fallback.example.com/api/v1", authType: "none" },
      ],
      config: { cache: { enabled: caching }, rules: { deny: ["secret.*"] } },
    });
    const [row] = await db.select({ id: repository.id }).from(repository).where(eq(repository.name, "upstream-protos"));
    return row!.id;
  }

  /** Inserts a cached asset of the mirror at `path`, linked to the component of `coordinate`. */
  async function cached(
    repoId: string,
    path: string,
    coordinate: string,
    opts: { lastAccessedAt: Date | null; expiresAt?: Date | null; size?: number },
  ) {
    const [namespace, name, version] = coordinate.split(":") as [string, string, string];
    const [comp] = await db.insert(component).values({ repositoryId: repoId, namespace, name, version }).onConflictDoNothing().returning();
    await db.insert(asset).values({
      repositoryId: repoId,
      componentId: comp?.id ?? null,
      path,
      store: "local",
      storageKey: `k/${randomUUID()}`,
      size: opts.size ?? 100,
      md5: "m",
      sha1: "s1",
      sha256: "s256",
      sha512: "s512",
      origin: "cache",
      expiresAt: opts.expiresAt ?? null,
      lastAccessedAt: opts.lastAccessedAt,
    });
  }

  it("protoCache lists cached archives of a caching mirror", async () => {
    const id = await createMirror(true);
    await cached(id, "artifacts/acme/money/1.0.0/archive", "acme:money:1.0.0", { lastAccessedAt: new Date("2026-10-01T00:00:00Z"), size: 321 });
    await cached(id, "artifacts/acme/money/1.1.0-SNAPSHOT/archive?build=2", "acme:money:1.1.0-SNAPSHOT", {
      lastAccessedAt: new Date("2026-10-20T00:00:00Z"),
      expiresAt: new Date("2026-10-20T00:30:00Z"),
    });
    // Manifests and version lists are cached too, but only archives are listed.
    await cached(id, "artifacts/acme/money/1.0.0", "acme:money:1.0.0", { lastAccessedAt: new Date("2026-10-21T00:00:00Z"), expiresAt: new Date() });
    await cached(id, "artifacts/acme/money", "acme:money:", { lastAccessedAt: new Date("2026-10-21T00:00:00Z"), expiresAt: new Date() });
    await cached(id, "artifacts/acme/order/2.0.0/archive", "acme:order:2.0.0", { lastAccessedAt: null });

    const listing = await call(viewer()).browse.protoCache({ repository: "upstream-protos" });
    expect(listing).toEqual({
      caching: true,
      upstream: null,
      items: [
        { coordinate: "acme:money:1.1.0-SNAPSHOT", buildNumber: 2, size: 100, lastAccessedAt: new Date("2026-10-20T00:00:00Z"), cache: "metadata" },
        { coordinate: "acme:money:1.0.0", buildNumber: null, size: 321, lastAccessedAt: new Date("2026-10-01T00:00:00Z"), cache: "immutable" },
        { coordinate: "acme:order:2.0.0", buildNumber: null, size: 100, lastAccessedAt: null, cache: "immutable" },
      ],
    });
    expect(JSON.stringify(listing)).not.toContain("secret.*");
    expect(await codeOf(call(viewer()).browse.protoCache({ repository: "shared" }))).toBe("BAD_REQUEST");
  });

  it("protoCache reports caching false and the first upstream url when caching is off", async () => {
    await createMirror(false);
    expect(await call(admin()).browse.protoCache({ repository: "upstream-protos" })).toEqual({ caching: false, upstream: upstreamUrl, items: [] });
    // Upstream URLs are admin-only, like the rest of the mirror config.
    for (const caller of [call(viewer()), call(anonymous, anonymousViewOn)]) {
      expect(await caller.browse.protoCache({ repository: "upstream-protos" })).toEqual({ caching: false, upstream: null, items: [] });
    }
  });

  it("protoMembers returns members in group order", async () => {
    await createMirror(false);
    await call(admin()).repositories.create({
      name: "all",
      format: "proto",
      kind: "group",
      visibility: "public",
      members: ["upstream-protos", "internal", "shared"],
    });
    expect(await call(viewer()).browse.protoMembers({ repository: "all" })).toEqual([
      { name: "upstream-protos", kind: "mirror", visibility: "public" },
      { name: "internal", kind: "hosted", visibility: "private" },
      { name: "shared", kind: "hosted", visibility: "public" },
    ]);
    // Visitors only see the members they could browse themselves.
    expect((await call(anonymous, anonymousViewOn).browse.protoMembers({ repository: "all" })).map((m) => m.name)).toEqual([
      "upstream-protos",
      "shared",
    ]);
    expect(await codeOf(call(viewer()).browse.protoMembers({ repository: "shared" }))).toBe("BAD_REQUEST");
  });

  it("browse.versions on a proto mirror is NOT_FOUND", async () => {
    await createMirror(true);
    await call(admin()).repositories.create({ name: "all", format: "proto", kind: "group", members: ["shared"] });
    const caller = call(admin());
    for (const repository of ["upstream-protos", "all"]) {
      expect(await codeOf(caller.browse.versions({ repository, group: "acme", name: "money" }))).toBe("NOT_FOUND");
      expect(await codeOf(caller.browse.artifacts({ repository }))).toBe("NOT_FOUND");
      expect(await codeOf(caller.browse.version({ repository, coordinate: "acme:money:1.0.0" }))).toBe("NOT_FOUND");
      expect(await codeOf(caller.browse.file({ repository, coordinate: "acme:money:1.0.0", path: "a.proto" }))).toBe("NOT_FOUND");
    }
  });
});

describe("maven", () => {
  /** Inserts a component with one asset per file name below its version directory. */
  async function deploy(repo: string, groupId: string, artifactId: string, version: string, files: string[]) {
    const [row] = await db.select({ id: repository.id }).from(repository).where(eq(repository.name, repo));
    const [comp] = await db.insert(component).values({ repositoryId: row!.id, namespace: groupId, name: artifactId, version }).returning();
    for (const file of files) {
      await db.insert(asset).values({
        repositoryId: row!.id,
        componentId: comp!.id,
        path: `${groupId.replaceAll(".", "/")}/${artifactId}/${version}/${file}`,
        store: "local",
        storageKey: `k/${randomUUID()}`,
        size: 10,
        contentType: "application/java-archive",
        md5: "m",
        sha1: "s1",
        sha256: "s256",
        sha512: "s512",
        origin: "hosted",
      });
    }
  }

  beforeEach(async () => {
    await call(admin()).repositories.create({ name: "releases", format: "maven", kind: "hosted", visibility: "private" });
    await call(admin()).repositories.create({ name: "pub", format: "maven", kind: "hosted", visibility: "public" });
  });

  it("artifacts lists components of a hosted maven repo", async () => {
    await deploy("releases", "org.example", "lib", "1.0", ["lib-1.0.jar"]);
    await deploy("releases", "org.example", "lib", "1.10", ["lib-1.10.jar"]);
    await deploy("releases", "com.acme", "app", "2.0", ["app-2.0.jar"]);
    const all = await call(viewer()).maven.artifacts({ repository: "releases" });
    expect(all.map((a) => `${a.groupId}:${a.artifactId}:${a.latestVersion}:${a.versionCount}`)).toEqual(["com.acme:app:2.0:1", "org.example:lib:1.10:2"]);
    expect(all[0]!.updatedAt).toBeInstanceOf(Date);
    const filtered = await call(viewer()).maven.artifacts({ repository: "releases", groupPrefix: "org." });
    expect(filtered.map((a) => a.artifactId)).toEqual(["lib"]);
    expect(await codeOf(call(viewer()).maven.artifacts({ repository: "shared" }))).toBe("BAD_REQUEST");
  });

  it("versions sorted newest first", async () => {
    for (const v of ["1.0", "1.9", "1.10-SNAPSHOT", "1.10"]) await deploy("releases", "org.example", "lib", v, [`lib-${v}.jar`]);
    const versions = await call(viewer()).maven.versions({ repository: "releases", groupId: "org.example", artifactId: "lib" });
    expect(versions.map((v) => v.version)).toEqual(["1.10", "1.10-SNAPSHOT", "1.9", "1.0"]);
    expect(versions.find((v) => v.version === "1.10-SNAPSHOT")!.snapshot).toBe(true);
  });

  it("files lists assets of a version with download urls", async () => {
    await deploy("releases", "org.example", "lib", "1.0", ["lib-1.0.jar", "lib-1.0.pom"]);
    const files = await call(viewer()).maven.files({ repository: "releases", groupId: "org.example", artifactId: "lib", version: "1.0" });
    expect(files.map((f) => f.name)).toEqual(["lib-1.0.jar", "lib-1.0.pom"]);
    expect(files[0]).toMatchObject({ size: 10, sha1: "s1", url: `${BASE}/maven/releases/org/example/lib/1.0/lib-1.0.jar` });
  });

  it("browse.repository hides config from non-admins and gives it to admins", async () => {
    await call(admin()).repositories.create({
      name: "central",
      format: "maven",
      kind: "mirror",
      visibility: "public",
      upstreams: [{ url: "https://repo.example.org/maven2/", authType: "none" }],
      config: { rules: { deny: ["secret.*"] } },
    });
    for (const caller of [call(viewer()), call(anonymous, anonymousViewOn)]) {
      const repo = await caller.browse.repository({ name: "central" });
      expect(repo).toMatchObject({ name: "central", kind: "mirror", cacheEnabled: false });
      expect(repo).not.toHaveProperty("config");
      expect(repo).not.toHaveProperty("upstreams");
      expect(JSON.stringify(repo)).not.toContain("secret.*");
    }
    const full = await call(admin()).browse.repository({ name: "central" });
    expect(full.config).toMatchObject({ rules: { deny: ["secret.*"] } });
  });

  it("overview of a group lists only members the caller can browse", async () => {
    await call(admin()).repositories.create({ name: "grp2", format: "maven", kind: "group", visibility: "public", members: ["pub", "releases"] });
    const anon = call(anonymous, anonymousViewOn);
    expect((await anon.maven.overview({ repository: "grp2" })).members).toEqual(["pub"]);
    expect((await call(viewer()).maven.overview({ repository: "grp2" })).members).toEqual(["pub", "releases"]);
  });

  it("artifacts finds a permitted group past 500 other groups for a prefix-limited key", async () => {
    const [row] = await db.select({ id: repository.id }).from(repository).where(eq(repository.name, "releases"));
    await db.insert(component).values(
      Array.from({ length: 510 }, (_, i) => ({ repositoryId: row!.id, namespace: `aaa.g${String(i).padStart(4, "0")}`, name: "x", version: "1" })),
    );
    await deploy("releases", "zzz.mine", "lib", "1", []);
    const key: Principal = {
      kind: "apikey",
      keyId: "k",
      userId: people.maintainer,
      role: "admin",
      permissions: [{ repositoryId: row!.id, repository: "releases", groupPrefix: "zzz", access: "read" }],
    };
    expect((await call(key).maven.artifacts({ repository: "releases" })).map((a) => a.groupId)).toEqual(["zzz.mine"]);
  });

  it("anonymous cannot browse a private maven repo", async () => {
    await deploy("releases", "org.example", "lib", "1.0", ["lib-1.0.jar"]);
    expect(await codeOf(call(anonymous, anonymousViewOn).maven.artifacts({ repository: "releases" }))).toBe("NOT_FOUND");
    expect(await codeOf(call(anonymous, anonymousViewOn).maven.overview({ repository: "releases" }))).toBe("NOT_FOUND");
    await deploy("pub", "org.example", "open", "1.0", ["open-1.0.jar"]);
    expect(await call(anonymous, anonymousViewOn).maven.artifacts({ repository: "pub" })).toHaveLength(1);
  });

  it("overview of a group lists members in order and exposes no mirror config", async () => {
    await call(admin()).repositories.create({ name: "grp", format: "maven", kind: "group", members: ["pub", "releases"] });
    await call(admin()).repositories.create({
      name: "central",
      format: "maven",
      kind: "mirror",
      upstreams: [{ url: "https://repo.example.org/maven2/", authType: "none" }],
      config: { rules: { deny: ["secret.*"] } },
    });
    await deploy("releases", "org.example", "lib", "1.0", ["lib-1.0.jar"]);
    const overview = await call(viewer()).maven.overview({ repository: "grp" });
    expect(overview).toEqual({ kind: "group", members: ["pub", "releases"], cacheEnabled: null, versionPolicy: null });
    expect((await call(viewer()).maven.artifacts({ repository: "grp" })).map((a) => a.artifactId)).toEqual(["lib"]);
    const mirror = await call(viewer()).maven.overview({ repository: "central" });
    expect(mirror).toEqual({ kind: "mirror", members: [], cacheEnabled: false, versionPolicy: null });
    expect(await call(viewer()).maven.overview({ repository: "releases" })).toMatchObject({ kind: "hosted", versionPolicy: "mixed" });
  });
});

describe("docker", () => {
  /** Stores an image manifest of `image` in `repo` directly, tagged `tag`; resolves to its digest. */
  async function storeImage(repo: string, image: string, tag: string) {
    const [row] = await db.select({ id: repository.id }).from(repository).where(eq(repository.name, repo));
    const content = Buffer.from(JSON.stringify({ schemaVersion: 2, image, tag }));
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const [manifest] = await db
      .insert(dockerManifest)
      .values({
        repositoryId: row!.id,
        image,
        digest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        artifactType: "application/vnd.oci.image.config.v1+json",
        platforms: [{ os: "linux", architecture: "amd64" }],
        size: content.length,
        totalSize: 1000,
        content,
      })
      .returning();
    await db.insert(dockerTag).values({ repositoryId: row!.id, image, tag, manifestId: manifest!.id });
    return digest;
  }

  beforeEach(async () => {
    await call(admin()).repositories.create({ name: "images", format: "docker", kind: "hosted", visibility: "private" });
    await call(admin()).repositories.create({ name: "pubimages", format: "docker", kind: "hosted", visibility: "public" });
  });

  it("docker.images is NOT_FOUND for a private repo and anonymous caller", async () => {
    await storeImage("images", "web", "latest");
    const anon = call(anonymous, anonymousViewOn);
    expect(await codeOf(anon.docker.images({ repo: "images" }))).toBe("NOT_FOUND");
    expect(await codeOf(anon.docker.tags({ repo: "images", image: "web" }))).toBe("NOT_FOUND");
    expect(await codeOf(anon.docker.manifest({ repo: "images", image: "web", digest: `sha256:${"0".repeat(64)}` }))).toBe("NOT_FOUND");
    expect(await codeOf(call(viewer()).docker.images({ repo: "shared" }))).toBe("BAD_REQUEST");
  });

  it("returns images for a reader", async () => {
    const digest = await storeImage("images", "web", "latest");
    await storeImage("images", "api", "1.0");
    const images = await call(viewer()).docker.images({ repo: "images" });
    expect(images.items.map((i) => i.image)).toEqual(["api", "web"]);
    expect(images.next).toBeNull();
    expect((await call(viewer()).docker.images({ repo: "images", query: "we" })).items.map((i) => i.image)).toEqual(["web"]);
    const tags = await call(viewer()).docker.tags({ repo: "images", image: "web" });
    expect(tags).toEqual([expect.objectContaining({ tag: "latest", digest, platforms: [{ os: "linux", architecture: "amd64" }] })]);
    const detail = await call(viewer()).docker.manifest({ repo: "images", image: "web", digest });
    expect(detail).toMatchObject({ digest, artifactType: null, tags: ["latest"] });
    expect(await call(viewer()).docker.manifest({ repo: "images", image: "web", digest: `sha256:${"0".repeat(64)}` })).toBeNull();
    await storeImage("pubimages", "open", "latest");
    expect((await call(anonymous, anonymousViewOn).docker.images({ repo: "pubimages" })).items).toHaveLength(1);
  });

  it("overview lists browsable group members and exposes no mirror config", async () => {
    await call(admin()).repositories.create({ name: "imggroup", format: "docker", kind: "group", visibility: "public", members: ["pubimages", "images"] });
    await call(admin()).repositories.create({
      name: "hub",
      format: "docker",
      kind: "mirror",
      upstreams: [{ url: "https://registry-1.docker.io/", authType: "none" }],
      config: { rules: { deny: ["secret/*"] } },
    });
    expect(await call(anonymous, anonymousViewOn).docker.overview({ repo: "imggroup" })).toEqual({ kind: "group", members: ["pubimages"], cacheEnabled: null });
    expect((await call(viewer()).docker.overview({ repo: "imggroup" })).members).toEqual(["pubimages", "images"]);
    const mirror = await call(viewer()).docker.overview({ repo: "hub" });
    expect(mirror).toEqual({ kind: "mirror", members: [], cacheEnabled: false });
    expect(JSON.stringify(mirror)).not.toContain("secret");
    expect(await call(viewer()).docker.images({ repo: "imggroup" })).toEqual({ items: [], next: null });
  });
});

describe("policies", () => {
  beforeEach(async () => {
    for (let i = 0; i < 3; i++) await publish("shared", "acme:money:1.0.0-SNAPSHOT", moneyFiles);
  });

  it("previews candidates without deleting anything", async () => {
    const caller = call(admin());
    const policy = await caller.policies.upsert({ repository: "shared", kind: "keep_last_snapshot_builds", value: 1 });
    expect(policy).toMatchObject({ kind: "keep_last_snapshot_builds", value: 1, enabled: true, groupPrefix: null });
    expect(await caller.policies.list({ repository: "shared" })).toHaveLength(1);

    const candidates = await caller.policies.preview({ repository: "shared" });
    expect(candidates).toEqual([
      expect.objectContaining({
        repository: "shared",
        key: "proto:acme:money:1.0.0-SNAPSHOT#1",
        label: "acme:money:1.0.0-SNAPSHOT build 1",
      }),
      expect.objectContaining({
        repository: "shared",
        key: "proto:acme:money:1.0.0-SNAPSHOT#2",
        label: "acme:money:1.0.0-SNAPSHOT build 2",
      }),
    ]);
    expect(await db.select().from(build)).toHaveLength(3);
  });

  it("preview returns label and reason from the format cleanup", async () => {
    const caller = call(admin());
    await caller.policies.upsert({ repository: "shared", kind: "keep_last_snapshot_builds", value: 2 });
    expect(await caller.policies.preview({ repository: "shared" })).toEqual([
      {
        repository: "shared",
        key: "proto:acme:money:1.0.0-SNAPSHOT#1",
        label: "acme:money:1.0.0-SNAPSHOT build 1",
        reason: "keep last 2 snapshot builds",
      },
    ]);
  });

  it("kinds returns the format's kinds", async () => {
    const caller = call(admin());
    await caller.repositories.create({ name: "images", format: "docker", kind: "hosted" });
    await caller.repositories.create({ name: "pkgs", format: "npm", kind: "hosted" });
    await caller.repositories.create({ name: "libs", format: "maven", kind: "hosted" });
    expect(await caller.policies.kinds({ repository: "images" })).toEqual([
      "delete_untagged_manifests",
      "keep_last_tags",
      "delete_not_downloaded",
    ]);
    expect(await caller.policies.kinds({ repository: "pkgs" })).toEqual(["delete_not_downloaded", "keep_last_versions"]);
    for (const repository of ["libs", "shared"]) {
      expect(await caller.policies.kinds({ repository })).toEqual([
        "keep_last_snapshot_builds",
        "delete_stale_snapshots",
        "delete_not_downloaded",
      ]);
    }
  });

  it("upsert rejects a kind of another format", async () => {
    await call(admin()).repositories.create({ name: "pkgs", format: "npm", kind: "hosted" });
    const error = await errorOf(call(admin()).policies.upsert({ repository: "pkgs", kind: "keep_last_snapshot_builds", value: 3 }));
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      message: "keep_last_snapshot_builds is not a cleanup kind for npm repositories",
    });
    const created = await call(admin()).policies.upsert({ repository: "pkgs", kind: "keep_last_versions", value: 3, groupPrefix: "@acme/" });
    expect(created).toMatchObject({ kind: "keep_last_versions", value: 3, groupPrefix: "@acme/", pattern: null });
    // A partial update is checked together with the stored values it keeps.
    expect(await codeOf(call(admin()).policies.upsert({ repository: "pkgs", id: created.id, kind: "delete_stale_snapshots" }))).toBe(
      "BAD_REQUEST",
    );
  });

  it("upsert on a mirror or group repo is refused", async () => {
    const caller = call(admin());
    await caller.repositories.create({ name: "npmjs", format: "npm", kind: "mirror", upstreams: [{ url: "https://registry.npmjs.org", authType: "none" }] });
    await caller.repositories.create({ name: "protos", format: "proto", kind: "group", members: ["shared"] });
    const message = "Cleanup policies apply to hosted repositories; mirror caches are governed by eviction settings";
    for (const repository of ["npmjs", "protos"]) {
      expect(await errorOf(caller.policies.upsert({ repository, kind: "delete_not_downloaded", value: 30 }))).toMatchObject({
        code: "BAD_REQUEST",
        message,
      });
      expect(await errorOf(caller.policies.list({ repository }))).toMatchObject({ code: "BAD_REQUEST", message });
      expect(await errorOf(caller.policies.preview({ repository }))).toMatchObject({ code: "BAD_REQUEST", message });
    }
    expect(await db.select().from(cleanupPolicy)).toEqual([]);
  });

  it("keep_last_tags without pattern and a pattern on another kind are refused", async () => {
    const caller = call(admin());
    await caller.repositories.create({ name: "images", format: "docker", kind: "hosted" });
    expect(await codeOf(caller.policies.upsert({ repository: "images", kind: "keep_last_tags", value: 5 }))).toBe("BAD_REQUEST");
    expect(
      await codeOf(caller.policies.upsert({ repository: "images", kind: "delete_untagged_manifests", value: 7, pattern: "v*" })),
    ).toBe("BAD_REQUEST");
    expect(
      await codeOf(caller.policies.upsert({ repository: "shared", kind: "delete_stale_snapshots", value: 7, pattern: "v*" })),
    ).toBe("BAD_REQUEST");
    const tags = await caller.policies.upsert({
      repository: "images",
      kind: "keep_last_tags",
      value: 5,
      pattern: "v*",
      groupPrefix: "team/",
    });
    expect(tags).toMatchObject({ kind: "keep_last_tags", value: 5, pattern: "v*", groupPrefix: "team/" });
    expect(await caller.policies.list({ repository: "images" })).toEqual([expect.objectContaining({ id: tags.id, pattern: "v*" })]);
    // Dropping the pattern is refused, and so is switching kinds without clearing it.
    expect(await codeOf(caller.policies.upsert({ repository: "images", id: tags.id, pattern: null }))).toBe("BAD_REQUEST");
    expect(await codeOf(caller.policies.upsert({ repository: "images", id: tags.id, kind: "delete_untagged_manifests" }))).toBe(
      "BAD_REQUEST",
    );
    const switched = await caller.policies.upsert({
      repository: "images",
      id: tags.id,
      kind: "delete_untagged_manifests",
      pattern: null,
    });
    expect(switched).toMatchObject({ kind: "delete_untagged_manifests", pattern: null });
  });

  it("includeReleases true is refused on npm and docker repositories and on kinds that ignore it", async () => {
    const caller = call(admin());
    await caller.repositories.create({ name: "images", format: "docker", kind: "hosted" });
    await caller.repositories.create({ name: "pkgs", format: "npm", kind: "hosted" });
    for (const repository of ["images", "pkgs"]) {
      expect(
        await codeOf(caller.policies.upsert({ repository, kind: "delete_not_downloaded", value: 30, includeReleases: true })),
      ).toBe("BAD_REQUEST");
      expect(
        await caller.policies.upsert({ repository, kind: "delete_not_downloaded", value: 30, includeReleases: false }),
      ).toMatchObject({ includeReleases: false });
    }
    await caller.repositories.create({ name: "libs", format: "maven", kind: "hosted" });
    expect(
      await caller.policies.upsert({
        repository: "libs",
        kind: "delete_not_downloaded",
        value: 30,
        includeReleases: true,
        groupPrefix: "org.example",
      }),
    ).toMatchObject({ includeReleases: true, groupPrefix: "org.example" });
    // Only delete_not_downloaded reads includeReleases; every other kind refuses it.
    for (const kind of ["keep_last_snapshot_builds", "delete_stale_snapshots"] as const) {
      expect(await codeOf(caller.policies.upsert({ repository: "libs", kind, value: 3, includeReleases: true }))).toBe("BAD_REQUEST");
      expect(await codeOf(caller.policies.upsert({ repository: "shared", kind, value: 3, includeReleases: true }))).toBe("BAD_REQUEST");
    }
  });

  it("validates the scope prefix per format", async () => {
    const caller = call(admin());
    await caller.repositories.create({ name: "pkgs", format: "npm", kind: "hosted" });
    expect(
      await codeOf(caller.policies.upsert({ repository: "shared", kind: "delete_stale_snapshots", value: 7, groupPrefix: "@acme/" })),
    ).toBe("BAD_REQUEST");
    expect(
      await codeOf(caller.policies.upsert({ repository: "pkgs", kind: "keep_last_versions", value: 7, groupPrefix: "has space" })),
    ).toBe("BAD_REQUEST");
  });

  it("updates and deletes policies", async () => {
    const caller = call(admin());
    const created = await caller.policies.upsert({ repository: "shared", kind: "delete_stale_snapshots", value: 30 });
    const updated = await caller.policies.upsert({
      repository: "shared",
      id: created.id,
      kind: "delete_stale_snapshots",
      value: 60,
      enabled: false,
    });
    expect(updated).toMatchObject({ id: created.id, value: 60, enabled: false });
    await caller.policies.delete({ id: created.id });
    expect(await db.select().from(cleanupPolicy)).toEqual([]);
    expect(await codeOf(caller.policies.delete({ id: created.id }))).toBe("NOT_FOUND");
  });

  it("enqueues a cleanup job with run now and reports its state", async () => {
    const { jobId } = await call(admin()).policies.runNow({ repository: "shared" });
    const status = await call(admin()).policies.job({ jobId });
    expect(status).toEqual({ state: "waiting", result: null, failedReason: null });
    expect(await codeOf(call(admin()).policies.runNow({ repository: "ghost" }))).toBe("NOT_FOUND");
  });

  it("fails fast with a clear error when Valkey is unreachable", async () => {
    const started = Date.now();
    const error = await call(admin(), { cleanupQueue: () => deadQueue })
      .policies.runNow({ repository: "shared" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("SERVICE_UNAVAILABLE");
    expect((error as TRPCError).message).toMatch(/job queue/i);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("reports a missing Valkey configuration", async () => {
    const runNow = call(admin(), { cleanupQueue: () => null }).policies.runNow({ repository: "shared" });
    expect(await codeOf(runNow)).toBe("PRECONDITION_FAILED");
  });
});

describe("invites", () => {
  it("creates a one-time absolute URL, storing only the token hash", async () => {
    const created = await call(admin()).invites.create({ role: "maintainer", expiresInDays: 7, note: "for Bea" });
    expect(created.url).toMatch(new RegExp(`^${BASE}/invite/[A-Za-z0-9_-]{43}$`));
    const token = created.url.split("/").pop()!;
    const [row] = await db.select().from(invite).where(eq(invite.id, created.id));
    expect(row!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);

    const listed = await call(admin()).invites.list();
    expect(listed).toEqual([
      expect.objectContaining({ id: created.id, role: "maintainer", note: "for Bea", status: "open", createdByName: "Ada Admin" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(await codeOf(call(maintainer()).invites.create({ role: "admin", expiresInDays: 1 }))).toBe("FORBIDDEN");
  });

  it("lists used and expired invites and revokes open ones", async () => {
    const used = await call(admin()).invites.create({ role: "viewer", expiresInDays: 1 });
    const expired = await call(admin()).invites.create({ role: "viewer", expiresInDays: 1 });
    const open = await call(admin()).invites.create({ role: "viewer", expiresInDays: 30 });
    await db.update(invite).set({ usedAt: new Date(), usedByUserId: people.viewer }).where(eq(invite.id, used.id));
    await db.update(invite).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invite.id, expired.id));

    const statuses = Object.fromEntries((await call(admin()).invites.list()).map((i) => [i.id, i.status]));
    expect(statuses).toEqual({ [used.id]: "used", [expired.id]: "expired", [open.id]: "open" });

    expect(await codeOf(call(admin()).invites.revoke({ id: used.id }))).toBe("PRECONDITION_FAILED");
    await call(admin()).invites.revoke({ id: open.id });
    expect((await call(admin()).invites.list()).map((i) => i.id).sort()).toEqual([used.id, expired.id].sort());
    const actions = (await db.select({ action: auditEvent.action }).from(auditEvent)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["invite.create", "invite.revoke"]));
  });
});

describe("users", () => {
  it("refuses to demote, ban or remove the last admin", async () => {
    const caller = call(admin());
    expect(await codeOf(caller.users.setRole({ userId: people.admin, role: "maintainer" }))).toBe("PRECONDITION_FAILED");
    // Another caller with admin rights (the stored role is what counts for the last-admin rule).
    const other = call(asUser(people.maintainer, "admin"));
    expect(await codeOf(other.users.ban({ userId: people.admin }))).toBe("PRECONDITION_FAILED");
    expect(await codeOf(other.users.remove({ userId: people.admin }))).toBe("PRECONDITION_FAILED");

    await caller.users.setRole({ userId: people.maintainer, role: "admin" });
    await caller.users.setRole({ userId: people.admin, role: "viewer" });
    const roles = Object.fromEntries((await caller.users.list()).map((u) => [u.id, u.role]));
    expect(roles).toEqual({ [people.admin]: "viewer", [people.maintainer]: "admin", [people.viewer]: "viewer" });
  });

  it("refuses to let admins ban or remove their own account", async () => {
    await call(admin()).users.setRole({ userId: people.maintainer, role: "admin" });
    const self = call(admin());
    const banSelf = self.users.ban({ userId: people.admin });
    await expect(banSelf).rejects.toThrow("You can't ban your own account");
    expect(await codeOf(self.users.ban({ userId: people.admin }))).toBe("FORBIDDEN");
    await expect(self.users.remove({ userId: people.admin })).rejects.toThrow("You can't remove your own account");
    expect(await codeOf(self.users.remove({ userId: people.admin }))).toBe("FORBIDDEN");
    expect((await self.users.list()).find((u) => u.id === people.admin)).toMatchObject({ banned: false, role: "admin" });
  });

  it("bans (ending sessions), unbans and removes users, auditing every change", async () => {
    const authCtx = await auth.$context;
    await authCtx.internalAdapter.createSession(people.viewer);
    const caller = call(admin());

    await caller.users.ban({ userId: people.viewer, reason: "spam" });
    expect(await db.select().from(session).where(eq(session.userId, people.viewer))).toEqual([]);
    expect((await caller.users.list()).find((u) => u.id === people.viewer)).toMatchObject({ banned: true, banReason: "spam" });

    await caller.users.unban({ userId: people.viewer });
    expect((await caller.users.list()).find((u) => u.id === people.viewer)).toMatchObject({ banned: false, banReason: null });

    await call(viewer()).keys.create({ name: "ci", permissions: [{ repository: "shared", access: "read" }] });
    await caller.users.remove({ userId: people.viewer });
    expect((await caller.users.list()).map((u) => u.id)).not.toContain(people.viewer);
    expect(await db.select().from(apikey)).toEqual([]);
    expect(await codeOf(caller.users.remove({ userId: people.viewer }))).toBe("NOT_FOUND");

    const actions = (await db.select({ action: auditEvent.action }).from(auditEvent)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["user.ban", "user.unban", "user.remove"]));
  });
});

describe("settings", () => {
  it("exposes the storage options to admins and rejects an unconfigured cache store", async () => {
    expect(await call(admin()).settings.storage()).toEqual({ primary: "local", configured: ["local"] });
    expect(await codeOf(call(maintainer()).settings.storage())).toBe("FORBIDDEN");
    expect(await codeOf(call(admin()).settings.update({ defaultCacheStore: "s3" }))).toBe("BAD_REQUEST");
  });

  it("returns only the anonymous view flag to anyone and lets admins change it", async () => {
    expect(await call(anonymous).settings.get()).toEqual({ anonymousView: false });
    expect(await codeOf(call(maintainer()).settings.update({ anonymousView: true }))).toBe("FORBIDDEN");
    expect(await call(admin()).settings.update({ anonymousView: true })).toEqual({
      anonymousView: true,
      defaultCacheStore: "local",
    });
    await call(admin()).settings.update({ anonymousView: false });
  });
});

describe("audit", () => {
  it("pages through entries newest first and filters by action", async () => {
    for (let i = 0; i < 5; i++) await call(admin()).invites.create({ role: "viewer", expiresInDays: 1 });
    const caller = call(admin());

    const first = await caller.audit.list({ limit: 3, action: "invite" });
    expect(first.items).toHaveLength(3);
    expect(first.items[0]).toMatchObject({ action: "invite.create", actorType: "user", actorName: "Ada Admin" });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await caller.audit.list({ limit: 3, action: "invite", cursor: first.nextCursor! });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
    const times = [...first.items, ...second.items].map((e) => e.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    expect((await caller.audit.list({ action: "repository.create" })).items).toHaveLength(2);
    expect(await caller.audit.actions()).toEqual(["invite.create", "repository.create"]);
    expect(await codeOf(call(maintainer()).audit.list({}))).toBe("FORBIDDEN");
  });
});

describe("review follow-ups", () => {
  it("drops key scopes of a deleted repository, so a new one with the same name doesn't inherit them", async () => {
    await call(maintainer()).keys.create({
      name: "ci",
      permissions: [
        { repository: "internal", access: "write" },
        { repository: "shared", access: "read" },
      ],
    });
    await call(admin()).repositories.delete({ name: "internal" });
    const scopes = await db
      .select({ name: repository.name })
      .from(repoPermission)
      .innerJoin(repository, eq(repository.id, repoPermission.repositoryId));
    expect(scopes.map((p) => p.name)).toEqual(["shared"]);

    await call(admin()).repositories.create({ ...protoHosted, name: "internal", visibility: "private" });
    const [key] = await call(maintainer()).keys.list();
    expect(key!.permissions).toEqual([
      { repositoryId: repoIds.shared, repository: "shared", groupPrefix: null, access: "read" },
    ]);
  });

  it("updates only the policy fields that were sent", async () => {
    const caller = call(admin());
    const created = await caller.policies.upsert({
      repository: "shared",
      kind: "delete_not_downloaded",
      value: 30,
      includeReleases: true,
      groupPrefix: "acme",
      enabled: false,
    });
    const updated = await caller.policies.upsert({ repository: "shared", id: created.id, value: 90 });
    expect(updated).toMatchObject({
      kind: "delete_not_downloaded",
      value: 90,
      includeReleases: true,
      groupPrefix: "acme",
      enabled: false,
    });
    expect(await codeOf(caller.policies.upsert({ repository: "shared", kind: "delete_stale_snapshots" }))).toBe("BAD_REQUEST");
  });

  it("audits run now with the job id", async () => {
    const { jobId } = await call(admin()).policies.runNow({ repository: "shared" });
    const entries = await db.select().from(auditEvent).where(eq(auditEvent.action, "policy.runNow"));
    expect(entries).toEqual([
      expect.objectContaining({ actorType: "user", actorId: people.admin, target: "shared", details: { jobId } }),
    ]);
  });

  it("hides the message and stack of unexpected errors from clients and logs them", async () => {
    const failing: Registry = {
      ...registry,
      getManifest: () => Promise.reject(new Error("connect to db.internal:5432 failed, password hunter2")),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await fetchRequestHandler({
        endpoint: "/api/trpc",
        router: appRouter,
        req: new Request(
          `${BASE}/api/trpc/browse.version?input=${encodeURIComponent(JSON.stringify({ json: { repository: "shared", coordinate: "acme:money:1.0.0" } }))}`,
        ),
        createContext: () => contextFor(viewer(), { registry: failing }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("hunter2");
      const body = JSON.parse(text) as { error: { json: { message: string; data: Record<string, unknown> } } };
      expect(body.error.json.message).toBe(INTERNAL_ERROR_MESSAGE);
      expect(body.error.json.data).not.toHaveProperty("stack");
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0]?.[1])).toContain("hunter2");
    } finally {
      logged.mockRestore();
    }
  });

  describe("an API key limited to a group prefix", () => {
    const scoped = (): Principal => ({
      kind: "apikey",
      keyId: "scoped-key",
      userId: people.viewer,
      role: "viewer",
      permissions: [{ repositoryId: repoIds.internal, repository: "internal", groupPrefix: "corp.secret", access: "read" }],
    });

    beforeEach(async () => {
      await publish("shared", "acme:money:1.0.0", moneyFiles);
      await publish("internal", "corp.secret:vault:2.0.0", moneyFiles);
      await publish("internal", "corp.secret:vault:2.1.0", moneyFiles);
      await publish("internal", "corp.other:ledger:1.0.0", moneyFiles);
    });

    it("sees only its groups in repository counts, artifacts, search and the dashboard", async () => {
      const caller = call(scoped());
      const repos = Object.fromEntries((await caller.browse.repositories()).map((r) => [r.name, r]));
      expect(repos.internal).toMatchObject({ artifactCount: 1, versionCount: 2 });
      expect(repos.shared).toMatchObject({ artifactCount: 1, versionCount: 1 });

      expect((await caller.browse.artifacts({ repository: "internal" })).map((a) => a.group)).toEqual(["corp.secret"]);
      expect((await caller.search.query({ q: "corp" })).hits).toEqual([
        expect.objectContaining({ repository: "internal", namespace: "corp.secret", name: "vault", latestVersion: "2.1.0", versionCount: 2 }),
      ]);

      const stats = await caller.dashboard.stats();
      expect(stats).toMatchObject({ repositories: 2, artifacts: 2, versions: 3 });
      expect(stats.recentPublishes.map((p) => p.coordinate)).not.toContain("corp.other:ledger:1.0.0");

      const full = Object.fromEntries((await call(viewer()).browse.repositories()).map((r) => [r.name, r]));
      expect(full.internal).toMatchObject({ artifactCount: 2, versionCount: 3 });
    });
  });
});

describe("stats", () => {
  const today = new Date().toISOString().slice(0, 10);

  async function hosted(name: string, visibility: "public" | "private" = "private") {
    await call(admin()).repositories.create({ name, format: "maven", kind: "hosted", visibility });
    return (await repos.get(name))!.id;
  }

  async function downloads(repositoryId: string, namespace: string, name: string, count: number) {
    await db.insert(usageDaily).values({ day: today, repositoryId, namespace, name, action: "download", count, bytes: count * 10 });
  }

  it("overview is admin only", async () => {
    expect(await codeOf(call(maintainer()).stats.overview({ days: 30 }))).toBe("FORBIDDEN");
    expect(await codeOf(call(anonymous).stats.overview({}))).toBe("UNAUTHORIZED");
  });

  it("overview lists series, top packages with labels, storage, mirror hit rates and named tokens", async () => {
    const lib = await hosted("libs");
    await downloads(lib, "org.acme", "core", 5);
    await db.insert(usageDailyToken).values([
      { day: today, apiKeyId: "gone", userId: people.maintainer, repositoryId: lib, action: "download", count: 2, bytes: 0 },
    ]);

    const overview = await call(admin()).stats.overview({ days: 7 });

    expect(overview.series).toHaveLength(7);
    expect(overview.series.at(-1)).toEqual({ day: today, downloads: 5, uploads: 0, bytes: 50 });
    expect(overview.topPackages).toEqual([
      { repositoryId: lib, repository: "libs", namespace: "org.acme", name: "core", label: "org.acme:core", downloads: 5 },
    ]);
    expect(overview.storage.map((s) => s.repository).sort()).toEqual(["internal", "libs", "shared"]);
    expect(overview.hitRates).toEqual([]);
    expect(overview.tokens).toEqual([
      expect.objectContaining({ apiKeyId: "gone", keyName: "Deleted key", ownerName: "Max Maintainer", downloads: 2 }),
    ]);
  });

  it("repository stats of a private repo the viewer cannot read are NOT_FOUND", async () => {
    await downloads(repoIds.internal, "corp", "vault", 3);
    expect(await codeOf(call(anonymous, anonymousViewOn).stats.repository({ repository: "internal" }))).toBe("NOT_FOUND");
    const outsider: Principal = { kind: "apikey", keyId: "k", userId: people.viewer, role: "viewer", permissions: [] };
    expect(await codeOf(call(outsider).stats.repository({ repository: "internal" }))).toBe("NOT_FOUND");
    expect(await codeOf(call(viewer()).stats.repository({ repository: "nope" }))).toBe("NOT_FOUND");

    const stats = await call(viewer()).stats.repository({ repository: "internal" });
    expect(stats.series.at(-1)?.downloads).toBe(3);
    expect(stats.hitRate).toBeNull();
  });

  it("group stats aggregate member downloads", async () => {
    const a = await hosted("team-a");
    const b = await hosted("team-b");
    await call(admin()).repositories.create({ name: "everything", format: "maven", kind: "group", visibility: "public", members: ["team-a", "team-b"] });
    await downloads(a, "org.acme", "core", 4);
    await downloads(b, "org.acme", "util", 6);
    await downloads(repoIds.shared, "acme", "money", 100);
    const takenAt = new Date("2026-06-01T00:00:00Z");
    await db.insert(storageSnapshot).values([
      { day: today, repositoryId: a, hostedBytes: 10, cacheBytes: 0, assetCount: 1, takenAt },
      { day: today, repositoryId: b, hostedBytes: 20, cacheBytes: 0, assetCount: 2, takenAt },
      { day: today, repositoryId: repoIds.shared, hostedBytes: 999, cacheBytes: 0, assetCount: 9, takenAt },
    ]);

    const stats = await call(anonymous, anonymousViewOn).stats.repository({ repository: "everything", days: 7 });

    expect(stats.series.at(-1)?.downloads).toBe(10);
    expect(stats.topPackages.map((p) => [p.repository, p.label, p.downloads])).toEqual([
      ["team-b", "org.acme:util", 6],
      ["team-a", "org.acme:core", 4],
    ]);
    expect(stats.storage).toEqual({ hostedBytes: 30, cacheBytes: 0, assetCount: 3, takenAt });
    expect(stats.hitRate).toBeNull();
  });

  it("tokenActivity: owner gets it, another maintainer gets NOT_FOUND, admin gets it", async () => {
    const created = await call(maintainer()).keys.create({ name: "ci", permissions: [{ repository: "shared", access: "read" }] });
    for (let i = 0; i < 3; i++) {
      await db.insert(usageEvent).values({ repositoryId: repoIds.shared, path: `p${i}`, action: "download", apiKeyId: created.id, userId: people.maintainer });
    }
    await db.insert(usageDailyToken).values({ day: today, apiKeyId: created.id, userId: people.maintainer, repositoryId: repoIds.shared, action: "download", count: 3, bytes: 0 });
    const other = asUser((await createUser("maintainer", "Other")).id, "maintainer");

    const own = await call(maintainer()).stats.tokenActivity({ keyId: created.id, limit: 2 });
    expect(own.key).toEqual({ id: created.id, name: "ci" });
    expect(own.series.at(-1)?.downloads).toBe(3);
    expect(own.events.map((e) => e.path)).toEqual(["p2", "p1"]);
    expect(own.nextBefore).toBe(own.events[1]!.id);
    const rest = await call(maintainer()).stats.tokenActivity({ keyId: created.id, limit: 2, before: own.nextBefore! });
    expect(rest.events.map((e) => e.path)).toEqual(["p0"]);
    expect(rest.nextBefore).toBeNull();

    expect(await codeOf(call(other).stats.tokenActivity({ keyId: created.id }))).toBe("NOT_FOUND");
    expect((await call(admin()).stats.tokenActivity({ keyId: created.id })).events).toHaveLength(3);
    expect((await call(admin()).stats.tokenActivity({ keyId: "deleted" })).key).toEqual({ id: "deleted", name: "Deleted key" });
    expect(await codeOf(call(maintainer()).stats.tokenActivity({ keyId: "deleted" }))).toBe("NOT_FOUND");
  });
});

describe("npm", () => {
  /** Stores a hosted packument (and a component with a 1234-byte tarball asset per version). */
  async function publish(repo: string, name: string, versions: string[], extra: Record<string, unknown> = {}) {
    const [row] = await db.select({ id: repository.id }).from(repository).where(eq(repository.name, repo));
    const slash = name.indexOf("/");
    const namespace = name.startsWith("@") ? name.slice(1, slash) : "";
    const bare = name.startsWith("@") ? name.slice(slash + 1) : name;
    const manifests = Object.fromEntries(versions.map((v) => [v, { name, version: v, dist: { tarball: "x", shasum: "y" } }]));
    await db.insert(npmPackage).values({
      repositoryId: row!.id,
      name,
      document: {
        _id: name,
        name,
        "dist-tags": { latest: versions.at(-1)! },
        versions: { ...manifests, ...((extra["versions"] as object | undefined) ?? {}) },
        time: Object.fromEntries(versions.map((v) => [v, "2026-01-01T00:00:00.000Z"])),
        description: `The ${name} package`,
        ...(extra["readme"] ? { readme: extra["readme"] } : {}),
      },
    });
    for (const v of versions) {
      const [comp] = await db.insert(component).values({ repositoryId: row!.id, namespace, name: bare, version: v }).returning();
      await db.insert(asset).values({
        repositoryId: row!.id,
        componentId: comp!.id,
        path: `${name}/-/${bare}-${v}.tgz`,
        store: "local",
        storageKey: `k/${randomUUID()}`,
        size: 1234,
        contentType: "application/octet-stream",
        md5: "m",
        sha1: "s1",
        sha256: "s256",
        sha512: "s512",
        origin: "hosted",
      });
    }
  }

  beforeEach(async () => {
    await call(admin()).repositories.create({ name: "npm-priv", format: "npm", kind: "hosted", visibility: "private" });
    await call(admin()).repositories.create({ name: "npm-pub", format: "npm", kind: "hosted", visibility: "public" });
  });

  it("packages lists hosted packages with latest", async () => {
    await publish("npm-priv", "left-pad", ["1.0.0", "1.1.0"]);
    await publish("npm-priv", "@acme/ui", ["2.0.0"]);
    const page = await call(viewer()).npm.packages({ repo: "npm-priv" });
    expect(page.source).toBe("hosted");
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((p) => `${p.name}@${p.latest}`)).toEqual(["@acme/ui@2.0.0", "left-pad@1.1.0"]);
    expect(page.items[0]!.description).toBe("The @acme/ui package");
    expect((await call(viewer()).npm.packages({ repo: "npm-priv", query: "pad" })).items.map((p) => p.name)).toEqual(["left-pad"]);
    expect(await codeOf(call(viewer()).npm.packages({ repo: "shared" }))).toBe("BAD_REQUEST");
  });

  it("packages pages by 25", async () => {
    for (let i = 0; i < 27; i++) await publish("npm-priv", `pkg-${String(i).padStart(2, "0")}`, ["1.0.0"]);
    const first = await call(viewer()).npm.packages({ repo: "npm-priv" });
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBe(25);
    const second = await call(viewer()).npm.packages({ repo: "npm-priv", cursor: first.nextCursor! });
    expect(second.items.map((p) => p.name)).toEqual(["pkg-25", "pkg-26"]);
    expect(second.nextCursor).toBeNull();
  });

  it("package returns versions newest first with deprecated flags", async () => {
    await publish("npm-priv", "@acme/ui", ["1.2.0", "1.10.0", "1.9.0"], {
      readme: "# UI",
      versions: { "1.9.0": { name: "@acme/ui", version: "1.9.0", deprecated: "use 1.10", dist: { tarball: "x", shasum: "y" } } },
    });
    const pkg = await call(viewer()).npm.package({ repo: "npm-priv", name: "@acme/ui" });
    expect(pkg!.versions.map((v) => v.version)).toEqual(["1.10.0", "1.9.0", "1.2.0"]);
    expect(pkg!.versions.find((v) => v.version === "1.9.0")).toMatchObject({ deprecated: "use 1.10", size: 1234, publishedAt: "2026-01-01T00:00:00.000Z" });
    expect(pkg!.versions[0]!.deprecated).toBeNull();
    expect(pkg).toMatchObject({ distTags: { latest: "1.9.0" }, readme: "# UI", description: "The @acme/ui package" });
    expect(await call(viewer()).npm.package({ repo: "npm-priv", name: "missing" })).toBeNull();
  });

  it("private repo without read is NOT_FOUND", async () => {
    await publish("npm-priv", "left-pad", ["1.0.0"]);
    const anon = call(anonymous, anonymousViewOn);
    expect(await codeOf(anon.npm.packages({ repo: "npm-priv" }))).toBe("NOT_FOUND");
    expect(await codeOf(anon.npm.package({ repo: "npm-priv", name: "left-pad" }))).toBe("NOT_FOUND");
    await publish("npm-pub", "open", ["1.0.0"]);
    expect((await anon.npm.packages({ repo: "npm-pub" })).items).toHaveLength(1);
  });

  it("mirror source lists cached components only and exposes no config", async () => {
    await call(admin()).repositories.create({
      name: "npmjs",
      format: "npm",
      kind: "mirror",
      visibility: "public",
      upstreams: [{ url: "https://registry.npmjs.org/", authType: "none" }],
      config: { rules: { deny: ["secret-*"] } },
    });
    const [row] = await db.select({ id: repository.id }).from(repository).where(eq(repository.name, "npmjs"));
    await db.insert(component).values([
      { repositoryId: row!.id, namespace: "", name: "lodash", version: "4.9.0" },
      { repositoryId: row!.id, namespace: "", name: "lodash", version: "4.17.21" },
      { repositoryId: row!.id, namespace: "types", name: "node", version: "22.0.0" },
    ]);
    const page = await call(anonymous, anonymousViewOn).npm.packages({ repo: "npmjs" });
    expect(page.source).toBe("cache");
    expect(page.items.map((p) => `${p.name}@${p.latest}`)).toEqual(["@types/node@22.0.0", "lodash@4.17.21"]);
    expect(JSON.stringify(page)).not.toContain("secret-");
    const pkg = await call(viewer()).npm.package({ repo: "npmjs", name: "lodash" });
    expect(pkg!.versions.map((v) => v.version)).toEqual(["4.17.21", "4.9.0"]);
  });

  it("group lists only members the caller can browse, earlier member wins", async () => {
    await publish("npm-priv", "left-pad", ["1.0.0"]);
    await publish("npm-pub", "left-pad", ["9.9.9"]);
    await call(admin()).repositories.create({ name: "npm-grp", format: "npm", kind: "group", visibility: "public", members: ["npm-pub", "npm-priv"] });
    const anon = await call(anonymous, anonymousViewOn).npm.packages({ repo: "npm-grp" });
    expect(anon).toMatchObject({ source: "group", members: ["npm-pub"] });
    const user = await call(viewer()).npm.packages({ repo: "npm-grp" });
    expect(user.members).toEqual(["npm-pub", "npm-priv"]);
    expect(user.items.map((p) => `${p.name}@${p.latest}`)).toEqual(["left-pad@9.9.9"]);
    expect((await call(viewer()).npm.package({ repo: "npm-grp", name: "left-pad" }))!.versions.map((v) => v.version)).toEqual(["9.9.9"]);
  });
});

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  createAssetService,
  createMirrorEngine,
  createRegistry,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  packArchive,
} from "@weaver/core";
import { repository, user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { insertKeyPermissions } from "@/test/catalog";
import { createAuth, type Auth, type AuthEnv } from "@/server/auth";
import type { ServerContext } from "@/server/context";
import { POST as authRoute } from "./auth/[...all]/route";
import { GET as v1Get, HEAD as v1Head, PUT as v1Put } from "./v1/[...path]/route";

const holder = vi.hoisted(() => ({ ctx: undefined as ServerContext | undefined }));

vi.mock("@/server/context", () => ({
  getServerContext: () => {
    if (!holder.ctx) throw new Error("test server context is not initialised");
    return holder.ctx;
  },
}));

const BASE = "http://localhost:3000";

const authEnv: AuthEnv = {
  BETTER_AUTH_SECRET: "api-test-secret-api-test-secret-0123456",
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
let blobDir: string;

async function createUser(role: string) {
  const now = new Date();
  const [row] = await db
    .insert(user)
    .values({ id: randomUUID(), name: `${role} user`, email: `${randomUUID()}@example.com`, role, createdAt: now, updatedAt: now })
    .returning();
  return row!;
}

/** Publishes acme:money:1.0.0 to `releases` through the mounted /api/v1 route with `token`. */
async function publishMoney(token: string): Promise<Response> {
  const form = new FormData();
  form.set("manifest", JSON.stringify({ group: "acme", name: "money", version: "1.0.0", dependencies: [] }));
  const archive = await packArchive([{ path: "acme/money/v1/money.proto", content: 'syntax = "proto3";\npackage acme.money.v1;\n' }]);
  form.set("archive", new Blob([new Uint8Array(archive)], { type: "application/gzip" }), "archive.tar.gz");
  return v1Put(
    new Request(`${BASE}/api/v1/repos/releases/artifacts/acme/money/1.0.0`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }),
  );
}

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  auth = createAuth(db, authEnv);
  blobDir = await mkdtemp(join(tmpdir(), "weaver-api-"));
  const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
  const secretKey = deriveSecretKey(authEnv.BETTER_AUTH_SECRET);
  const repos = createRepoService({ db, stores, secretKey });
  const assets = createAssetService({ db, stores });
  const settings = () => Promise.resolve({ anonymousView: false, defaultCacheStore: "local" as const });
  holder.ctx = {
    db,
    stores,
    auth,
    registry: createRegistry({ db, stores, repos, validate: () => Promise.resolve([]) }),
    assets,
    mirror: createMirrorEngine({ db, stores, repos, assets, settings }),
    secretKey,
    repos,
  };
});

afterAll(async () => {
  holder.ctx = undefined;
  await testDb?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE repository, audit_event CASCADE`);
  await db.insert(repository).values([{ name: "releases", format: "proto", kind: "hosted", visibility: "public" }]);
});

describe("Better Auth HTTP surface", () => {
  const authPost = (path: string, body: object = {}) =>
    authRoute(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify(body),
      }),
    );

  it("does not expose admin-plugin or api-key endpoints over HTTP", async () => {
    expect((await authPost("/admin/set-role", { userId: "x", role: "admin" })).status).toBe(404);
    expect((await authPost("/admin/create-user", { email: "a@b.c", name: "a" })).status).toBe(404);
    expect((await authPost("/admin/ban-user", { userId: "x" })).status).toBe(404);
    expect((await authPost("/api-key/create", { name: "sneaky" })).status).toBe(404);
    expect((await authPost("/api-key/delete", { keyId: "x" })).status).toBe(404);
    expect((await authPost("/update-user", { name: "renamed" })).status).toBe(404);
  });

  it("still serves the endpoints the UI uses", async () => {
    const signIn = await authPost("/sign-in/social", { provider: "github", callbackURL: "/dashboard" });
    expect(signIn.status).toBe(200);
    expect(((await signIn.json()) as { url: string }).url).toContain("github.com");
    const session = await authRoute(new Request(`${BASE}/api/auth/get-session`));
    expect(session.status).toBe(200);
  });
});

describe("/api/v1 mount", () => {
  it("authenticates server-side created API keys on the proto REST API", async () => {
    const owner = await createUser("maintainer");
    const created = await auth.api.createApiKey({ body: { userId: owner.id, name: "server-side" } });
    await insertKeyPermissions(db, created.id, [{ repository: "releases", access: "write" }]);
    const published = await publishMoney(created.key);
    expect(published.status).toBe(201);
    expect((await publishMoney("not-a-key")).status).toBe(401);
  });

  it("serves the raw path, answers HEAD without a body and unknown paths with 404 JSON", async () => {
    const owner = await createUser("maintainer");
    const created = await auth.api.createApiKey({ body: { userId: owner.id, name: "reader" } });
    await insertKeyPermissions(db, created.id, [{ repository: "releases", access: "write" }]);
    expect((await publishMoney(created.key)).status).toBe(201);

    const list = await v1Get(new Request(`${BASE}/api/v1/repos/releases/artifacts/acme/money`));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { versions: { version: string }[] }).versions.map((v) => v.version)).toEqual(["1.0.0"]);

    const head = await v1Head(new Request(`${BASE}/api/v1/repos/releases/artifacts/acme/money/1.0.0/archive`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("x-weaver-sha256")).toMatch(/^[0-9a-f]{64}$/);
    expect(await head.text()).toBe("");

    const unknown = await v1Get(new Request(`${BASE}/api/v1/nothing/here`));
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createRepoService, createStoreSetFromEnv, deriveSecretKey, type RepoService } from "@weaver/core";
import { repoPermission, repository, user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createAuth, type Auth, type AuthEnv } from "../server/auth";
import { API_KEY_PREFIX } from "../server/trpc/routers/keys";
import { applySeedSpec, E2E_ADMIN_EMAIL, type SeedSpec } from "./e2e-seed";
import { signSessionCookie } from "./session-cookie";

const authEnv: AuthEnv = {
  BETTER_AUTH_SECRET: "seed-test-secret-seed-test-secret-012345",
  BETTER_AUTH_URL: "http://localhost:3000",
  INITIAL_ADMIN: undefined,
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  DISCORD_CLIENT_ID: undefined,
  DISCORD_CLIENT_SECRET: undefined,
};

let testDb: Awaited<ReturnType<typeof startTestDb>>;
let db: Db;
let auth: Auth;
let repos: RepoService;
let blobDir: string;

/** A process environment holding only `vars`. */
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const deps = () =>({ db, repos, auth, secret: authEnv.BETTER_AUTH_SECRET });

const spec: SeedSpec = {
  repos: [
    { name: "maven-hosted", format: "maven", kind: "hosted" },
    {
      name: "maven-mirror",
      format: "maven",
      kind: "mirror",
      config: { cache: { enabled: true, store: "local" } },
      upstreams: [{ url: "http://reposilite:8080/releases", authType: "basic", username: "e2e", secretEnv: "X" }],
    },
    { name: "maven-group", format: "maven", kind: "group", members: ["maven-hosted", "maven-mirror"] },
  ],
  tokens: {
    read: [
      { repository: "maven-hosted", access: "read" },
      { repository: "maven-group", access: "read" },
    ],
    write: [{ repository: "maven-hosted", access: "write" }],
    none: [],
  },
};

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  auth = createAuth(db, authEnv);
  blobDir = await mkdtemp(join(tmpdir(), "weaver-seed-"));
  repos = createRepoService({
    db,
    stores: createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir }),
    secretKey: deriveSecretKey(authEnv.BETTER_AUTH_SECRET),
  });
});

afterAll(async () => {
  await testDb?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE "user", repository CASCADE`);
});

describe("applySeedSpec", () => {
  it("creates every repo with its kind, config and ordered members", async () => {
    await applySeedSpec(deps(), spec, env({ X: "s3cr3t" }));
    const mirror = await repos.get("maven-mirror");
    expect(mirror?.kind).toBe("mirror");
    expect(mirror?.config).toMatchObject({ cache: { enabled: true, store: "local" } });
    expect((await repos.get("maven-hosted"))?.kind).toBe("hosted");
    const group = await repos.get("maven-group");
    expect(group?.kind).toBe("group");
    expect((await repos.members(group!.id)).map((r) => r.name)).toEqual(["maven-hosted", "maven-mirror"]);
  });

  it("secretEnv fills the upstream secret; an empty variable drops auth to none", async () => {
    await applySeedSpec(deps(), spec, env({ X: "s3cr3t" }));
    const [withSecret] = await repos.upstreamsWithSecrets((await repos.get("maven-mirror"))!.id);
    expect(withSecret).toMatchObject({ secret: "s3cr3t", authType: "basic", username: "e2e" });

    await db.execute(sql`TRUNCATE "user", repository CASCADE`);
    await applySeedSpec(deps(), spec, env({ X: "" }));
    const [without] = await repos.upstreamsWithSecrets((await repos.get("maven-mirror"))!.id);
    expect(without?.authType).toBe("none");
    expect(without?.secret).toBeNull();
  });

  it("tokens get exactly the listed permissions", async () => {
    const result = await applySeedSpec(deps(), spec, env({ X: "s3cr3t" }));
    for (const token of Object.values(result.tokens)) expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
    const rows = async (name: string) => {
      const verified = await auth.api.verifyApiKey({ body: { key: result.tokens[name]! } });
      return db
        .select({ repository: repository.name, access: repoPermission.access })
        .from(repoPermission)
        .innerJoin(repository, eq(repository.id, repoPermission.repositoryId))
        .where(eq(repoPermission.apiKeyId, verified.key!.id))
        .orderBy(repository.name);
    };
    const byName = (a: { repository: string }, b: { repository: string }) => a.repository.localeCompare(b.repository);
    expect(await rows("read")).toEqual([...spec.tokens.read!].sort(byName));
    expect(await rows("write")).toEqual(spec.tokens.write);
    expect(await rows("none")).toEqual([]);
  });

  it("running twice reuses the admin and repos and issues new tokens", async () => {
    const first = await applySeedSpec(deps(), spec, env({ X: "s3cr3t" }));
    const ids = (await repos.list()).map((r) => r.id).sort();
    const second = await applySeedSpec(deps(), spec, env({ X: "s3cr3t" }));
    expect(await db.select({ id: user.id }).from(user)).toHaveLength(1);
    expect(second.adminUserId).toBe(first.adminUserId);
    expect((await repos.list()).map((r) => r.id).sort()).toEqual(ids);
    expect(second.tokens.write).not.toBe(first.tokens.write);
  });

  it("refuses a database with another user", async () => {
    await db.insert(user).values({ id: "someone", name: "Someone", email: "someone@example.com" });
    await expect(applySeedSpec(deps(), spec, env({}))).rejects.toThrow("database has users other than the e2e admin");
  });

  it("signSessionCookie matches Better Auth", async () => {
    const result = await applySeedSpec(deps(), spec, env({ X: "s3cr3t" }));
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: `better-auth.session_token=${result.sessionCookie}` }),
    });
    expect(session?.user.id).toBe(result.adminUserId);
    expect(session?.user.email).toBe(E2E_ADMIN_EMAIL);
    // The helper is what produced the cookie; signing a different token gives a different value.
    expect(await signSessionCookie(authEnv.BETTER_AUTH_SECRET, "other")).not.toBe(result.sessionCookie);
  });
});

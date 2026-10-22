import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RegistryError,
  createAssetService,
  createMirrorEngine,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  extractToken,
  getSettings,
  recordUsage,
  type Access,
  type CreateRepoInput,
  type FormatDeps,
  type FormatHandler,
  type KeyPermission,
  type Principal,
  type Repo,
  type RepoService,
  type Role,
} from "@weaver/core";
import { user } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createMavenHandler } from "../handler.js";

/** A running Maven handler over a real database and a temporary local store, for tests. */
export interface MavenFixture {
  deps: FormatDeps;
  handler: FormatHandler;
  repos: RepoService;
  admin: Principal;
  /** Registers a token resolving to an apikey principal with these grants; returns the token. */
  token(grants: Array<{ repo: string; access: Access }>, role?: Role): Promise<string>;
  /** Sends a request through the handler; `path` is the part after `/maven/`. */
  request(method: string, path: string, init?: { body?: string | Buffer; token?: string; basic?: boolean }): Promise<Response>;
  createRepo(input: CreateRepoInput): Promise<Repo>;
  stop(): Promise<void>;
}

/** Starts the database, store and handler; call `stop()` when done. */
export async function startMavenFixture(): Promise<MavenFixture> {
  const testDb = await startTestDb();
  const blobDir = await mkdtemp(join(tmpdir(), "weaver-maven-"));
  const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
  const secretKey = deriveSecretKey("maven-test");
  const db = testDb.db;
  const adminId = "maven-admin";
  await db.insert(user).values({ id: adminId, name: "Admin", email: "admin@weaver.test", role: "admin" });
  const admin: Principal = { kind: "user", userId: adminId, role: "admin" };

  const repos = createRepoService({ db, stores, secretKey });
  const assets = createAssetService({ db, stores });
  const settings = () => getSettings(db, { primaryStore: stores.primary.id, configuredStores: stores.configured() });
  const mirror = createMirrorEngine({ db, stores, repos, assets, settings });
  const tokens = new Map<string, Principal>();

  const deps: FormatDeps = {
    db,
    stores,
    repos,
    assets,
    mirror,
    settings,
    publicUrl: "http://weaver.test",
    secretKey,
    usage: (input) => recordUsage(db, input),
    async principal(req) {
      const token = extractToken(req.headers);
      if (token === null) return { kind: "anonymous" };
      const found = tokens.get(token);
      if (!found) throw new RegistryError("unauthorized", "Invalid token");
      return found;
    },
  };
  const handler = createMavenHandler(deps);

  return {
    deps,
    handler,
    repos,
    admin,
    async token(grants, role = "maintainer") {
      const permissions: KeyPermission[] = [];
      for (const grant of grants) {
        const repo = await repos.get(grant.repo);
        if (!repo) throw new Error(`Unknown repo ${grant.repo}`);
        permissions.push({ repositoryId: repo.id, repository: repo.name, groupPrefix: null, access: grant.access });
      }
      const token = `wvr_${randomUUID()}`;
      tokens.set(token, { kind: "apikey", keyId: randomUUID(), userId: adminId, role, permissions });
      return token;
    },
    request(method, path, init = {}) {
      const headers = new Headers();
      if (init.token !== undefined) {
        const basic = Buffer.from(`token:${init.token}`).toString("base64");
        headers.set("authorization", init.basic ? `Basic ${basic}` : `Bearer ${init.token}`);
      }
      const req = new Request(`http://weaver.test/maven/${path}`, { method, headers, body: init.body });
      return handler(req, path);
    },
    createRepo: (input) => repos.create(admin, input),
    async stop() {
      await testDb.stop();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

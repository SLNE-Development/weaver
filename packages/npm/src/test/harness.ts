import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssetService,
  createMirrorEngine,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  getSettings,
  recordUsage,
  RegistryError,
  type CreateRepoInput,
  type FormatDeps,
  type FormatHandler,
  type KeyPermission,
  type Principal,
  type Repo,
  type Role,
} from "@weaver/core";
import type { Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createNpmHandler } from "../handler.js";

/** A running npm handler over a throwaway database and a local store, with fixed principals keyed by token. */
export interface Harness {
  db: Db;
  /** Connection URL of the test database, for extra pools. */
  url: string;
  deps: FormatDeps;
  handler: FormatHandler;
  publicUrl: "https://weaver.slne.dev";
  /** Tokens of an admin user, a key writing every repo, a key reading every repo and a write key owned by a viewer. */
  tokens: { admin: string; writer: string; reader: string; viewerWriter: string };
  /** Creates a repository as the admin. */
  createRepo(input: CreateRepoInput): Promise<Repo>;
  /** Sends a request to `/npm/<path>`; `path` is the raw, still percent-encoded part after `/npm/`, optionally with a query. */
  call(
    method: string,
    path: string,
    opts?: { token?: string; json?: unknown; body?: RequestInit["body"]; headers?: RequestInit["headers"] },
  ): Promise<Response>;
  /** Stops the database and removes the store directory. */
  stop(): Promise<void>;
}

const PUBLIC_URL = "https://weaver.slne.dev";
const TOKENS = { admin: "tok-admin", writer: "tok-writer", reader: "tok-reader", viewerWriter: "tok-viewer-writer" } as const;

/** Starts a database, a local store in a temp dir and the real core services, and builds the npm handler over them. */
export async function createHarness(): Promise<Harness> {
  const testDb = await startTestDb();
  const blobDir = await mkdtemp(join(tmpdir(), "weaver-npm-"));
  const db = testDb.db;
  const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
  const secretKey = deriveSecretKey("npm-test");
  const repos = createRepoService({ db, stores, secretKey });
  const assets = createAssetService({ db, stores });
  const settings = () => getSettings(db, { primaryStore: stores.primary.id, configuredStores: stores.configured() });
  const mirror = createMirrorEngine({ db, stores, repos, assets, settings });
  const admin: Principal = { kind: "user", userId: "user-admin", role: "admin" };

  /** A key principal holding `access` on every repository that exists right now. */
  async function key(keyId: string, userId: string, role: Role, access: KeyPermission["access"]): Promise<Principal> {
    const permissions = (await repos.list()).map((r) => ({ repositoryId: r.id, repository: r.name, groupPrefix: null, access }));
    return { kind: "apikey", keyId, userId, role, permissions };
  }

  const deps: FormatDeps = {
    db,
    stores,
    repos,
    assets,
    mirror,
    async principal(req) {
      const auth = req.headers.get("authorization");
      if (!auth) return { kind: "anonymous" };
      const token = auth.replace(/^Bearer\s+/i, "");
      switch (token) {
        case TOKENS.admin:
          return admin;
        case TOKENS.writer:
          return key("key-writer", "user-writer", "maintainer", "write");
        case TOKENS.reader:
          return key("key-reader", "user-reader", "maintainer", "read");
        case TOKENS.viewerWriter:
          return key("key-viewer", "user-viewer", "viewer", "write");
        default:
          throw new RegistryError("unauthorized", "invalid token");
      }
    },
    settings,
    publicUrl: PUBLIC_URL,
    secretKey,
    usage: (input) => recordUsage(db, input),
  };
  const handler = createNpmHandler(deps);

  return {
    db,
    url: testDb.url,
    deps,
    handler,
    publicUrl: PUBLIC_URL,
    tokens: { ...TOKENS },
    createRepo: (input) => repos.create(admin, input),
    async call(method, path, opts = {}) {
      const headers = new Headers(opts.headers);
      if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
      let body = opts.body;
      if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
      const req = new Request(`${PUBLIC_URL}/npm/${path}`, { method, headers, body });
      // The mount passes the path without the query string, as the web app does.
      return handler(req, path.split("?")[0]!);
    },
    async stop() {
      await mirror.drain();
      await testDb.stop();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

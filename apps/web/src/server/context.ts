import {
  createAssetService,
  createMirrorEngine,
  createRegistry,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  getSettings,
  type AssetService,
  type MirrorEngine,
  type Registry,
  type RepoService,
  type StoreSet,
} from "@weaver/core";
import { createDb, type Db } from "@weaver/db";
import { env } from "../env";
import { createAuth, type Auth } from "./auth";

/** Process-wide server dependencies. */
export interface ServerContext {
  db: Db;
  /** The configured object stores; hosted writes go to `stores.primary`. */
  stores: StoreSet;
  auth: Auth;
  /** The hosted proto registry over `db`, `stores` and `repos`. */
  registry: Registry;
  /** AES key for upstream credentials, derived once from `BETTER_AUTH_SECRET`. */
  secretKey: Buffer;
  /** Repository management over `db`, `stores` and `secretKey`. */
  repos: RepoService;
  /** Stored files of non-proto repositories. */
  assets: AssetService;
  /** Serves and caches mirror repositories from their upstreams. */
  mirror: MirrorEngine;
}

// Kept on globalThis so dev-mode module reloads reuse the same pool instead of leaking one per reload.
const globalForContext = globalThis as typeof globalThis & { __weaverServerContext?: ServerContext };

/** The lazily created server dependencies, built once per process from `env`. */
export function getServerContext(): ServerContext {
  if (!globalForContext.__weaverServerContext) {
    const db = createDb(env.DATABASE_URL);
    // The object stores read only the validated STORAGE_* / S3_* values.
    const stores = createStoreSetFromEnv(env);
    const secretKey = deriveSecretKey(env.BETTER_AUTH_SECRET);
    const repos = createRepoService({ db, stores, secretKey });
    const assets = createAssetService({ db, stores });
    const mirror = createMirrorEngine({
      db,
      stores,
      repos,
      assets,
      settings: () => getSettings(db, { primaryStore: stores.primary.id, configuredStores: stores.configured() }),
    });
    globalForContext.__weaverServerContext = {
      db,
      stores,
      auth: createAuth(db),
      registry: createRegistry({ db, stores, repos }),
      secretKey,
      repos,
      assets,
      mirror,
    };
  }
  return globalForContext.__weaverServerContext;
}

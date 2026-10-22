import { createLocalStore } from "./local.js";
import type { ObjectStore, StoreId, StoreSet } from "./object-store.js";
import { createS3Store } from "./s3.js";

export {
  getBuffer,
  putBuffer,
  type ObjectDigests,
  type ObjectInfo,
  type ObjectRead,
  type ObjectStore,
  type PutResult,
  STORE_IDS,
  type StoreId,
  type StoreSet,
} from "./object-store.js";
export { createLocalStore } from "./local.js";
export { createS3Store, type S3StoreOptions } from "./s3.js";

/** Environment variables; any `NodeJS.ProcessEnv` fits, as does a plain record in tests. */
type StorageEnv = Readonly<Record<string, string | undefined>>;

function required(env: StorageEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * Builds every store the environment configures: `local` when `STORAGE_LOCAL_PATH` is set, `s3`
 * when `S3_BUCKET` is set (then `S3_REGION` and credentials are required). `STORAGE_DRIVER`
 * (`local` or `s3`) names the primary store, which must be configured. Throws on missing config.
 */
export function createStoreSetFromEnv(env: StorageEnv): StoreSet {
  const driver = env.STORAGE_DRIVER;
  if (driver !== "local" && driver !== "s3") {
    throw new Error(`Invalid or missing STORAGE_DRIVER "${driver ?? ""}": expected "local" or "s3"`);
  }

  const stores = new Map<StoreId, ObjectStore>();
  if (env.STORAGE_LOCAL_PATH) stores.set("local", createLocalStore(env.STORAGE_LOCAL_PATH));
  if (env.S3_BUCKET) {
    stores.set(
      "s3",
      createS3Store({
        endpoint: env.S3_ENDPOINT || undefined,
        bucket: env.S3_BUCKET,
        region: required(env, "S3_REGION"),
        accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
      }),
    );
  }

  const primary = stores.get(driver);
  if (!primary) required(env, driver === "local" ? "STORAGE_LOCAL_PATH" : "S3_BUCKET");
  const ids = (["local", "s3"] as const).filter((id) => stores.has(id));
  return {
    primary: primary!,
    get: (id) => stores.get(id) ?? null,
    configured: () => [...ids],
  };
}

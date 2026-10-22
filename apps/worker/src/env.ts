import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Validates the worker's environment: the database, Valkey, the server secret, and the object storage settings.
 * Empty strings count as unset. Store requirements (a path for `local`, bucket, region and
 * credentials for `s3`, and that the `STORAGE_DRIVER` store is configured) are enforced by
 * `createStoreSetFromEnv`.
 */
export function loadEnv(runtimeEnv: Record<string, string | undefined>) {
  return createEnv({
    server: {
      DATABASE_URL: z.url(),
      VALKEY_URL: z.url(),
      BETTER_AUTH_SECRET: z.string().min(32),
      STORAGE_DRIVER: z.enum(["local", "s3"]),
      STORAGE_LOCAL_PATH: z.string().optional(),
      S3_ENDPOINT: z.url().optional(),
      S3_BUCKET: z.string().optional(),
      S3_REGION: z.string().optional(),
      S3_ACCESS_KEY_ID: z.string().optional(),
      S3_SECRET_ACCESS_KEY: z.string().optional(),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
    isServer: true,
  });
}

export type WorkerEnv = ReturnType<typeof loadEnv>;

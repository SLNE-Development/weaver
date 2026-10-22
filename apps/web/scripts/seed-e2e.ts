// Seeds a Weaver e2e stack from a JSON spec (scripts/e2e/run.sh): `node seed-e2e.mjs <spec.json>`.
//
// It is NOT part of the image. run.sh bundles it with esbuild into one file, copies it into the
// running app container and runs it there with plain node. The logic lives in src/test/e2e-seed.ts
// (tested with Vitest). The SeedResult JSON is printed as the LAST stdout line; progress goes to
// stderr. Guards: it runs only with WEAVER_E2E_SEED=1, and refuses a database that has any user
// other than the e2e admin. Needs DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL and the app's
// storage settings (STORAGE_DRIVER and friends), which the app container has.
import { readFileSync } from "node:fs";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { createRepoService, createStoreSetFromEnv, deriveSecretKey } from "@weaver/core";
import { account, apikey, createDb, session, user, verification } from "@weaver/db";
import { applySeedSpec, type SeedSpec } from "../src/test/e2e-seed";

/** The value of a required environment variable, or exits with an error. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`seed-e2e: ${name} is not set`);
    process.exit(1);
  }
  return value;
}

if (process.env.WEAVER_E2E_SEED !== "1") {
  console.error("seed-e2e: refusing to run without WEAVER_E2E_SEED=1 (e2e stacks only)");
  process.exit(1);
}
const specPath = process.argv[2];
if (!specPath) {
  console.error("seed-e2e: usage: seed-e2e <spec.json>");
  process.exit(1);
}
const spec = JSON.parse(readFileSync(specPath, "utf8")) as SeedSpec;
const secret = required("BETTER_AUTH_SECRET");
const db = createDb(required("DATABASE_URL"));
try {
  const auth = betterAuth({
    secret,
    baseURL: required("BETTER_AUTH_URL"),
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification, apikey } }),
    // The app's api-key plugin options (src/server/auth.ts); the hashing defaults must stay identical.
    plugins: [apiKey({ rateLimit: { enabled: false }, enableMetadata: true })],
    telemetry: { enabled: false },
  });
  const repos = createRepoService({ db, stores: createStoreSetFromEnv(process.env), secretKey: deriveSecretKey(secret) });
  const result = await applySeedSpec({ db, repos, auth, secret }, spec, process.env);
  console.error(`seed-e2e: ${spec.repos.length} repositories, tokens ${Object.keys(result.tokens).join(", ")}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(`seed-e2e: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}

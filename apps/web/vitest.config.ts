import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import shared from "@weaver/config/vitest.shared";

/** Dummy configuration so `src/env.ts` validates in tests; real secrets never reach tests. */
const testEnv = {
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_PATH: "./.test-storage",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  BETTER_AUTH_URL: "http://localhost:3000",
  GITHUB_CLIENT_ID: "test-github-id",
  GITHUB_CLIENT_SECRET: "test-github-secret",
};

export default mergeConfig(
  shared,
  defineConfig({
    // Mirrors the `@/*` path of tsconfig.json so route modules resolve the same way under Vitest.
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    // tsconfig keeps JSX as is for Next.js; tests compile it with the automatic runtime.
    oxc: { jsx: { runtime: "automatic" } },
    test: { env: testEnv, testTimeout: 30_000, hookTimeout: 120_000 },
  }),
);

/**
 * Playwright `webServer` command: starts a throwaway Postgres (testcontainers), records its URL in
 * `E2E_STATE_FILE` for the global setup, then runs `next dev` on `E2E_PORT` against it with the
 * environment Playwright passes (see `fixtures.ts`). Playwright starts this before the global
 * setup, which is why the database starts here. Runs with Node's built-in type stripping, so it
 * has no relative imports.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { startTestDb } from "@weaver/db/testing";

const port = process.env.E2E_PORT;
const stateFile = process.env.E2E_STATE_FILE;
if (!port || !stateFile) throw new Error("E2E_PORT and E2E_STATE_FILE must be set");

const testDb = await startTestDb();
mkdirSync(dirname(stateFile), { recursive: true });
writeFileSync(stateFile, JSON.stringify({ databaseUrl: testDb.url }));

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const server = spawn(process.execPath, [nextBin, "dev", "--port", port], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testDb.url },
});

let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  server.kill();
  await testDb.stop().catch(() => undefined);
  process.exit(code);
}

// On POSIX, Playwright's SIGTERM reaches the handlers below and the container is stopped cleanly.
// On Windows, Playwright force-kills the process tree, so these handlers never run and the
// container is removed by the testcontainers reaper (Ryuk) once this process's connection drops.
server.on("exit", (code) => void stop(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop(0));

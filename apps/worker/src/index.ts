import { createStoreSetFromEnv, deriveSecretKey } from "@weaver/core";
import { createDb } from "@weaver/db";
import { redisConnection } from "@weaver/jobs";
import { loadEnv } from "./env.js";
import { startWorker } from "./worker.js";

const env = loadEnv(process.env);
const db = createDb(env.DATABASE_URL);
const stores = createStoreSetFromEnv(env);
// Derived once at startup for the repository service the cleanups read repositories through.
const secretKey = deriveSecretKey(env.BETTER_AUTH_SECRET);
const running = await startWorker({ db, stores, secretKey, connection: redisConnection(env.VALKEY_URL) });
console.log("weaver-worker: processing cleanup jobs");

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`weaver-worker: ${signal} received, finishing the current job`);
  try {
    await running.close();
    await db.$client.end();
    process.exit(0);
  } catch (error) {
    console.error("weaver-worker: shutdown failed", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

import { createQueue, producerConnection, type MaintenanceQueue } from "@weaver/jobs";
import { env } from "@/env";

// Kept on globalThis so dev-mode module reloads reuse one connection instead of leaking one per reload.
const globalForJobs = globalThis as typeof globalThis & { __weaverMaintenanceQueue?: MaintenanceQueue };

/**
 * The process-wide producer queue for maintenance jobs, opened lazily with a fail-fast connection
 * (see `producerConnection`); `null` when `VALKEY_URL` is not configured.
 */
export function getCleanupQueue(): MaintenanceQueue | null {
  if (!env.VALKEY_URL) return null;
  globalForJobs.__weaverMaintenanceQueue ??= createQueue(producerConnection(env.VALKEY_URL));
  return globalForJobs.__weaverMaintenanceQueue;
}

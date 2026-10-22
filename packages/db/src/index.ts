import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export * from "./schema/index.js";
export { migrate } from "./migrate.js";

/** Drizzle database handle bound to the Weaver schema. */
export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** Transaction handle passed to `db.transaction` callbacks. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** How long a query may wait for a free pool connection before it fails: 30 s. */
export const POOL_CONNECTION_TIMEOUT_MS = 30_000;

/**
 * Opens a node-postgres pool for `url` and wraps it in a schema-aware drizzle instance.
 * Errors on idle pooled clients (for example a server restart) are logged rather than
 * left unhandled, so they don't crash the web or worker process; the pool discards the
 * broken client and opens a new one on the next query. Waiting for a free connection fails
 * after `connectionTimeoutMillis` (default {@link POOL_CONNECTION_TIMEOUT_MS}) instead of
 * hanging forever when the pool (default 10 connections) is exhausted.
 */
export function createDb(url: string, opts: { max?: number; connectionTimeoutMillis?: number } = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? POOL_CONNECTION_TIMEOUT_MS,
  });
  pool.on("error", (error) => {
    console.error("weaver: idle postgres client error", error);
  });
  return drizzle(pool, { schema });
}

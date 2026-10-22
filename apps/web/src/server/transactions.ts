import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, Tx } from "@weaver/db";

/**
 * Wraps `db` so that every `db.transaction(...)` started through the wrapper (Better Auth's drizzle
 * adapter runs `createUser` + `createAccount` that way) is visible to code running inside it.
 * `current()` returns the active transaction, or `db` outside of one, so hooks can write in the
 * same transaction as the insert that triggered them.
 */
export function trackTransactions(db: Db): { db: Db; current(): Db | Tx } {
  const active = new AsyncLocalStorage<Tx>();
  const tracked = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        const transaction: Db["transaction"] = (callback, config) =>
          target.transaction((tx) => active.run(tx, () => callback(tx)), config);
        return transaction;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { db: tracked, current: () => active.getStore() ?? db };
}

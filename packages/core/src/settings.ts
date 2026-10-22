import { setting, type Db } from "@weaver/db";
import { recordAudit } from "./audit.js";
import { RegistryError } from "./errors.js";
import { STORE_IDS, type StoreId } from "./storage/index.js";
import { isAdmin, type Principal } from "./permissions.js";

/** Server-wide settings that admins change on the Settings page. */
export interface ServerSettings {
  /** Whether visitors who aren't logged in may browse public repositories in the web UI. */
  anonymousView: boolean;
  /** The object store that new mirror caches use; the primary store until an admin picks another. */
  defaultCacheStore: StoreId;
}

const KEYS = ["anonymousView", "defaultCacheStore"] as const;

/**
 * Reads the server settings, falling back to the defaults for keys never stored or stored with the
 * wrong type. `defaultCacheStore` is the stored store while it is in `opts.configuredStores`, otherwise
 * `opts.primaryStore` (also when the stored store is no longer configured).
 */
export async function getSettings(db: Db, opts: { primaryStore: StoreId; configuredStores: StoreId[] }): Promise<ServerSettings> {
  const rows = await db.select({ key: setting.key, value: setting.value }).from(setting);
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const anonymousView = stored.get("anonymousView");
  const cacheStore = stored.get("defaultCacheStore");
  return {
    anonymousView: typeof anonymousView === "boolean" ? anonymousView : false,
    defaultCacheStore: STORE_IDS.find((id) => id === cacheStore && opts.configuredStores.includes(id)) ?? opts.primaryStore,
  };
}

/**
 * Applies a partial update as an admin, audited as `settings.update`, and returns the resulting
 * settings. `opts` names the configured stores and the primary one (see {@link getSettings}); a
 * `defaultCacheStore` outside `opts.configuredStores` is rejected with `invalid_request`.
 */
export async function updateSettings(
  db: Db,
  patch: Partial<ServerSettings>,
  actor: Principal,
  opts: { configuredStores: StoreId[]; primaryStore: StoreId },
): Promise<ServerSettings> {
  if (!isAdmin(actor)) throw new RegistryError("forbidden", "Only admins can change server settings");
  if (patch.defaultCacheStore !== undefined && !opts.configuredStores.includes(patch.defaultCacheStore)) {
    throw new RegistryError("invalid_request", `Storage "${patch.defaultCacheStore}" is not configured`);
  }
  const entries = Object.entries(patch).filter(
    ([key, value]) => (KEYS as readonly string[]).includes(key) && value !== undefined,
  );
  if (entries.length > 0) {
    await db.transaction(async (tx) => {
      for (const [key, value] of entries) {
        await tx.insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
      }
      await recordAudit(tx, { actor, action: "settings.update", target: "settings", details: Object.fromEntries(entries) });
    });
  }
  return getSettings(db, opts);
}

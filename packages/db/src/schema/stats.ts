import { bigint, date, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usageActionEnum } from "./content.js";
import { repository } from "./repository.js";

/**
 * Per-day usage totals of one package (or of the whole repository when `namespace` and `name` are
 * empty), rolled up from `usage_event`. The cache columns count mirror results.
 */
export const usageDaily = pgTable(
  "usage_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().default(""),
    name: text("name").notNull().default(""),
    action: usageActionEnum("action").notNull(),
    count: bigint("count", { mode: "number" }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    cacheHit: bigint("cache_hit", { mode: "number" }).notNull().default(0),
    cacheMiss: bigint("cache_miss", { mode: "number" }).notNull().default(0),
    cacheStale: bigint("cache_stale", { mode: "number" }).notNull().default(0),
    cacheBypass: bigint("cache_bypass", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.repositoryId, t.namespace, t.name, t.action] }),
    index("usage_daily_day_idx").on(t.day),
  ],
);

/**
 * Per-day usage totals of one API key in one repository. `apiKeyId` has no foreign key so the
 * history outlives deleted keys.
 */
export const usageDailyToken = pgTable(
  "usage_daily_token",
  {
    day: date("day", { mode: "string" }).notNull(),
    apiKeyId: text("api_key_id").notNull(),
    userId: text("user_id"),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    action: usageActionEnum("action").notNull(),
    count: bigint("count", { mode: "number" }).notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.apiKeyId, t.repositoryId, t.action] }),
    index("usage_daily_token_key_day_idx").on(t.apiKeyId, t.day),
  ],
);

/** The stored bytes and asset count of a repository, measured once per day. */
export const storageSnapshot = pgTable(
  "storage_snapshot",
  {
    day: date("day", { mode: "string" }).notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    hostedBytes: bigint("hosted_bytes", { mode: "number" }).notNull(),
    cacheBytes: bigint("cache_bytes", { mode: "number" }).notNull(),
    assetCount: bigint("asset_count", { mode: "number" }).notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.day, t.repositoryId] })],
);

import { sql } from "drizzle-orm";
import { bigint, bigserial, index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, repository, updatedAt } from "./repository.js";

/** Whether an asset was published to its repository or cached from an upstream. */
export const assetOriginEnum = pgEnum("asset_origin", ["hosted", "cache"]);
/** What a usage event records. */
export const usageActionEnum = pgEnum("usage_action", ["download", "upload", "delete"]);
/** How a mirror served a request relative to its cache. */
export const cacheResultEnum = pgEnum("cache_result", ["hit", "miss", "bypass", "stale"]);

/** Identifies the object store a row's bytes live in; the same values as `StoreId` of `@weaver/core`. */
export type StoreIdColumn = "local" | "s3";

/**
 * A versioned unit of any format (a Maven GAV, an npm package version, a Docker tag, a proto
 * version kept beside its `proto_*` rows), the target of search and download counts.
 * `namespace` and `version` are empty strings when the format has none.
 */
export const component = pgTable(
  "component",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().default(""),
    name: text("name").notNull(),
    version: text("version").notNull().default(""),
    /** Lower-cased `namespace name` with `:` and `/` as spaces; the target of trigram search. */
    searchText: text("search_text").generatedAlwaysAs(
      sql`btrim(lower(translate(namespace || ' ' || name, ':/', '  ')))`,
    ),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    downloadCount: bigint("download_count", { mode: "number" }).notNull().default(0),
    lastDownloadedAt: timestamp("last_downloaded_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("component_coordinate_uq").on(t.repositoryId, t.namespace, t.name, t.version),
    index("component_search_text_trgm").using("gin", sql`search_text gin_trgm_ops`),
  ],
);

/**
 * One stored file of a repository at a format-specific `path`, with its bytes at `storageKey` in
 * store `store`. `expiresAt` is the metadata TTL of a cached asset; null means immutable.
 */
export const asset = pgTable(
  "asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    componentId: uuid("component_id").references(() => component.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    store: text("store").$type<StoreIdColumn>().notNull(),
    storageKey: text("storage_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    md5: text("md5").notNull(),
    sha1: text("sha1").notNull(),
    sha256: text("sha256").notNull(),
    sha512: text("sha512").notNull(),
    origin: assetOriginEnum("origin").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    downloadCount: bigint("download_count", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("asset_repository_path_uq").on(t.repositoryId, t.path),
    index("asset_repository_origin_accessed_idx").on(t.repositoryId, t.origin, t.lastAccessedAt),
    index("asset_component_idx").on(t.componentId),
  ],
);

/** One download, upload or delete, kept for usage statistics. */
export const usageEvent = pgTable(
  "usage_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    repositoryId: uuid("repository_id").references(() => repository.id, { onDelete: "set null" }),
    componentId: uuid("component_id").references(() => component.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    action: usageActionEnum("action").notNull(),
    cache: cacheResultEnum("cache"),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    userId: text("user_id"),
    apiKeyId: text("api_key_id"),
  },
  (t) => [index("usage_event_at_idx").on(t.at), index("usage_event_api_key_at_idx").on(t.apiKeyId, t.at)],
);

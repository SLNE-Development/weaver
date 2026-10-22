import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apikey } from "./auth.js";

/** The package format a repository serves. */
export const repoFormatEnum = pgEnum("repo_format", ["maven", "npm", "docker", "proto"]);
/** How a repository gets its content: published to it, proxied from upstreams, or merged from members. */
export const repoKindEnum = pgEnum("repo_kind", ["hosted", "mirror", "group"]);
/** Whether anonymous users may read a repository. */
export const visibilityEnum = pgEnum("visibility", ["public", "private"]);
/** The access level an API key permission grants. */
export const accessEnum = pgEnum("access", ["read", "write"]);
/** How a mirror authenticates against an upstream. */
export const upstreamAuthEnum = pgEnum("upstream_auth", ["none", "basic", "bearer"]);
/** The rules a cleanup policy can apply. */
export const cleanupKindEnum = pgEnum("cleanup_kind", [
  "keep_last_snapshot_builds",
  "delete_stale_snapshots",
  "delete_not_downloaded",
  "keep_last_versions",
  "delete_untagged_manifests",
  "keep_last_tags",
]);

/** A `created_at timestamptz not null default now()` column. */
export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** An `updated_at timestamptz not null default now()` column, refreshed by drizzle on every update. */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * A repository of one format and kind. Names are unique across all formats. Format- and
 * kind-specific settings live in `config`. At most one docker repository is the `docker_root`,
 * served for image names without a repository prefix.
 */
export const repository = pgTable(
  "repository",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    format: repoFormatEnum("format").notNull(),
    kind: repoKindEnum("kind").notNull(),
    description: text("description"),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    dockerRoot: boolean("docker_root").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("repository_docker_root_uq").on(t.dockerRoot).where(sql`${t.dockerRoot}`)],
);

/**
 * One upstream of a mirror repository, tried in ascending `position`. `secret` holds the
 * encrypted password or token, never plaintext.
 */
export const repositoryUpstream = pgTable(
  "repository_upstream",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    url: text("url").notNull(),
    authType: upstreamAuthEnum("auth_type").notNull().default("none"),
    username: text("username"),
    secret: text("secret"),
  },
  (t) => [unique("repository_upstream_position_uq").on(t.repositoryId, t.position)],
);

/** Membership of a hosted or mirror repository in a group, searched in ascending `position`. */
export const groupMember = pgTable(
  "group_member",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.memberId] }),
    unique("group_member_position_uq").on(t.groupId, t.position),
  ],
);

/** One scope entry of an API key: a repository, an optional group prefix, and an access level. */
export const repoPermission = pgTable(
  "repo_permission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apikey.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    groupPrefix: text("group_prefix"),
    access: accessEnum("access").notNull(),
  },
  // Every authenticated API request loads its key's permissions by key id.
  (t) => [index("repo_permission_api_key_id_idx").on(t.apiKeyId)],
);

/** A cleanup rule of a repository; `kind` selects the rule and `value` is its count or days. */
export const cleanupPolicy = pgTable("cleanup_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repository.id, { onDelete: "cascade" }),
  kind: cleanupKindEnum("kind").notNull(),
  value: integer("value").notNull(),
  includeReleases: boolean("include_releases").notNull().default(false),
  groupPrefix: text("group_prefix"),
  /** Glob of the tags a keep_last_tags policy applies to; null for the other kinds. */
  pattern: text("pattern"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

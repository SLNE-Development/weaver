import { boolean, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { StoreIdColumn } from "./content.js";
import { createdAt, repository, updatedAt } from "./repository.js";

/** A proto artifact (`group:name`) of a proto repository. */
export const protoArtifact = pgTable(
  "proto_artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    group: text("group").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("proto_artifact_repository_group_name_uq").on(t.repositoryId, t.group, t.name)],
);

/** One version of a proto artifact; snapshots collect numbered builds. */
export const protoVersion = pgTable(
  "proto_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => protoArtifact.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    isSnapshot: boolean("is_snapshot").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("proto_version_artifact_version_uq").on(t.artifactId, t.version)],
);

/** One published build of a proto version; its archive is at `storageKey` in store `store`. */
export const protoBuild = pgTable(
  "proto_build",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => protoVersion.id, { onDelete: "cascade" }),
    buildNumber: integer("build_number").notNull(),
    store: text("store").$type<StoreIdColumn>().notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    publishedByUserId: text("published_by_user_id"),
    publishedByKeyId: text("published_by_key_id"),
    downloadCount: integer("download_count").notNull().default(0),
    lastDownloadedAt: timestamp("last_downloaded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("proto_build_version_number_uq").on(t.versionId, t.buildNumber)],
);

/** One `.proto` file of a build, kept as text for browsing and validation. */
export const protoBuildFile = pgTable(
  "proto_build_file",
  {
    buildId: uuid("build_id")
      .notNull()
      .references(() => protoBuild.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.buildId, t.path] })],
);

/** A declared direct dependency of a build on another proto coordinate. */
export const protoDependency = pgTable(
  "proto_dependency",
  {
    buildId: uuid("build_id")
      .notNull()
      .references(() => protoBuild.id, { onDelete: "cascade" }),
    depGroup: text("dep_group").notNull(),
    depName: text("dep_name").notNull(),
    depVersion: text("dep_version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.buildId, t.depGroup, t.depName] }),
    index("proto_dependency_target_idx").on(t.depGroup, t.depName, t.depVersion),
  ],
);

/**
 * Tombstone of a deleted release version: its coordinate and the sha256 of the deleted archive.
 * While a repository disallows redeploy, the release may only be published again with identical
 * content; the tombstone is removed when it is.
 */
export const protoDeletedRelease = pgTable(
  "proto_deleted_release",
  {
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    group: text("group").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.group, t.name, t.version] })],
);

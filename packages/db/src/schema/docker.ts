import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { StoreIdColumn } from "./content.js";
import { createdAt, repository, updatedAt } from "./repository.js";

/** A Postgres `bytea` column mapped to a Node `Buffer`. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** One platform a manifest list or image index entry targets. */
export interface DockerPlatform {
  os: string;
  architecture: string;
  variant?: string;
}

/**
 * A content-addressed blob (layer or config) stored once per object store and shared by every
 * repository that links to it. `lastLinkedAt` records the latest link, for garbage collection.
 */
export const dockerBlob = pgTable(
  "docker_blob",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    store: text("store").$type<StoreIdColumn>().notNull(),
    digest: text("digest").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: createdAt(),
    lastLinkedAt: timestamp("last_linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("docker_blob_store_digest_uq").on(t.store, t.digest)],
);

/** Makes a blob visible under one image of one repository, addressed by its digest. */
export const dockerBlobLink = pgTable(
  "docker_blob_link",
  {
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    image: text("image").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => dockerBlob.id, { onDelete: "cascade" }),
    digest: text("digest").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.image, t.digest] }),
    index("docker_blob_link_blob_id_idx").on(t.blobId),
  ],
);

/**
 * An image manifest, image index or artifact manifest of one image, stored inline as `content`.
 * `size` is the byte length of the manifest itself; `totalSize` is config plus layers, or the sum of children.
 */
export const dockerManifest = pgTable(
  "docker_manifest",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    image: text("image").notNull(),
    digest: text("digest").notNull(),
    mediaType: text("media_type").notNull(),
    artifactType: text("artifact_type"),
    subjectDigest: text("subject_digest"),
    annotations: jsonb("annotations").$type<Record<string, string>>(),
    platforms: jsonb("platforms").$type<DockerPlatform[]>().notNull().default([]),
    size: bigint("size", { mode: "number" }).notNull(),
    totalSize: bigint("total_size", { mode: "number" }).notNull(),
    content: bytea("content").notNull(),
    createdAt: createdAt(),
    lastPulledAt: timestamp("last_pulled_at", { withTimezone: true }),
    pullCount: bigint("pull_count", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    unique("docker_manifest_repo_image_digest_uq").on(t.repositoryId, t.image, t.digest),
    index("docker_manifest_subject_idx").on(t.repositoryId, t.image, t.subjectDigest),
  ],
);

/** A blob or child manifest that a manifest references, in its original order. */
export const dockerManifestRef = pgTable(
  "docker_manifest_ref",
  {
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => dockerManifest.id, { onDelete: "cascade" }),
    digest: text("digest").notNull(),
    kind: text("kind").$type<"blob" | "manifest">().notNull(),
    mediaType: text("media_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.manifestId, t.digest] }),
    index("docker_manifest_ref_digest_idx").on(t.digest),
  ],
);

/** A mutable tag pointing at a manifest of an image. */
export const dockerTag = pgTable(
  "docker_tag",
  {
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    image: text("image").notNull(),
    tag: text("tag").notNull(),
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => dockerManifest.id, { onDelete: "cascade" }),
    updatedAt: updatedAt(),
    lastPulledAt: timestamp("last_pulled_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.image, t.tag] }),
    index("docker_tag_manifest_id_idx").on(t.manifestId),
  ],
);

/** An in-progress chunked blob upload; `offset` is the number of bytes received so far. */
export const dockerUpload = pgTable(
  "docker_upload",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    image: text("image").notNull(),
    offset: bigint("offset", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("docker_upload_updated_at_idx").on(t.updatedAt)],
);

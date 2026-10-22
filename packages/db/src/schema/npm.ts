import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { apikey, user } from "./auth.js";
import { createdAt, repository, updatedAt } from "./repository.js";

/** Lifecycle states of a browser-based `npm login` session. */
export const npmLoginStatusEnum = ["pending", "approved", "denied"] as const;

/** One state of {@link npmLoginStatusEnum}. */
export type NpmLoginStatus = (typeof npmLoginStatusEnum)[number];

/**
 * A hosted npm package of one repository, stored as its whole packument `document`.
 * `name` is the full package name (for example `@acme/ui`); `rev` increments on every write.
 */
export const npmPackage = pgTable(
  "npm_package",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    rev: integer("rev").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("npm_package_repo_name_uq").on(t.repositoryId, t.name)],
);

/**
 * A web-based `npm login` session. `id` is a random 32-byte base64url value, `pollHash` the hex
 * SHA-256 of the poll secret. Once approved, `tokenCiphertext` holds the encrypted token until the
 * client collects it, and `apiKeyId` the issued key. `requesterIp` and `requesterUserAgent` describe the
 * CLI that started the login, shown on the approval page.
 */
export const npmLoginSession = pgTable(
  "npm_login_session",
  {
    id: text("id").primaryKey(),
    pollHash: text("poll_hash").notNull().unique(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repository.id, { onDelete: "cascade" }),
    status: text("status").$type<NpmLoginStatus>().notNull().default("pending"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    tokenCiphertext: text("token_ciphertext"),
    /** The key issued on approval, deleted again when the session expires uncollected. */
    apiKeyId: text("api_key_id").references(() => apikey.id, { onDelete: "set null" }),
    /** Client IP of the CLI that started the login (first `x-forwarded-for` entry), when known. */
    requesterIp: text("requester_ip"),
    /** `user-agent` of the CLI that started the login, when sent. */
    requesterUserAgent: text("requester_user_agent"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("npm_login_session_expires_at_idx").on(t.expiresAt),
    index("npm_login_session_requester_ip_idx").on(t.requesterIp),
  ],
);

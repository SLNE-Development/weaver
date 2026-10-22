import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  canAccess,
  formatCoordinate,
  isValidGroup,
  isValidRepositoryName,
  recordAudit,
  type AuditEntry,
  type Coordinate,
  type Format,
  type Principal,
  type RepoRef,
} from "@weaver/core";
import { repository, type Db, type Tx } from "@weaver/db";

/** A repository name (`^[a-z0-9][a-z0-9-]{0,62}$`). */
export const repositoryName = z.string().refine(isValidRepositoryName, "Invalid repository name");

/** An optional group prefix; `null` (or omitted) covers every group. */
export const groupPrefix = z
  .string()
  .refine(isValidGroup, "Invalid group prefix")
  .nullable()
  .optional()
  .transform((value) => value ?? null);

/** A `group:name:version` coordinate, parsed by the procedures (malformed → `BAD_REQUEST`). */
export const coordinateString = z.string().min(1).max(300);

/** A coordinate as the routers send it: `group:name:version`. */
export const coordinateText = (c: Coordinate): string => formatCoordinate(c);

export type RepositoryRow = typeof repository.$inferSelect;

export function notFound(message: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message });
}

/**
 * Whether the principal may browse the repository at all (some group in it): public repositories
 * for everyone, every repository for users, and the repositories named in an API key's entries.
 */
export function canBrowseRepository(p: Principal, repo: RepoRef): boolean {
  if (repo.visibility === "public") return true;
  switch (p.kind) {
    case "anonymous":
      return false;
    case "user":
      return true;
    case "apikey":
      return p.permissions.some((entry) => entry.repositoryId === repo.id);
  }
}

/** Whether the principal may read the given group of the repository. */
export function canReadGroup(p: Principal, repo: RepoRef, group: string): boolean {
  return canAccess(p, repo, group, "read");
}

/** Every repository the principal may browse, by name. */
export async function browsableRepositories(db: Db, p: Principal): Promise<RepositoryRow[]> {
  const rows = await db.select().from(repository).orderBy(asc(repository.name));
  return rows.filter((repo) => canBrowseRepository(p, repo));
}

/** `BAD_REQUEST` unless `repo` has the `format` a procedure needs (when one is given). */
function checkFormat(repo: RepositoryRow, format: Format | undefined): void {
  if (format !== undefined && repo.format !== format) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Repository ${repo.name} is a ${repo.format} repository, not ${format}` });
  }
}

/**
 * A repository the principal may browse. Missing and hidden repositories both throw the same
 * `NOT_FOUND`, so private repositories are not disclosed. With `format`, a browsable repository
 * of another format is `BAD_REQUEST` (format-specific listings such as proto artifacts).
 */
export async function requireBrowsableRepository(
  db: Db,
  p: Principal,
  name: string,
  opts: { format?: Format } = {},
): Promise<RepositoryRow> {
  const [repo] = await db.select().from(repository).where(eq(repository.name, name));
  if (!repo || !canBrowseRepository(p, repo)) throw notFound(`Repository ${name} was not found`);
  checkFormat(repo, opts.format);
  return repo;
}

/**
 * A repository by name for admin procedures; `NOT_FOUND` when missing, `BAD_REQUEST` when `format`
 * is given and the repository has another one (e.g. a proto-only listing). With
 * `forUpdate` (inside a transaction) the row stays locked, which also blocks concurrent inserts of
 * artifacts into it.
 */
export async function requireRepository(
  db: Db | Tx,
  name: string,
  opts: { forUpdate?: boolean; format?: Format } = {},
): Promise<RepositoryRow> {
  const query = db.select().from(repository).where(eq(repository.name, name));
  const [repo] = await (opts.forUpdate ? query.for("update") : query);
  if (!repo) throw notFound(`Repository ${name} was not found`);
  checkFormat(repo, opts.format);
  return repo;
}

/** Runs `change` in a transaction and records `entry` in the audit log in the same transaction. */
export async function audited<T>(db: Db, entry: AuditEntry | ((result: T) => AuditEntry), change: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await change(tx);
    await recordAudit(tx, typeof entry === "function" ? entry(result) : entry);
    return result;
  });
}

/** Escapes `%`, `_` and `\` for a `LIKE` / `ILIKE` pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

import { createHash } from "node:crypto";
import { and, asc, countDistinct, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { RegistryError } from "@weaver/core";
import { npmPackage, type Db, type Tx } from "@weaver/db";
import type { Packument } from "./packument.js";

/** A database handle or an open transaction. */
export type DbOrTx = Db | Tx;

/** Hosted packuments of npm repositories, one row per package with a revision counter. */
export interface NpmStore {
  /** The stored packument and its revision, or null; reads through `tx` when given. */
  get(repoId: string, name: string, tx?: DbOrTx): Promise<{ document: Packument; rev: number } | null>;
  /** Runs `fn` inside a transaction holding pg_advisory_xact_lock(hashtext(repoId || ':' || name)). */
  locked<T>(repoId: string, name: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Inserts (`expectedRev` null) or replaces the packument at `expectedRev`; returns the new rev, 409 when the rev moved on. */
  save(tx: DbOrTx, repoId: string, name: string, document: Packument, expectedRev: number | null): Promise<number>;
  /** Deletes the package row. */
  remove(tx: DbOrTx, repoId: string, name: string): Promise<void>;
  /**
   * Packages of the repositories whose name, description or keywords contain `text`, exact name first, then by name.
   * A name found in several repositories counts once and comes from the earliest repository in `repoIds`.
   */
  search(repoIds: string[], text: string, size: number, from: number): Promise<{ total: number; documents: Packument[] }>;
  /** Which of `names` exist as packages in any of the repositories. */
  existing(repoIds: string[], names: string[]): Promise<Set<string>>;
}

/** JSON with object keys sorted at every level, so equal documents serialize equally whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The CouchDB-style `_rev` of a packument: `${rev}-${first 16 hex of sha256(JSON)}`, independent of key order. */
export function formatRev(rev: number, document: Packument): string {
  return `${rev}-${createHash("sha256").update(canonicalJson(withoutRev(document))).digest("hex").slice(0, 16)}`;
}

/** A shallow copy of the packument without `_rev`, which is derived and never stored. */
function withoutRev(document: Packument): Packument {
  const copy = { ...document };
  delete copy._rev;
  return copy;
}

/** `value` with the LIKE wildcards `%`, `_` and the escape character `\` escaped. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Creates the npm package store over the database. */
export function createNpmStore(db: Db): NpmStore {
  return {
    async get(repoId, name, tx = db) {
      const [row] = await tx
        .select({ document: npmPackage.document, rev: npmPackage.rev })
        .from(npmPackage)
        .where(and(eq(npmPackage.repositoryId, repoId), eq(npmPackage.name, name)));
      return row ? { document: row.document as Packument, rev: row.rev } : null;
    },

    locked(repoId, name, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${repoId}:${name}`}))`);
        return fn(tx);
      });
    },

    async save(tx, repoId, name, document, expectedRev) {
      const stored = withoutRev(document);
      if (expectedRev === null) {
        const [row] = await tx
          .insert(npmPackage)
          .values({ repositoryId: repoId, name, document: stored, rev: 1 })
          .onConflictDoNothing()
          .returning({ rev: npmPackage.rev });
        if (!row) throw new RegistryError("immutable", "document update conflict");
        return row.rev;
      }
      const [row] = await tx
        .update(npmPackage)
        .set({ document: stored, rev: sql`${npmPackage.rev} + 1`, updatedAt: new Date() })
        .where(and(eq(npmPackage.repositoryId, repoId), eq(npmPackage.name, name), eq(npmPackage.rev, expectedRev)))
        .returning({ rev: npmPackage.rev });
      if (!row) throw new RegistryError("immutable", "document update conflict");
      return row.rev;
    },

    async remove(tx, repoId, name) {
      await tx.delete(npmPackage).where(and(eq(npmPackage.repositoryId, repoId), eq(npmPackage.name, name)));
    },

    async search(repoIds, text, size, from) {
      if (repoIds.length === 0) return { total: 0, documents: [] };
      const pattern = `%${escapeLike(text)}%`;
      const where = and(
        inArray(npmPackage.repositoryId, repoIds),
        or(
          ilike(npmPackage.name, pattern),
          sql`${npmPackage.document}->>'description' ILIKE ${pattern}`,
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${npmPackage.document}->'keywords') = 'array' THEN ${npmPackage.document}->'keywords' ELSE '[]'::jsonb END) AS k WHERE k ILIKE ${pattern})`,
        ),
      );
      const [{ total } = { total: 0 }] = await db.select({ total: countDistinct(npmPackage.name) }).from(npmPackage).where(where);
      const order = sql`array_position(ARRAY[${sql.join(
        repoIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[], ${npmPackage.repositoryId})`;
      const first = db
        .selectDistinctOn([npmPackage.name], { name: npmPackage.name, document: npmPackage.document })
        .from(npmPackage)
        .where(where)
        .orderBy(asc(npmPackage.name), order)
        .as("first");
      const rows = await db
        .select({ document: first.document })
        .from(first)
        .orderBy(sql`CASE WHEN lower(${first.name}) = lower(${text}) THEN 0 ELSE 1 END`, asc(first.name))
        .limit(size)
        .offset(from);
      return { total, documents: rows.map((r) => r.document as Packument) };
    },

    async existing(repoIds, names) {
      if (repoIds.length === 0 || names.length === 0) return new Set();
      const rows = await db
        .selectDistinct({ name: npmPackage.name })
        .from(npmPackage)
        // One array parameter, so any number of names stays within the protocol's 65,535 bind parameters.
        .where(and(inArray(npmPackage.repositoryId, repoIds), sql`${npmPackage.name} = ANY(${sql.param(names)}::text[])`));
      return new Set(rows.map((r) => r.name));
    },
  };
}

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrate, type Db } from "./index.js";
import { repository } from "./schema/index.js";
import { startTestDb } from "./testing.js";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

interface Journal {
  entries: { idx: number; tag: string }[];
}

/**
 * Test-only: applies the first `count` migrations listed in `drizzle/meta/_journal.json`, in
 * order, by migrating from a temporary folder holding just those files and a trimmed journal.
 * They are recorded like any other migration, so a later full `migrate()` resumes after them.
 */
async function migrateFirst(db: Db, count: number): Promise<void> {
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as Journal;
  const dir = await mkdtemp(join(tmpdir(), "weaver-migrations-"));
  try {
    await mkdir(join(dir, "meta"));
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx).slice(0, count);
    for (const { tag } of entries) await copyFile(join(migrationsFolder, `${tag}.sql`), join(dir, `${tag}.sql`));
    await writeFile(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
    await drizzleMigrate(db, { migrationsFolder: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const { rows } = await db.$client.query("select to_regclass($1) is not null as present", [`public.${name}`]);
  return (rows[0] as { present: boolean }).present;
}

describe("schema migrations", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("applies defaults to a freshly inserted repository", async () => {
    const { db } = testDb;
    await db.insert(repository).values({ name: "main", format: "proto", kind: "hosted" });
    const [row] = await db.select().from(repository).where(eq(repository.name, "main"));
    expect(row?.visibility).toBe("private");
    expect(row?.config).toEqual({});
    expect(row?.dockerRoot).toBe(false);
  });

  it("docker_root is unique when true", async () => {
    const { db } = testDb;
    await db.insert(repository).values([
      { name: "plain-a", format: "maven", kind: "hosted" },
      { name: "plain-b", format: "maven", kind: "hosted" },
      { name: "root-a", format: "docker", kind: "hosted", dockerRoot: true },
    ]);
    await expect(
      db.insert(repository).values({ name: "root-b", format: "docker", kind: "hosted", dockerRoot: true }),
    ).rejects.toThrow();
  });

  it("indexes repo_permission by api_key_id", async () => {
    const { rows } = await testDb.db.$client.query(
      "select indexdef from pg_indexes where tablename = 'repo_permission' and indexdef like '%(api_key_id)%'",
    );
    expect(rows).toHaveLength(1);
  });

  it("creates the proto_deleted_release tombstone table keyed by repository and coordinate", async () => {
    const { rows } = await testDb.db.$client.query(
      "select indexdef from pg_indexes where tablename = 'proto_deleted_release' and indexname like '%_pk'",
    );
    expect(rows).toEqual([{ indexdef: expect.stringContaining('(repository_id, "group", name, version)') }]);
  });
});

describe("reset migration", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDb(container.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  it("migration keeps users and accounts and drops keys and content", async () => {
    await migrateFirst(db, 5);
    const q = (text: string, values: unknown[] = []) => db.$client.query(text, values);
    await q(`insert into "user" (id, name, email) values ('u1', 'Ada', 'ada@example.com')`);
    await q(
      `insert into account (id, account_id, provider_id, user_id, updated_at) values ('a1', 'gh-1', 'github', 'u1', now())`,
    );
    await q(
      `insert into apikey (id, reference_id, key, created_at, updated_at) values ('k1', 'u1', 'hashed', now(), now())`,
    );
    const { rows } = await q(`insert into repository (name) values ('releases') returning id`);
    const repoId = (rows[0] as { id: string }).id;
    await q(`insert into api_key_permission (api_key_id, repository, access) values ('k1', 'releases', 'write')`);
    await q(`insert into artifact (repository_id, "group", name) values ($1, 'acme', 'money')`, [repoId]);

    await migrate(db);

    expect((await q(`select id from "user"`)).rows).toEqual([{ id: "u1" }]);
    expect((await q(`select id from account`)).rows).toEqual([{ id: "a1" }]);
    expect((await q(`select id from apikey`)).rows).toEqual([]);
    expect((await q(`select id from repository`)).rows).toEqual([]);
    expect(await tableExists(db, "artifact")).toBe(false);
    expect(await tableExists(db, "api_key_permission")).toBe(false);
    expect(await tableExists(db, "proto_artifact")).toBe(true);
  }, 120_000);
});

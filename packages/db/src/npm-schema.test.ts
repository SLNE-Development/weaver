import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { npmLoginSession, npmPackage, repository } from "./index.js";
import { startTestDb } from "./testing.js";

describe("npm schema", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  async function count(table: string): Promise<number> {
    const { rows } = await testDb.db.$client.query(`select count(*)::int as n from ${table}`);
    return (rows[0] as { n: number }).n;
  }

  it("npm tables exist and cascade with the repository", async () => {
    const [repo] = await testDb.db
      .insert(repository)
      .values({ name: "npm-cascade", format: "npm", kind: "hosted" })
      .returning();
    const repositoryId = repo!.id;

    await testDb.db.insert(npmPackage).values({ repositoryId, name: "@acme/ui", document: { name: "@acme/ui" } });
    await testDb.db.insert(npmLoginSession).values({
      id: "session-1",
      pollHash: "a".repeat(64),
      repositoryId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [pkg] = await testDb.db.select().from(npmPackage);
    expect(pkg!.rev).toBe(1);
    const [session] = await testDb.db.select().from(npmLoginSession);
    expect(session!.status).toBe("pending");
    expect(session!.userId).toBeNull();
    expect(session!.tokenCiphertext).toBeNull();

    await expect(
      testDb.db.insert(npmPackage).values({ repositoryId, name: "@acme/ui", document: {} }),
    ).rejects.toThrow();

    await testDb.db.$client.query("delete from repository where id = $1", [repositoryId]);
    expect(await count("npm_package")).toBe(0);
    expect(await count("npm_login_session")).toBe(0);
  });
});

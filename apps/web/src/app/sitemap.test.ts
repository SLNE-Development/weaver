import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setting, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import type { ServerContext } from "@/server/context";
import { insertRepository, insertVersion } from "@/test/catalog";
import sitemap from "./sitemap";

const holder = vi.hoisted(() => ({ db: undefined as Db | undefined, docs: [] as string[] }));

vi.mock("@/server/context", () => ({
  getServerContext: () => ({ db: holder.db, stores: { primary: { id: "local" }, configured: () => ["local"] } }) as unknown as ServerContext,
}));

vi.mock("@/lib/public-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/public-catalog")>();
  return { ...actual, listDocsPaths: async () => holder.docs };
});

describe("sitemap.xml", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
    holder.db = testDb.db;
    const releases = await insertRepository(testDb.db, "releases", "public");
    const internal = await insertRepository(testDb.db, "internal", "private");
    await insertVersion(testDb.db, releases, { group: "dev.surf.economy", name: "economy-contracts", version: "1.4.0" });
    await insertVersion(testDb.db, internal, { group: "dev.secret", name: "hidden-contracts", version: "1.0.0" });
    holder.docs = ["/docs", "/docs/gradle"];
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("lists the landing page and every docs page, and no browse pages while anonymous view is off", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toEqual(["http://localhost:3000/", "http://localhost:3000/docs", "http://localhost:3000/docs/gradle"]);
  });

  it("adds the browse pages of public repositories once anonymous view is on", async () => {
    await testDb.db.insert(setting).values({ key: "anonymousView", value: true });
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toContain("http://localhost:3000/browse/releases");
    expect(urls).toContain("http://localhost:3000/browse/releases/dev.surf.economy/economy-contracts/1.4.0");
    expect(urls.join(" ")).not.toMatch(/internal|hidden/);
  });

  it("still lists the static pages when the database is unreachable", async () => {
    const saved = holder.db;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    holder.db = {
      select: () => {
        throw new Error("connection refused");
      },
    } as unknown as Db;
    try {
      const urls = (await sitemap()).map((entry) => entry.url);
      expect(urls).toEqual(["http://localhost:3000/", "http://localhost:3000/docs", "http://localhost:3000/docs/gradle"]);
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
      holder.db = saved;
    }
  });
});

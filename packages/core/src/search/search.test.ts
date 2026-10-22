import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { asset, component, groupMember, repository } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { deriveSecretKey } from "../crypto.js";
import type { KeyPermission, Principal } from "../permissions.js";
import type { Format, Kind } from "../repos/config.js";
import { createRepoService, type RepoService } from "../repos/service.js";
import { createStoreSetFromEnv } from "../storage/index.js";
import { parseSearchQuery } from "./query.js";
import { buildSearchQuery, SEARCH_MATCH_MAX, searchComponents, type SearchHit, type SearchOptions } from "./search.js";

/** Fixed repository ids, so key principals can be built before the rows exist. */
const ids = {
  mavenHosted: "00000000-0000-4000-8000-000000000101",
  npmHosted: "00000000-0000-4000-8000-000000000102",
  dockerHosted: "00000000-0000-4000-8000-000000000103",
  protoHosted: "00000000-0000-4000-8000-000000000104",
  mavenCached: "00000000-0000-4000-8000-000000000105",
  mavenUncached: "00000000-0000-4000-8000-000000000106",
  npmPublic: "00000000-0000-4000-8000-000000000107",
  mavenGroup: "00000000-0000-4000-8000-000000000108",
  protoGroup: "00000000-0000-4000-8000-000000000109",
  bulk: "00000000-0000-4000-8000-000000000110",
} as const;

const repoRows: { id: string; name: string; format: Format; kind: Kind; visibility?: "public" | "private" }[] = [
  { id: ids.mavenHosted, name: "maven-hosted", format: "maven", kind: "hosted" },
  { id: ids.npmHosted, name: "npm-hosted", format: "npm", kind: "hosted" },
  { id: ids.dockerHosted, name: "docker-hosted", format: "docker", kind: "hosted" },
  { id: ids.protoHosted, name: "proto-hosted", format: "proto", kind: "hosted" },
  { id: ids.mavenCached, name: "maven-cached", format: "maven", kind: "mirror" },
  { id: ids.mavenUncached, name: "maven-uncached", format: "maven", kind: "mirror" },
  { id: ids.npmPublic, name: "npm-public", format: "npm", kind: "hosted", visibility: "public" },
  { id: ids.mavenGroup, name: "maven-group", format: "maven", kind: "group" },
  { id: ids.protoGroup, name: "proto-group", format: "proto", kind: "group" },
];

const admin: Principal = { kind: "user", userId: "admin", role: "admin" };
const anonymous: Principal = { kind: "anonymous" };

function readKey(entries: { id: string; name: string; prefix?: string }[]): Principal {
  const permissions: KeyPermission[] = entries.map((e) => ({
    repositoryId: e.id,
    repository: e.name,
    groupPrefix: e.prefix ?? null,
    access: "read",
  }));
  return { kind: "apikey", keyId: "key", userId: "user", role: "viewer", permissions };
}

const labels = (hits: SearchHit[]) => hits.map((h) => h.label);
const repositories = (hits: SearchHit[]) => [...new Set(hits.map((h) => h.repository))].sort();

describe("searchComponents", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let repos: RepoService;

  const search = (p: Principal, text: string, opts: Partial<SearchOptions> = {}) =>
    searchComponents({ db: testDb.db, repos }, p, { text, limit: 50, offset: 0, ...opts });

  let created = 0;
  /** Inserts one component per version (created in the given order) and, unless `assets` is false, one asset each. */
  async function seed(repositoryId: string, namespace: string, name: string, versions: string[], opts: { downloads?: number; assets?: boolean } = {}) {
    for (const version of versions) {
      created += 1;
      const [row] = await testDb.db
        .insert(component)
        .values({
          repositoryId,
          namespace,
          name,
          version,
          downloadCount: opts.downloads ?? 0,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, created)),
        })
        .returning({ id: component.id });
      if (opts.assets === false) continue;
      await testDb.db.insert(asset).values({
        repositoryId,
        componentId: row!.id,
        path: `${namespace}/${name}/${version}/${created}`,
        store: "local",
        storageKey: `k/${created}`,
        size: 1,
        md5: "",
        sha1: "",
        sha256: "",
        sha512: "",
        origin: "hosted",
      });
    }
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-search-"));
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    repos = createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("search-test") });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository CASCADE`);
    await testDb.db.insert(repository).values(repoRows.map((r) => ({ ...r, visibility: r.visibility ?? "private" })));
    await testDb.db.insert(groupMember).values([
      { groupId: ids.mavenGroup, memberId: ids.mavenHosted, position: 0 },
      { groupId: ids.mavenGroup, memberId: ids.mavenCached, position: 1 },
      { groupId: ids.protoGroup, memberId: ids.protoHosted, position: 0 },
    ]);
    await seed(ids.mavenHosted, "org.apache", "commons-lang3", ["3.13", "3.14"]);
    await seed(ids.mavenHosted, "org.x", "lib", ["1.0"]);
    await seed(ids.npmHosted, "", "lib", ["1.0.0"]);
    await seed(ids.npmHosted, "", "libfoo", ["1.0.0"], { downloads: 50 });
    await seed(ids.npmHosted, "", "my-lib", ["1.0.0"], { downloads: 100 });
    await seed(ids.npmHosted, "acme", "ui", ["1.2.0", "1.3.0"]);
    await seed(ids.dockerHosted, "", "library/nginx", ["1.27", "latest"]);
    await seed(ids.dockerHosted, "", "team/app", ["latest"]);
    await seed(ids.protoHosted, "dev.slne", "money", ["1.0.0"]);
    await seed(ids.protoHosted, "dev.slne.economy", "bank", ["1.0.0"]);
    await seed(ids.protoHosted, "dev.slneother", "money", ["1.0.0"]);
    await seed(ids.protoHosted, "acme", "money", ["1.0.0"]);
    await seed(ids.mavenCached, "org.cached", "cached-lib", ["1.0"]);
    await seed(ids.mavenUncached, "org.uncached", "uncached-lib", ["1.0"], { assets: false });
    await seed(ids.npmPublic, "", "public-lib", ["1.0.0"]);
  });

  it("finds by maven coordinates with and without version", async () => {
    for (const text of ["org.apache:commons-lang3:3.14", "org.apache:commons-lang3", "commons-lang3"]) {
      const { hits } = await search(admin, text);
      expect(labels(hits)[0]).toBe("org.apache:commons-lang3");
    }
  });

  it("by npm scoped name", async () => {
    for (const text of ["@acme/ui", "@acme/ui@1.2.0", "acme/ui"]) {
      const { hits } = await search(admin, text);
      expect(hits[0]).toMatchObject({ label: "@acme/ui", repository: "npm-hosted", format: "npm" });
    }
  });

  it("by docker image name with tag", async () => {
    const { hits } = await search(admin, "library/nginx:1.27");
    expect(hits[0]).toMatchObject({ label: "library/nginx", repository: "docker-hosted", format: "docker", kind: "hosted" });
  });

  it("by proto group:name", async () => {
    const { hits } = await search(admin, "dev.slne:money");
    expect(hits[0]).toMatchObject({ label: "dev.slne:money", repository: "proto-hosted", format: "proto" });
  });

  it("ranks exact before prefix before fuzzy", async () => {
    const { hits } = await search(admin, "lib", { format: "npm" });
    expect(labels(hits).slice(0, 3)).toEqual(["lib", "libfoo", "my-lib"]);
  });

  it("format filter", async () => {
    const { hits } = await search(admin, "lib", { format: "maven" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.format === "maven")).toBe(true);
  });

  it("one hit per package with latestVersion and versionCount", async () => {
    const { hits } = await search(admin, "commons-lang3");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ latestVersion: "3.14", versionCount: 2, downloads: 0, via: null, namespace: "org.apache", name: "commons-lang3" });
    expect(hits[0]!.updatedAt).toBeInstanceOf(Date);
  });

  it("mirror components without assets are not returned", async () => {
    expect(labels((await search(admin, "cached-lib")).hits)).toEqual(["org.cached:cached-lib"]);
    expect((await search(admin, "uncached")).hits).toEqual([]);
  });

  it("pages with limit and offset", async () => {
    const all = (await search(admin, "lib")).hits;
    const first = await search(admin, "lib", { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.hits).toEqual(all.slice(0, 2));
    const rest = await search(admin, "lib", { limit: 50, offset: 2 });
    expect(rest.hasMore).toBe(false);
    expect(rest.hits).toEqual(all.slice(2));
  });

  it("escapes LIKE wildcards in terms", async () => {
    expect((await search(admin, "l%b")).hits).toEqual([]);
    expect((await search(admin, "l_b")).hits).toEqual([]);
  });

  it("rejects bad options", async () => {
    await expect(search(admin, "x")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(search(admin, "@ @")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(search(admin, "a b")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(search(admin, "lib", { limit: 51 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(search(admin, "lib", { offset: 1001 })).rejects.toMatchObject({ code: "invalid_request" });
  });

  describe("permission filtering", () => {
    it("anonymous sees only public repos", async () => {
      expect(repositories((await search(anonymous, "lib")).hits)).toEqual(["npm-public"]);
      expect((await search(anonymous, "money")).hits).toEqual([]);
    });

    it("a key with read on repo A never sees repo B packages", async () => {
      const key = readKey([{ id: ids.mavenHosted, name: "maven-hosted" }]);
      expect(repositories((await search(key, "lib")).hits)).toEqual(["maven-hosted", "npm-public"]);
      expect((await search(key, "ui")).hits.some((h) => h.repository === "npm-hosted")).toBe(false);
    });

    it('a proto key with groupPrefix "dev.slne" sees dev.slne.* only', async () => {
      const key = readKey([{ id: ids.protoHosted, name: "proto-hosted", prefix: "dev.slne" }]);
      expect(labels((await search(key, "money")).hits)).toEqual(["dev.slne:money"]);
      expect(labels((await search(key, "dev")).hits).sort()).toEqual(["dev.slne.economy:bank", "dev.slne:money"]);
      expect((await search(key, "lib")).hits.every((h) => h.repository === "npm-public")).toBe(true);
    });

    it("a prefix on a proto group narrows what is read through it", async () => {
      const key = readKey([{ id: ids.protoGroup, name: "proto-group", prefix: "dev.slne" }]);
      const { hits } = await search(key, "money");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ label: "dev.slne:money", repository: "proto-hosted", via: "proto-group" });
    });

    it("a key with read on a group sees member packages with via = group name and repository = member name", async () => {
      const key = readKey([{ id: ids.mavenGroup, name: "maven-group" }]);
      const { hits } = await search(key, "commons-lang3");
      expect(hits).toEqual([expect.objectContaining({ repository: "maven-hosted", via: "maven-group", kind: "hosted" })]);
      expect((await search(key, "cached-lib")).hits).toEqual([
        expect.objectContaining({ repository: "maven-cached", via: "maven-group", kind: "mirror" }),
      ]);
      expect(repositories((await search(key, "lib")).hits)).toEqual(["maven-cached", "maven-hosted", "npm-public"]);
    });

    it("a key with read on the member itself gets via = null", async () => {
      const key = readKey([
        { id: ids.mavenGroup, name: "maven-group" },
        { id: ids.mavenHosted, name: "maven-hosted" },
      ]);
      const { hits } = await search(key, "commons-lang3");
      expect(hits).toEqual([expect.objectContaining({ repository: "maven-hosted", via: null })]);
    });
  });

  it("caps the components one search matches", async () => {
    const versions = Array.from({ length: SEARCH_MATCH_MAX + 100 }, (_, i) => ({ repositoryId: ids.mavenHosted, namespace: "org.cap", name: "capped", version: `1.${i}` }));
    for (let i = 0; i < versions.length; i += 1000) await testDb.db.insert(component).values(versions.slice(i, i + 1000));
    const { hits } = await search(admin, "capped");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.versionCount).toBe(SEARCH_MATCH_MAX);

    const scope = { full: [ids.mavenHosted], prefixed: [], mirrors: [], names: { [ids.mavenHosted]: "maven-hosted" } };
    const { rows } = await testDb.db.execute<{ versionCount: string }>(
      buildSearchQuery(testDb.db, parseSearchQuery("capped"), scope, { limit: 20, offset: 0, matchMax: 2 }),
    );
    expect(rows.map((r) => Number(r.versionCount))).toEqual([2]);
  });

  it("uses the trigram index", async () => {
    await testDb.db.insert(repository).values({ id: ids.bulk, name: "bulk", format: "maven", kind: "hosted" });
    const hash = (i: number) => createHash("sha1").update(String(i)).digest("hex").slice(0, 10);
    const rows = Array.from({ length: 5000 }, (_, i) => ({ repositoryId: ids.bulk, namespace: `org.bulk${i % 50}`, name: `artifact-${hash(i)}`, version: "1.0" }));
    for (let i = 0; i < rows.length; i += 1000) await testDb.db.insert(component).values(rows.slice(i, i + 1000));
    await testDb.db.execute(sql`ANALYZE component`);
    const query = buildSearchQuery(testDb.db, parseSearchQuery(hash(42)), { full: [ids.bulk], prefixed: [], mirrors: [], names: { [ids.bulk]: "bulk" } }, { limit: 20, offset: 0 });
    const plan = await testDb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const result = await tx.execute(sql`EXPLAIN ${query}`);
      return result.rows.map((r) => Object.values(r).join(" ")).join("\n");
    });
    expect(plan).toContain("component_search_text_trgm");
  });
});

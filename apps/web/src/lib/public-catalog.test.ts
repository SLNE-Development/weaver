import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { protoArtifact as artifact, protoVersion as version, repository, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { getPublicStats, listDocsPaths, listPublicBrowsePages } from "./public-catalog";
import { insertRepository, insertVersion } from "@/test/catalog";

describe("listDocsPaths", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "weaver-docs-"));
    await mkdir(join(dir, "admin"), { recursive: true });
    await mkdir(join(dir, "self-host"), { recursive: true });
    await writeFile(join(dir, "index.md"), "---\ntitle: What is Weaver\n---\n");
    await writeFile(join(dir, "gradle.md"), "# Gradle\n");
    await writeFile(join(dir, "admin", "keys.md"), "# Keys\n");
    await writeFile(join(dir, "admin", "index.md"), "# Admin\n");
    await writeFile(join(dir, "self-host", "compose.md"), "# Compose\n");
    await writeFile(join(dir, "notes.txt"), "not a page");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps every Markdown file to its URL path, sorted", async () => {
    expect(await listDocsPaths(dir)).toEqual([
      "/docs",
      "/docs/admin",
      "/docs/admin/keys",
      "/docs/gradle",
      "/docs/self-host/compose",
    ]);
  });

  it("returns nothing when the docs folder does not exist", async () => {
    expect(await listDocsPaths(join(dir, "missing"))).toEqual([]);
  });
});

describe("public catalog queries", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let db: Db;

  beforeAll(async () => {
    testDb = await startTestDb();
    db = testDb.db;
    const releases = await insertRepository(db, "releases", "public");
    const internal = await insertRepository(db, "internal", "private");
    await insertRepository(db, "empty", "public");
    await db.insert(repository).values({ name: "npm-public", visibility: "public", format: "npm", kind: "mirror" });
    await insertVersion(db, releases, { group: "dev.surf.economy", name: "economy-contracts", version: "1.4.0" });
    await insertVersion(db, releases, { group: "dev.surf.economy", name: "economy-contracts", version: "1.5.0-SNAPSHOT" });
    await insertVersion(db, releases, { group: "dev.surf.core", name: "core-types", version: "2.1.0" });
    await insertVersion(db, internal, { group: "dev.secret", name: "hidden-contracts", version: "1.0.0" });
    // An artifact without versions, and a version without a build (both left behind by deletes).
    await db.insert(artifact).values({ repositoryId: releases, group: "dev.surf.empty", name: "no-versions" });
    const [orphan] = await db
      .insert(artifact)
      .values({ repositoryId: releases, group: "dev.surf.orphan", name: "no-builds" })
      .returning({ id: artifact.id });
    await db.insert(version).values({ artifactId: orphan!.id, version: "0.1.0", isSnapshot: false });
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  it("counts public repositories and their artifacts that have a published build, never private ones", async () => {
    expect(await getPublicStats(db)).toEqual({ repositories: 3, artifacts: 2 });
  });

  it("lists browse pages of public repositories only", async () => {
    const pages = await listPublicBrowsePages(db);
    const paths = pages.map((p) => p.path);
    expect(paths).toEqual([
      "/browse/empty",
      "/browse/releases",
      "/browse/releases/dev.surf.core/core-types",
      "/browse/releases/dev.surf.core/core-types/2.1.0",
      "/browse/releases/dev.surf.economy/economy-contracts",
      "/browse/releases/dev.surf.economy/economy-contracts/1.4.0",
      "/browse/releases/dev.surf.economy/economy-contracts/1.5.0-SNAPSHOT",
    ]);
    expect(paths.join(" ")).not.toContain("internal");
    // Only proto repositories have a browse view so far.
    expect(paths.join(" ")).not.toContain("npm-public");
    expect(paths.join(" ")).not.toMatch(/no-versions|no-builds/);
    expect(paths.join(" ")).not.toContain("hidden");
    expect(pages.find((p) => p.path.endsWith("/1.4.0"))?.lastModified).toBeInstanceOf(Date);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry, createRepoService, deriveSecretKey, type Registry, type StoreSet } from "@weaver/core";
import { startTestDb } from "@weaver/db/testing";
import { artifactCard, GENERIC_ARTIFACT_CARD } from "./og-artifact";
import { insertRepository, insertVersion } from "@/test/catalog";

describe("artifact share card content", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let registry: Registry;

  beforeAll(async () => {
    testDb = await startTestDb();
    // Share cards read metadata only; the blob store is never touched.
    const stores = {} as StoreSet;
    const repos = createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("og-artifact-test") });
    registry = createRegistry({ db: testDb.db, stores, repos });
    const releases = await insertRepository(testDb.db, "releases", "public");
    const internal = await insertRepository(testDb.db, "internal", "private");
    await insertVersion(
      testDb.db,
      releases,
      { group: "dev.surf.economy", name: "economy-contracts", version: "1.4.0" },
      {
        files: ["surf/economy/v1/events.proto", "surf/economy/v1/money.proto", "surf/economy/v1/service.proto"],
        dependencies: [{ group: "dev.surf.core", name: "core-types", version: "2.1.0" }],
      },
    );
    await insertVersion(testDb.db, releases, {
      group: "dev.surf.economy",
      name: "economy-contracts",
      version: "1.5.0-SNAPSHOT",
    });
    await insertVersion(testDb.db, releases, { group: "dev.surf.economy", name: "nightly-contracts", version: "0.1.0-SNAPSHOT" });
    await insertVersion(testDb.db, internal, { group: "dev.secret", name: "hidden-contracts", version: "1.0.0" });
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  const params = (repo: string, group: string, name: string, version: string) => ({ repo, group, name, version });

  it("describes a version of a public repository", async () => {
    const card = await artifactCard(registry, params("releases", "dev.surf.economy", "economy-contracts", "1.4.0"));
    expect(card).toMatchObject({
      eyebrow: "releases · dev.surf.economy",
      title: "economy-contracts",
      subtitle: "dev.surf.economy:economy-contracts:1.4.0",
      badge: { label: "Release", tone: "release" },
      meta: ["3 files", "1 dependency"],
    });
  });

  it("marks snapshots and counts zero dependencies", async () => {
    const card = await artifactCard(registry, params("releases", "dev.surf.economy", "economy-contracts", "1.5.0-SNAPSHOT"));
    expect(card.badge).toEqual({ label: "Snapshot · build 1", tone: "snapshot" });
    expect(card.meta).toEqual(["1 file", "0 dependencies"]);
  });

  it("resolves `latest` to the newest release, or the newest snapshot when there is no release", async () => {
    const latest = await artifactCard(registry, params("releases", "dev.surf.economy", "economy-contracts", "latest"));
    expect(latest.subtitle).toBe("dev.surf.economy:economy-contracts:1.4.0");
    expect(latest.eyebrow).toBe("releases · dev.surf.economy · latest");
    const nightly = await artifactCard(registry, params("releases", "dev.surf.economy", "nightly-contracts", "latest"));
    expect(nightly.subtitle).toBe("dev.surf.economy:nightly-contracts:0.1.0-SNAPSHOT");
  });

  it("returns the generic card for a private repository without leaking any name", async () => {
    const card = await artifactCard(registry, params("internal", "dev.secret", "hidden-contracts", "1.0.0"));
    expect(card).toEqual(GENERIC_ARTIFACT_CARD);
    const text = JSON.stringify(card);
    expect(text).not.toMatch(/internal|secret|hidden|1\.0\.0/);
  });

  it("returns the same generic card for unknown repositories, artifacts and versions", async () => {
    for (const p of [
      params("nope", "dev.surf.economy", "economy-contracts", "1.4.0"),
      params("releases", "dev.surf.economy", "missing", "1.4.0"),
      params("releases", "dev.surf.economy", "economy-contracts", "9.9.9"),
      params("internal", "dev.secret", "hidden-contracts", "latest"),
    ]) {
      expect(await artifactCard(registry, p)).toEqual(GENERIC_ARTIFACT_CARD);
    }
  });

  it("returns the generic card for malformed coordinates without querying", async () => {
    const throwing = {
      listVersions: () => Promise.reject(new Error("must not be called")),
      getManifest: () => Promise.reject(new Error("must not be called")),
    };
    expect(await artifactCard(throwing, params("Bad Repo", "x", "y", "1.0.0"))).toEqual(GENERIC_ARTIFACT_CARD);
    expect(await artifactCard(throwing, params("releases", "x", "y", "not a version"))).toEqual(GENERIC_ARTIFACT_CARD);
  });

  it("decodes URL-encoded segments", async () => {
    const card = await artifactCard(registry, params("releases", "dev.surf.economy", "economy-contracts", "1.5.0%2DSNAPSHOT"));
    expect(card.subtitle).toBe("dev.surf.economy:economy-contracts:1.5.0-SNAPSHOT");
  });
});

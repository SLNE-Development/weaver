import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { component, protoBuild, repository, usageEvent } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { packArchive, type ProtoFile } from "../archive.js";
import type { Coordinate } from "../coordinates.js";
import { deriveSecretKey } from "../crypto.js";
import type { Principal } from "../permissions.js";
import { createRepoService } from "../repos/service.js";
import { createStoreSetFromEnv } from "../storage/index.js";
import { deleteBuildRow } from "./delete.js";
import { createRegistry, type Registry } from "./index.js";

const releasesId = "00000000-0000-4000-8000-000000000201";
const snapshotsId = "00000000-0000-4000-8000-000000000202";

const maintainer: Principal = {
  kind: "apikey",
  keyId: "key-maintainer",
  userId: "user-maintainer",
  role: "maintainer",
  permissions: [
    { repositoryId: releasesId, repository: "releases", groupPrefix: null, access: "write" },
    { repositoryId: snapshotsId, repository: "snapshots", groupPrefix: null, access: "write" },
  ],
};

const files: ProtoFile[] = [
  { path: "acme/money/v1/money.proto", content: 'syntax = "proto3";\npackage acme.money.v1;\nmessage Money { int64 cents = 1; }\n' },
];

const coord = (version: string): Coordinate => ({ group: "acme", name: "money", version });

describe("proto components", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let registry: Registry;

  async function publish(repo: string, version: string) {
    return registry.publish(maintainer, {
      repository: repo,
      manifest: { group: "acme", name: "money", version, dependencies: [] },
      archive: await packArchive(files),
    });
  }

  const components = () =>
    testDb.db
      .select({ repositoryId: component.repositoryId, namespace: component.namespace, name: component.name, version: component.version, downloadCount: component.downloadCount })
      .from(component);

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-components-"));
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    const repos = createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("components-test") });
    registry = createRegistry({ db: testDb.db, stores, repos });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, usage_event, audit_event CASCADE`);
    await testDb.db.insert(repository).values([
      { id: releasesId, name: "releases", format: "proto", kind: "hosted", config: { allowSnapshots: false } },
      { id: snapshotsId, name: "snapshots", format: "proto", kind: "hosted", config: { allowReleases: false } },
    ]);
  });

  it("publishing a proto bundle upserts its component", async () => {
    await publish("releases", "1.0.0");
    await publish("snapshots", "1.1.0-SNAPSHOT");
    await publish("snapshots", "1.1.0-SNAPSHOT");
    const rows = await components();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repositoryId: releasesId, namespace: "acme", name: "money", version: "1.0.0" }),
        expect.objectContaining({ repositoryId: snapshotsId, namespace: "acme", name: "money", version: "1.1.0-SNAPSHOT" }),
      ]),
    );
  });

  it("deleting the last build removes it", async () => {
    await publish("releases", "1.0.0");
    await registry.deleteVersion(maintainer, "releases", coord("1.0.0"));
    expect(await components()).toEqual([]);

    await publish("snapshots", "1.1.0-SNAPSHOT");
    await publish("snapshots", "1.1.0-SNAPSHOT");
    const [build] = await testDb.db.select({ versionId: protoBuild.versionId }).from(protoBuild).limit(1);
    await testDb.db.transaction((tx) => deleteBuildRow(tx, build!.versionId, 1));
    expect(await components()).toHaveLength(1);
    await testDb.db.transaction((tx) => deleteBuildRow(tx, build!.versionId, 2));
    expect(await components()).toEqual([]);
  });

  it("a download increments component.downloadCount", async () => {
    await publish("releases", "1.0.0");
    await registry.download(maintainer, "releases", coord("1.0.0"));
    const [row] = await components();
    expect(row?.downloadCount).toBe(1);
    const events = await testDb.db.select().from(usageEvent);
    expect(events).toEqual([expect.objectContaining({ repositoryId: releasesId, action: "download", apiKeyId: "key-maintainer" })]);
    expect(events[0]!.componentId).not.toBeNull();
  });
});

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dockerBlob,
  dockerBlobLink,
  dockerManifest,
  dockerManifestRef,
  dockerTag,
  dockerUpload,
  repository,
} from "./index.js";
import { startTestDb } from "./testing.js";

describe("docker schema", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb.stop();
  });

  async function newRepo(name: string): Promise<string> {
    const [row] = await testDb.db.insert(repository).values({ name, format: "docker", kind: "hosted" }).returning();
    return row!.id;
  }

  async function newManifest(repositoryId: string, digest: string): Promise<string> {
    const [row] = await testDb.db
      .insert(dockerManifest)
      .values({
        repositoryId,
        image: "app",
        digest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        size: 10,
        totalSize: 100,
        content: Buffer.from("{}"),
      })
      .returning();
    return row!.id;
  }

  it("docker tables exist after migrate", async () => {
    for (const name of [
      "docker_blob",
      "docker_blob_link",
      "docker_manifest",
      "docker_manifest_ref",
      "docker_tag",
      "docker_upload",
    ]) {
      const { rows } = await testDb.db.$client.query("select to_regclass($1) is not null as present", [
        `public.${name}`,
      ]);
      expect((rows[0] as { present: boolean }).present, name).toBe(true);
    }
  });

  it("blob digest is unique per store", async () => {
    const base = { digest: "sha256:aa", size: 1, storageKey: "k" };
    await testDb.db.insert(dockerBlob).values({ ...base, store: "local" });
    await expect(testDb.db.insert(dockerBlob).values({ ...base, store: "local" })).rejects.toThrow();
    await expect(testDb.db.insert(dockerBlob).values({ ...base, store: "s3" })).resolves.toBeDefined();
  });

  it("deleting a manifest cascades its tags and refs", async () => {
    const repositoryId = await newRepo("cascade-manifest");
    const manifestId = await newManifest(repositoryId, "sha256:m1");
    await testDb.db.insert(dockerTag).values({ repositoryId, image: "app", tag: "latest", manifestId });
    await testDb.db
      .insert(dockerManifestRef)
      .values({ manifestId, digest: "sha256:l1", kind: "blob", mediaType: "x", size: 1, position: 0 });
    await testDb.db.delete(dockerManifest).where(eq(dockerManifest.id, manifestId));
    expect(await testDb.db.select().from(dockerTag).where(eq(dockerTag.repositoryId, repositoryId))).toHaveLength(0);
    expect(
      await testDb.db.select().from(dockerManifestRef).where(eq(dockerManifestRef.manifestId, manifestId)),
    ).toHaveLength(0);
  });

  it("deleting a repository cascades links, manifests, tags and uploads", async () => {
    const repositoryId = await newRepo("cascade-repo");
    const [blob] = await testDb.db
      .insert(dockerBlob)
      .values({ store: "local", digest: "sha256:bb", size: 1, storageKey: "k2" })
      .returning();
    await testDb.db.insert(dockerBlobLink).values({ repositoryId, image: "app", blobId: blob!.id, digest: "sha256:bb" });
    const manifestId = await newManifest(repositoryId, "sha256:m2");
    await testDb.db.insert(dockerTag).values({ repositoryId, image: "app", tag: "v1", manifestId });
    await testDb.db.insert(dockerUpload).values({ repositoryId, image: "app" });
    await testDb.db.delete(repository).where(eq(repository.id, repositoryId));
    expect(
      await testDb.db.select().from(dockerBlobLink).where(eq(dockerBlobLink.repositoryId, repositoryId)),
    ).toHaveLength(0);
    expect(
      await testDb.db.select().from(dockerManifest).where(eq(dockerManifest.repositoryId, repositoryId)),
    ).toHaveLength(0);
    expect(await testDb.db.select().from(dockerTag).where(eq(dockerTag.repositoryId, repositoryId))).toHaveLength(0);
    expect(
      await testDb.db.select().from(dockerUpload).where(eq(dockerUpload.repositoryId, repositoryId)),
    ).toHaveLength(0);
    // The shared blob itself survives.
    expect(await testDb.db.select().from(dockerBlob).where(eq(dockerBlob.id, blob!.id))).toHaveLength(1);
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createDb, dockerManifest, dockerManifestRef, dockerTag, repository } from "@weaver/db";
import { STATE_FILE, USERS } from "./fixtures";
import { loginAs } from "./helpers";

const REPO = "containers";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

/** The sha256 digest of `content`. */
const digestOf = (content: Buffer) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

/**
 * Seeds a hosted docker repository with a multi-arch image `web`: two platform manifests and an index
 * tagged `1.0` and `latest`, written straight to the tables a push fills.
 */
async function seedMultiArchImage(): Promise<void> {
  const { databaseUrl } = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { databaseUrl: string };
  const db = createDb(databaseUrl);
  try {
    const [repo] = await db
      .insert(repository)
      .values({ name: REPO, format: "docker", kind: "hosted", description: "Container images", visibility: "public" })
      .onConflictDoNothing()
      .returning({ id: repository.id });
    if (!repo) return;
    const children = [];
    for (const architecture of ["amd64", "arm64"]) {
      const content = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, architecture }));
      const [row] = await db
        .insert(dockerManifest)
        .values({
          repositoryId: repo.id,
          image: "web",
          digest: digestOf(content),
          mediaType: OCI_MANIFEST,
          artifactType: "application/vnd.oci.image.config.v1+json",
          platforms: [{ os: "linux", architecture }],
          size: content.length,
          totalSize: 4096,
          content,
        })
        .returning();
      children.push({ row: row!, platform: { os: "linux", architecture } });
    }
    const content = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: children.map((c) => ({ mediaType: OCI_MANIFEST, digest: c.row.digest, size: c.row.size, platform: c.platform })),
      }),
    );
    const [index] = await db
      .insert(dockerManifest)
      .values({
        repositoryId: repo.id,
        image: "web",
        digest: digestOf(content),
        mediaType: OCI_INDEX,
        platforms: children.map((c) => c.platform),
        size: content.length,
        totalSize: 8192,
        content,
      })
      .returning();
    await db.insert(dockerManifestRef).values(
      children.map((c, position) => ({ manifestId: index!.id, digest: c.row.digest, kind: "manifest" as const, mediaType: OCI_MANIFEST, size: c.row.size, position })),
    );
    await db.insert(dockerTag).values(["1.0", "latest"].map((tag) => ({ repositoryId: repo.id, image: "web", tag, manifestId: index!.id })));
  } finally {
    await db.$client.end();
  }
}

test.describe("docker browse", () => {
  test.beforeAll(seedMultiArchImage);

  test("shows the images, tags, platforms and the docker pull snippet of a hosted repository", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(`/browse/${REPO}`);
    await page.getByRole("link", { name: "web", exact: true }).click();
    await expect(page).toHaveURL(`/browse/${REPO}?image=web`);

    const rows = page.getByTestId("docker-tag-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "1.0" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "latest" })).toHaveCount(1);
    await expect(rows.first().getByText("linux/amd64")).toBeVisible();
    await expect(rows.first().getByText("linux/arm64")).toBeVisible();

    const host = new URL(page.url()).host;
    await expect(page.getByText(`docker pull ${host}/${REPO}/web:latest`)).toBeVisible();

    await rows.filter({ hasText: "latest" }).getByRole("link").click();
    await expect(page.getByText("Platform manifests")).toBeVisible();
    await expect(page.getByRole("cell", { name: "linux/arm64" })).toBeVisible();
  });
});

import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchComponents, type Repo } from "@weaver/core";
import { component } from "@weaver/db";
import { deleteTag } from "./cleanup.js";
import { descriptorOf, digestOf, pushBlob, pushManifest, startDockerTestRegistry, type DockerTestRegistry } from "./testing.js";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

describe("docker components", () => {
  let reg: DockerTestRegistry;
  let key: string;
  let repo: Repo;

  beforeAll(async () => {
    reg = await startDockerTestRegistry();
    repo = await reg.createRepo({ name: "apps", format: "docker", kind: "hosted" });
    key = reg.tokenFor([{ repo: "apps", access: "write" }]);
  }, 180_000);
  afterAll(async () => {
    await reg?.stop();
  });
  beforeEach(async () => {
    await reg.deps.db.execute(sql`TRUNCATE docker_blob, docker_blob_link, docker_manifest, docker_manifest_ref, docker_tag, component CASCADE`);
  });

  /** Pushes a one-layer image to apps/<name> under each of `tags` ("@digest": by its digest); resolves to its manifest digest. */
  async function push(name: string, seed: number, tags: string[]): Promise<string> {
    const config = Buffer.from(JSON.stringify({ os: "linux", architecture: "amd64", seed }));
    const layer = Buffer.from(`layer-${seed}`);
    expect((await pushBlob(reg, `apps/${name}`, config, key)).status).toBe(201);
    expect((await pushBlob(reg, `apps/${name}`, layer, key)).status).toBe(201);
    const manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST, config: descriptorOf(config, OCI_CONFIG), layers: [descriptorOf(layer, OCI_LAYER)] };
    const digest = digestOf(Buffer.from(JSON.stringify(manifest)));
    for (const tag of tags) {
      expect((await pushManifest(reg, `apps/${name}`, tag === "@digest" ? digest : tag, manifest, key)).status).toBe(201);
    }
    return digest;
  }

  /** The component versions of apps/<name>, sorted. */
  async function versions(name: string): Promise<string[]> {
    const rows = await reg.deps.db
      .select({ name: component.name, namespace: component.namespace, version: component.version })
      .from(component)
      .where(eq(component.repositoryId, repo.id))
      .orderBy(asc(component.version));
    return rows.filter((r) => r.name === name && r.namespace === "").map((r) => r.version);
  }

  it("a pushed tag makes the image a component that search finds", async () => {
    await push("team/web", 1, ["1.0", "latest"]);
    expect(await versions("team/web")).toEqual(["1.0", "latest"]);
    const { hits } = await searchComponents(
      { db: reg.deps.db, repos: reg.deps.repos },
      { kind: "user", userId: "admin", role: "admin" },
      { text: "web", format: "docker", limit: 20, offset: 0 },
    );
    expect(hits).toEqual([expect.objectContaining({ repository: "apps", name: "team/web", label: "team/web", versionCount: 2 })]);
  });

  it("a push by digest alone and a cosign signature tag add no version", async () => {
    await push("solo", 2, ["@digest"]);
    expect(await versions("solo")).toEqual([]);
    await push("signed", 3, [`sha256-${"a".repeat(64)}.sig`, "1"]);
    expect(await versions("signed")).toEqual(["1"]);
  });

  it("deleting a tag, its manifest or a tag in cleanup removes the versions", async () => {
    const digest = await push("api", 4, ["1", "2", "3"]);
    const byTag = await reg.call("DELETE", "apps/api/manifests/1", { token: key });
    expect(byTag.status).toBe(202);
    expect(await versions("api")).toEqual(["2", "3"]);
    expect(await deleteTag({ db: reg.deps.db }, repo, "api", "2")).toBe(true);
    expect(await versions("api")).toEqual(["3"]);
    const byDigest = await reg.call("DELETE", `apps/api/manifests/${digest}`, { token: key });
    expect(byDigest.status).toBe(202);
    expect(await versions("api")).toEqual([]);
  });
});

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Repo } from "@weaver/core";
import { dockerTag } from "@weaver/db";
import { getManifestDetail, listImageTags, listImages } from "./browse.js";
import { artifactTypeLabel, dockerSnippets, isIndexMediaType } from "./client.js";
import {
  descriptorOf,
  digestOf,
  pushBlob,
  pushManifest,
  randomBlob,
  startDockerTestRegistry,
  type DockerTestRegistry,
} from "./testing.js";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";
const EMPTY_CONFIG = "application/vnd.oci.empty.v1+json";

describe("docker browse queries", () => {
  let reg: DockerTestRegistry;
  let key: string;
  let repoId: string;

  beforeAll(async () => {
    reg = await startDockerTestRegistry();
    repoId = (await reg.createRepo({ name: "apps", format: "docker", kind: "hosted" })).id;
    key = reg.tokenFor([{ repo: "apps", access: "write" }]);
  });
  afterAll(async () => {
    await reg?.stop();
  });

  /** Pushes a single-platform image of `name` (config + one layer of `size` bytes) by digest; resolves to it. */
  async function platformImage(name: string, seed: number, architecture: string, size = 1000) {
    const config = Buffer.from(JSON.stringify({ os: "linux", architecture, rootfs: { type: "layers", diff_ids: [] } }));
    const layer = randomBlob(seed, size);
    expect((await pushBlob(reg, name, config, key)).status).toBe(201);
    expect((await pushBlob(reg, name, layer, key)).status).toBe(201);
    const manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST, config: descriptorOf(config, OCI_CONFIG), layers: [descriptorOf(layer, OCI_LAYER)] };
    const bytes = Buffer.from(JSON.stringify(manifest));
    expect((await pushManifest(reg, name, digestOf(bytes), manifest, key)).status).toBe(201);
    return { manifest, bytes, digest: digestOf(bytes), config, layer };
  }

  /** Pushes a two-platform index of `name` tagged with every tag in `tags`; resolves to its digest and children. */
  async function multiArch(name: string, tags: string[]) {
    const amd = await platformImage(name, 11, "amd64", 2000);
    const arm = await platformImage(name, 12, "arm64", 3000);
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        { ...descriptorOf(amd.bytes, OCI_MANIFEST), platform: { os: "linux", architecture: "amd64" } },
        { ...descriptorOf(arm.bytes, OCI_MANIFEST), platform: { os: "linux", architecture: "arm64" } },
      ],
    };
    for (const tag of tags) expect((await pushManifest(reg, name, tag, index, key)).status).toBe(201);
    return { digest: digestOf(Buffer.from(JSON.stringify(index))), amd, arm };
  }

  it("listImages groups by image with tag counts and sizes", async () => {
    const web = await multiArch("apps/web", ["1.0", "latest"]);
    await platformImage("apps/api", 21, "amd64", 500);

    const page = await listImages(reg.deps.db, repoId, { limit: 10 });
    expect(page.next).toBeNull();
    expect(page.items.map((i) => i.image)).toEqual(["api", "web"]);
    const webSummary = page.items.find((i) => i.image === "web")!;
    expect(webSummary).toMatchObject({ tagCount: 2, manifestCount: 3 });
    expect(webSummary.totalSize).toBe(2000 + 3000 + web.amd.config.length + web.arm.config.length);
    expect(webSummary.updatedAt).toBeInstanceOf(Date);
    expect(page.items.find((i) => i.image === "api")).toMatchObject({ tagCount: 0, manifestCount: 1 });

    const first = await listImages(reg.deps.db, repoId, { limit: 1 });
    expect(first.items.map((i) => i.image)).toEqual(["api"]);
    expect(first.next).toBe("api");
    const second = await listImages(reg.deps.db, repoId, { limit: 1, cursor: first.next! });
    expect(second.items.map((i) => i.image)).toEqual(["web"]);
    expect((await listImages(reg.deps.db, repoId, { limit: 10, query: "WE" })).items.map((i) => i.image)).toEqual(["web"]);
  });

  it("listImageTags sorts by updatedAt desc", async () => {
    const svc = await multiArch("apps/svc", ["old", "new"]);
    await reg.deps.db
      .update(dockerTag)
      .set({ updatedAt: sql`now() - interval '1 day'` })
      .where(eq(dockerTag.tag, "old"));

    const tags = await listImageTags(reg.deps.db, repoId, "svc");
    expect(tags.map((t) => t.tag)).toEqual(["new", "old"]);
    expect(tags[0]).toMatchObject({
      digest: svc.digest,
      mediaType: OCI_INDEX,
      platforms: [
        { os: "linux", architecture: "amd64" },
        { os: "linux", architecture: "arm64" },
      ],
      totalSize: svc.amd.manifest.config.size + 2000 + svc.arm.manifest.config.size + 3000,
      lastPulledAt: null,
    });
    expect(await listImageTags(reg.deps.db, repoId, "missing")).toEqual([]);
  });

  it("getManifestDetail lists layers, children with platforms and referrers", async () => {
    const tool = await multiArch("apps/tool", ["1.0"]);
    // A cosign-style signature referring to the amd64 manifest.
    const empty = Buffer.from("{}");
    const sig = Buffer.from("signature");
    expect((await pushBlob(reg, "apps/tool", empty, key)).status).toBe(201);
    expect((await pushBlob(reg, "apps/tool", sig, key)).status).toBe(201);
    const referrer = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      artifactType: "application/vnd.dev.cosign.artifact.sig.v1+json",
      config: descriptorOf(empty, EMPTY_CONFIG),
      layers: [descriptorOf(sig, "application/vnd.dev.cosign.simplesigning.v1+json")],
      subject: descriptorOf(tool.amd.bytes, OCI_MANIFEST),
    };
    expect((await pushManifest(reg, "apps/tool", digestOf(Buffer.from(JSON.stringify(referrer))), referrer, key)).status).toBe(201);

    const index = (await getManifestDetail(reg.deps.db, repoId, "tool", tool.digest))!;
    expect(index).toMatchObject({ digest: tool.digest, mediaType: OCI_INDEX, artifactType: null, tags: ["1.0"], referrers: [] });
    expect(index.refs).toEqual([
      { kind: "manifest", digest: tool.amd.digest, mediaType: OCI_MANIFEST, size: tool.amd.bytes.length, platform: { os: "linux", architecture: "amd64" } },
      { kind: "manifest", digest: tool.arm.digest, mediaType: OCI_MANIFEST, size: tool.arm.bytes.length, platform: { os: "linux", architecture: "arm64" } },
    ]);

    const amd = (await getManifestDetail(reg.deps.db, repoId, "tool", tool.amd.digest))!;
    expect(amd.artifactType).toBeNull();
    expect(amd.platforms).toEqual([{ os: "linux", architecture: "amd64" }]);
    expect(amd.tags).toEqual([]);
    expect(amd.size).toBe(tool.amd.bytes.length);
    expect(amd.refs.map((r) => [r.kind, r.digest, r.mediaType])).toEqual([
      ["blob", digestOf(tool.amd.config), OCI_CONFIG],
      ["blob", digestOf(tool.amd.layer), OCI_LAYER],
    ]);
    expect(amd.referrers).toEqual([
      expect.objectContaining({ digest: digestOf(Buffer.from(JSON.stringify(referrer))), artifactType: "application/vnd.dev.cosign.artifact.sig.v1+json" }),
    ]);
    expect(amd.createdAt).toBeInstanceOf(Date);

    expect(await getManifestDetail(reg.deps.db, repoId, "tool", `sha256:${"0".repeat(64)}`)).toBeNull();
    expect(await getManifestDetail(reg.deps.db, repoId, "other", tool.digest)).toBeNull();
  });

  it("getManifestDetail marks buildx attestation children instead of showing unknown/unknown", async () => {
    const amd = await platformImage("apps/built", 31, "amd64");
    const att = await platformImage("apps/built", 32, "unknown");
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        { ...descriptorOf(amd.bytes, OCI_MANIFEST), platform: { os: "linux", architecture: "amd64" } },
        {
          ...descriptorOf(att.bytes, OCI_MANIFEST),
          platform: { os: "unknown", architecture: "unknown" },
          annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": amd.digest },
        },
      ],
    };
    expect((await pushManifest(reg, "apps/built", "latest", index, key)).status).toBe(201);
    const detail = (await getManifestDetail(reg.deps.db, repoId, "built", digestOf(Buffer.from(JSON.stringify(index)))))!;
    expect(detail.platforms).toEqual([{ os: "linux", architecture: "amd64" }]);
    expect(detail.refs.map((r) => [r.digest, r.platform ?? null, r.attestation ?? false])).toEqual([
      [amd.digest, { os: "linux", architecture: "amd64" }, false],
      [att.digest, null, true],
    ]);
  });
});

describe("dockerSnippets", () => {
  const repo = (over: Partial<Repo>): Pick<Repo, "name" | "kind" | "dockerRoot"> => ({ name: "apps", kind: "hosted", dockerRoot: false, ...over });

  it('hosted repo: login "docker login weaver.slne.dev", pull "docker pull weaver.slne.dev/apps/web:latest", push set', () => {
    const s = dockerSnippets("https://weaver.slne.dev/", repo({}), "web");
    expect(s.login).toBe("docker login weaver.slne.dev");
    expect(s.pull).toBe("docker pull weaver.slne.dev/apps/web:latest");
    expect(s.push).toBe("docker tag web:latest weaver.slne.dev/apps/web:latest\ndocker push weaver.slne.dev/apps/web:latest");
    expect(s.daemonJson).toBeNull();
    expect(dockerSnippets("https://weaver.slne.dev", repo({}), "web", "1.0").pull).toBe("docker pull weaver.slne.dev/apps/web:1.0");
    expect(dockerSnippets("https://weaver.slne.dev", repo({}), "web", `sha256:${"a".repeat(64)}`).pull).toBe(
      `docker pull weaver.slne.dev/apps/web@sha256:${"a".repeat(64)}`,
    );
    expect(dockerSnippets("https://weaver.slne.dev", repo({})).pull).toBe("docker pull weaver.slne.dev/apps/<image>:<tag>");
  });

  it('root mirror: daemonJson is {"registry-mirrors":["https://weaver.slne.dev"]}', () => {
    const s = dockerSnippets("https://weaver.slne.dev", repo({ name: "hub", kind: "mirror", dockerRoot: true }), "nginx");
    expect(s.daemonJson).toBe('{"registry-mirrors":["https://weaver.slne.dev"]}');
    expect(s.pull).toBe("docker pull weaver.slne.dev/hub/nginx:latest");
    // Docker needs the registry at the host root, so a path of the public URL is dropped.
    expect(dockerSnippets("https://weaver.slne.dev/app/", repo({ name: "hub", kind: "mirror", dockerRoot: true })).daemonJson).toBe(
      '{"registry-mirrors":["https://weaver.slne.dev"]}',
    );
  });

  it("mirror: push null", () => {
    expect(dockerSnippets("https://weaver.slne.dev", repo({ kind: "mirror" }), "nginx")).toMatchObject({ push: null, daemonJson: null });
    expect(dockerSnippets("https://weaver.slne.dev", repo({ kind: "group" }), "nginx").push).toBeNull();
  });

  it("labels attached artifacts by type", () => {
    expect(artifactTypeLabel("application/vnd.cncf.helm.config.v1+json")).toBe("Helm chart");
    expect(artifactTypeLabel("application/vnd.dev.cosign.artifact.sig.v1+json")).toBe("cosign signature");
    expect(artifactTypeLabel("application/spdx+json")).toBe("SBOM");
    expect(artifactTypeLabel("application/vnd.cyclonedx+json")).toBe("SBOM");
    expect(artifactTypeLabel("application/vnd.example.thing")).toBe("application/vnd.example.thing");
    expect(artifactTypeLabel(null)).toBe("image");
    expect(isIndexMediaType("application/vnd.docker.distribution.manifest.list.v2+json")).toBe(true);
    expect(isIndexMediaType(OCI_INDEX)).toBe(true);
    expect(isIndexMediaType(OCI_MANIFEST)).toBe(false);
  });
});

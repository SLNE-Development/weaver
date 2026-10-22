import { describe, expect, it } from "vitest";
import { DockerError } from "./errors.js";
import { parseManifest } from "./manifest-parse.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const DOCKER_V2 = "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DockerError);
    return (err as DockerError).code;
  }
  throw new Error("expected a DockerError");
}

describe("parseManifest", () => {
  it("docker schema2 image", () => {
    const m = parseManifest(
      bytes({
        schemaVersion: 2,
        mediaType: DOCKER_V2,
        config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: D("a"), size: 10 },
        layers: [{ mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", digest: D("b"), size: 20 }],
      }),
      DOCKER_V2,
    );
    expect(m.mediaType).toBe(DOCKER_V2);
    expect(m.isIndex).toBe(false);
    expect(m.config).toEqual({ mediaType: "application/vnd.docker.container.image.v1+json", digest: D("a"), size: 10 });
    expect(m.layers).toHaveLength(1);
    expect(m.manifests).toEqual([]);
    expect(m.subject).toBeNull();
    expect(m.artifactType).toBeNull();
    expect(m.annotations).toBeNull();
  });

  it("docker manifest list", () => {
    const m = parseManifest(
      bytes({
        schemaVersion: 2,
        mediaType: DOCKER_LIST,
        manifests: [
          { mediaType: DOCKER_V2, digest: D("c"), size: 500, platform: { os: "linux", architecture: "amd64" } },
          {
            mediaType: DOCKER_V2,
            digest: D("d"),
            size: 501,
            platform: { os: "linux", architecture: "arm64", variant: "v8", features: ["x"] },
          },
        ],
      }),
      DOCKER_LIST,
    );
    expect(m.isIndex).toBe(true);
    expect(m.config).toBeNull();
    expect(m.manifests.map((d) => d.platform)).toEqual([
      { os: "linux", architecture: "amd64" },
      { os: "linux", architecture: "arm64", variant: "v8" },
    ]);
  });

  it("oci manifest", () => {
    const m = parseManifest(
      bytes({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: D("a"), size: 10 },
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
            digest: D("b"),
            size: 20,
            urls: ["https://example.com/layer"],
          },
        ],
        annotations: { "org.opencontainers.image.created": "2026-10-22" },
      }),
      OCI_MANIFEST,
    );
    expect(m.isIndex).toBe(false);
    expect(m.layers[0]!.urls).toEqual(["https://example.com/layer"]);
    expect(m.annotations).toEqual({ "org.opencontainers.image.created": "2026-10-22" });
  });

  it("oci manifest without mediaType takes it from Content-Type", () => {
    const m = parseManifest(
      bytes({
        schemaVersion: 2,
        config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: D("a"), size: 10 },
        layers: [],
      }),
      `${OCI_MANIFEST}; charset=utf-8`,
    );
    expect(m.mediaType).toBe(OCI_MANIFEST);
  });

  it("oci index", () => {
    const m = parseManifest(
      bytes({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [{ mediaType: OCI_MANIFEST, digest: D("c"), size: 500, platform: { os: "linux", architecture: "amd64" } }],
        annotations: { a: "b" },
      }),
      OCI_INDEX,
    );
    expect(m.isIndex).toBe(true);
    expect(m.manifests).toHaveLength(1);
    expect(m.annotations).toEqual({ a: "b" });
  });

  it("helm chart (config application/vnd.cncf.helm.config.v1+json)", () => {
    const m = parseManifest(
      bytes({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: "application/vnd.cncf.helm.config.v1+json", digest: D("a"), size: 117 },
        layers: [{ mediaType: "application/vnd.cncf.helm.chart.content.v1.tar+gzip", digest: D("b"), size: 3000 }],
      }),
      OCI_MANIFEST,
    );
    expect(m.config!.mediaType).toBe("application/vnd.cncf.helm.config.v1+json");
    expect(m.layers[0]!.mediaType).toBe("application/vnd.cncf.helm.chart.content.v1.tar+gzip");
  });

  it("cosign signature with subject", () => {
    const m = parseManifest(
      bytes({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        artifactType: "application/vnd.dev.cosign.artifact.sig.v1+json",
        config: { mediaType: "application/vnd.oci.empty.v1+json", digest: D("e"), size: 2 },
        layers: [
          {
            mediaType: "application/vnd.dev.cosign.simplesigning.v1+json",
            digest: D("f"),
            size: 250,
            annotations: { "dev.cosignproject.cosign/signature": "MEUC" },
          },
        ],
        subject: { mediaType: OCI_MANIFEST, digest: D("1"), size: 900 },
      }),
      OCI_MANIFEST,
    );
    expect(m.artifactType).toBe("application/vnd.dev.cosign.artifact.sig.v1+json");
    expect(m.subject).toEqual({ mediaType: OCI_MANIFEST, digest: D("1"), size: 900 });
    expect(m.layers[0]!.annotations).toEqual({ "dev.cosignproject.cosign/signature": "MEUC" });
  });

  it("schema1 rejected", () => {
    const schema1 = bytes({ schemaVersion: 1, name: "app", tag: "latest", architecture: "amd64", fsLayers: [] });
    expect(codeOf(() => parseManifest(schema1, "application/vnd.docker.distribution.manifest.v1+prettyjws"))).toBe(
      "MANIFEST_INVALID",
    );
    expect(codeOf(() => parseManifest(schema1, null))).toBe("MANIFEST_INVALID");
  });

  it("content-type mismatch rejected", () => {
    const body = bytes({
      schemaVersion: 2,
      mediaType: DOCKER_V2,
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: D("a"), size: 10 },
      layers: [],
    });
    expect(codeOf(() => parseManifest(body, OCI_MANIFEST))).toBe("MANIFEST_INVALID");
  });

  it("a generic Content-Type defers to the body's mediaType", () => {
    const body = bytes({
      schemaVersion: 2,
      mediaType: DOCKER_V2,
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: D("a"), size: 10 },
      layers: [],
    });
    expect(parseManifest(body, "application/json").mediaType).toBe(DOCKER_V2);
    expect(parseManifest(body, "application/octet-stream").mediaType).toBe(DOCKER_V2);
  });

  it("invalid JSON rejected", () => {
    expect(codeOf(() => parseManifest(Buffer.from("{not json"), OCI_MANIFEST))).toBe("MANIFEST_INVALID");
    expect(codeOf(() => parseManifest(Buffer.from("[]"), OCI_MANIFEST))).toBe("MANIFEST_INVALID");
  });

  it("malformed descriptors rejected", () => {
    const bad = (layer: unknown) =>
      bytes({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: D("a"), size: 10 },
        layers: [layer],
      });
    expect(codeOf(() => parseManifest(bad({ mediaType: "x", digest: "sha256:zz", size: 1 }), OCI_MANIFEST))).toBe(
      "MANIFEST_INVALID",
    );
    expect(codeOf(() => parseManifest(bad({ mediaType: "x", digest: D("b"), size: -1 }), OCI_MANIFEST))).toBe(
      "MANIFEST_INVALID",
    );
    const noConfig = bytes({ schemaVersion: 2, mediaType: OCI_MANIFEST, layers: [] });
    expect(codeOf(() => parseManifest(noConfig, OCI_MANIFEST))).toBe("MANIFEST_INVALID");
    const noManifests = bytes({ schemaVersion: 2, mediaType: OCI_INDEX });
    expect(codeOf(() => parseManifest(noManifests, OCI_INDEX))).toBe("MANIFEST_INVALID");
  });
});

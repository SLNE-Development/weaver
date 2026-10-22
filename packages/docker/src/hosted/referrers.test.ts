import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  descriptorOf,
  digestOf,
  pushBlob,
  pushManifest,
  randomBlob,
  startDockerTestRegistry,
  type DockerTestRegistry,
} from "../testing.js";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const EMPTY = "application/vnd.oci.empty.v1+json";
const SIG = "application/vnd.dev.cosign.artifact.sig.v1+json";
const SPDX = "application/spdx+json";

describe("hosted referrers", () => {
  let reg: DockerTestRegistry;
  let key: string;
  let imageDigest: string;
  let subject: { mediaType: string; digest: string; size: number };
  let sigDigest: string;
  let sbomDigest: string;
  let sigPut: Response;
  const empty = Buffer.from("{}");

  beforeAll(async () => {
    reg = await startDockerTestRegistry();
    await reg.createRepo({ name: "hosted", format: "docker", kind: "hosted" });
    key = reg.tokenFor([{ repo: "hosted", access: "write" }]);

    const config = Buffer.from(JSON.stringify({ os: "linux", architecture: "amd64" }));
    const layer = randomBlob(1, 500);
    const sigLayer = Buffer.from('{"critical":{}}');
    const sbom = Buffer.from('{"spdxVersion":"SPDX-2.3"}');
    for (const blob of [config, layer, empty, sigLayer, sbom]) {
      expect((await pushBlob(reg, "hosted/app", blob, key)).status).toBe(201);
    }
    const image = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: descriptorOf(config, "application/vnd.oci.image.config.v1+json"),
      layers: [descriptorOf(layer, "application/vnd.oci.image.layer.v1.tar+gzip")],
    };
    const imageBytes = Buffer.from(JSON.stringify(image));
    imageDigest = digestOf(imageBytes);
    subject = descriptorOf(imageBytes, OCI_MANIFEST);
    expect((await pushManifest(reg, "hosted/app", "v1", image, key)).status).toBe(201);

    const sig = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      artifactType: SIG,
      config: descriptorOf(empty, EMPTY),
      layers: [descriptorOf(sigLayer, "application/vnd.dev.cosign.simplesigning.v1+json")],
      subject,
      annotations: { "dev.sigstore.cosign/bundle": "x" },
    };
    sigDigest = digestOf(Buffer.from(JSON.stringify(sig)));
    sigPut = await pushManifest(reg, "hosted/app", sigDigest, sig, key);

    // An SBOM whose artifact type comes from its config media type (older oras style).
    const sbomManifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: descriptorOf(empty, SPDX),
      layers: [descriptorOf(sbom, SPDX)],
      subject,
    };
    sbomDigest = digestOf(Buffer.from(JSON.stringify(sbomManifest)));
    expect((await pushManifest(reg, "hosted/app", sbomDigest, sbomManifest, key)).status).toBe(201);
  });
  afterAll(async () => {
    await reg?.stop();
  });

  async function referrers(query = "") {
    const res = await reg.call("GET", `hosted/app/referrers/${imageDigest}${query}`, { token: key });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(OCI_INDEX);
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    const body = (await res.json()) as {
      schemaVersion: number;
      mediaType: string;
      manifests: Array<{ mediaType: string; digest: string; size: number; artifactType?: string; annotations?: unknown }>;
    };
    return { res, body };
  }

  it("cosign signature and SBOM attached to an image are listed", async () => {
    const { res, body } = await referrers();
    expect(res.headers.get("oci-filters-applied")).toBeNull();
    expect(body.schemaVersion).toBe(2);
    expect(body.mediaType).toBe(OCI_INDEX);
    const byDigest = new Map(body.manifests.map((m) => [m.digest, m]));
    expect(byDigest.size).toBe(2);
    expect(byDigest.get(sigDigest)).toMatchObject({
      mediaType: OCI_MANIFEST,
      artifactType: SIG,
      annotations: { "dev.sigstore.cosign/bundle": "x" },
    });
    expect(byDigest.get(sigDigest)!.size).toBeGreaterThan(0);
    expect(byDigest.get(sbomDigest)).toMatchObject({ mediaType: OCI_MANIFEST, artifactType: SPDX });
  });

  it("artifactType filter returns only matches and sets OCI-Filters-Applied", async () => {
    const { res, body } = await referrers(`?artifactType=${encodeURIComponent(SPDX)}`);
    expect(res.headers.get("oci-filters-applied")).toBe("artifactType");
    expect(body.manifests.map((m) => m.digest)).toEqual([sbomDigest]);
  });

  it("OCI-Subject header on push of a referrer", () => {
    expect(sigPut.status).toBe(201);
    expect(sigPut.headers.get("oci-subject")).toBe(imageDigest);
  });

  it("empty index for a digest without referrers", async () => {
    const res = await reg.call("GET", `hosted/app/referrers/${sigDigest}`, { token: key });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [] });
    const unknown = await reg.call("GET", `hosted/app/referrers/${digestOf(Buffer.from("none"))}`, { token: key });
    expect(unknown.status).toBe(200);
  });

  it("a referrer may be pushed before its subject exists", async () => {
    const missing = { mediaType: OCI_MANIFEST, digest: digestOf(Buffer.from("later")), size: 5 };
    const sig = { schemaVersion: 2, mediaType: OCI_MANIFEST, artifactType: SIG, config: descriptorOf(empty, EMPTY), layers: [], subject: missing };
    const put = await pushManifest(reg, "hosted/app", "sha256-later", sig, key);
    expect(put.status).toBe(201);
    const res = await reg.call("GET", `hosted/app/referrers/${missing.digest}`, { token: key });
    expect(((await res.json()) as { manifests: unknown[] }).manifests).toHaveLength(1);
  });
});

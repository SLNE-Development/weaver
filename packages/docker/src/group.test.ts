import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerBlob } from "@weaver/db";
import type { DockerClaims } from "./auth/jwt.js";
import { startFakeUpstream, type FakeUpstream } from "./mirror/fake-upstream.js";
import {
  descriptorOf,
  digestOf,
  errorCodeOf,
  pushBlob,
  pushManifest,
  randomBlob,
  startDockerTestRegistry,
  type DockerTestRegistry,
} from "./testing.js";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

describe("docker groups", () => {
  let reg: DockerTestRegistry;
  let fake: FakeUpstream;
  let admin: string;
  const digests: Record<string, string> = {};
  const onlyInSecond = randomBlob(42, 2048);
  const upstreamManifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, layers: [] }));

  /** Pushes a one-layer image to `name` under `tag` in a hosted repo; resolves to its manifest digest. */
  async function pushImage(name: string, tag: string, seed: number): Promise<string> {
    const config = Buffer.from(JSON.stringify({ os: "linux", architecture: "amd64", seed }));
    const layer = randomBlob(seed, 500);
    expect((await pushBlob(reg, name, config, admin)).status).toBe(201);
    expect((await pushBlob(reg, name, layer, admin)).status).toBe(201);
    const manifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: descriptorOf(config, OCI_CONFIG),
      layers: [descriptorOf(layer, OCI_LAYER)],
    };
    const res = await pushManifest(reg, name, tag, manifest, admin);
    expect(res.status).toBe(201);
    return res.headers.get("docker-content-digest")!;
  }

  beforeAll(async () => {
    fake = await startFakeUpstream();
    digests.upstream = fake.addManifest("app", "up", upstreamManifest, OCI_MANIFEST);
    reg = await startDockerTestRegistry();
    await reg.createRepo({ name: "one", format: "docker", kind: "hosted" });
    await reg.createRepo({ name: "two", format: "docker", kind: "hosted" });
    await reg.createRepo({ name: "mir", format: "docker", kind: "mirror", upstreams: [{ url: fake.url, authType: "none" }] });
    await reg.createRepo({ name: "grp", format: "docker", kind: "group", members: ["one", "two", "mir"] });
    admin = reg.tokenFor(
      [
        { repo: "one", access: "write" },
        { repo: "two", access: "write" },
        { repo: "grp", access: "write" },
        { repo: "grp3", access: "read" },
      ],
      { role: "admin" },
    );
    digests.one = await pushImage("one/app", "1", 1);
    digests.two = await pushImage("two/app", "1", 2);
    digests.twoOnly = await pushImage("two/app", "2", 3);
    await pushImage("one/app", "x", 4);
    await pushImage("two/solo", "s", 5);
    expect((await pushBlob(reg, "two/app", onlyInSecond, admin)).status).toBe(201);
  });
  afterAll(async () => {
    await reg?.stop();
    await fake?.close();
  });

  it("manifest from the first member that has it", async () => {
    const res = await reg.call("GET", "grp/app/manifests/1", { token: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digests.one);
    expect(digestOf(Buffer.from(await res.arrayBuffer()))).toBe(digests.one);
    expect(digests.one).not.toBe(digests.two);
  });

  it("falls through a hosted miss to a mirror", async () => {
    const res = await reg.call("GET", "grp/app/manifests/up", { token: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digests.upstream);
    expect(Buffer.from(await res.arrayBuffer()).equals(upstreamManifest)).toBe(true);
  });

  it("blob only in the second member is served", async () => {
    const res = await reg.call("GET", `grp/app/blobs/${digestOf(onlyInSecond)}`, { token: admin });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(onlyInSecond)).toBe(true);
  });

  it("read on the group alone serves a private member's content", async () => {
    const reader = reg.tokenFor([{ repo: "grp", access: "read" }]);
    const res = await reg.call("GET", "grp/app/manifests/2", { token: reader });
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digests.twoOnly);
    await res.body?.cancel();
    const direct = await reg.call("GET", "two/app/manifests/2", { token: reader });
    expect(direct.status).toBe(403);
    await direct.body?.cancel();
  });

  it("tags/list comes from the first member with the image", async () => {
    const res = await reg.call("GET", "grp/app/tags/list", { token: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "grp/app", tags: ["1", "x"] });
    const solo = await reg.call("GET", "grp/solo/tags/list", { token: admin });
    expect(solo.status).toBe(200);
    expect(await solo.json()).toEqual({ name: "grp/solo", tags: ["s"] });
  });

  it("referrers come from the first member holding the image", async () => {
    const res = await reg.call("GET", `grp/solo/referrers/${digests.one}`, { token: admin });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { manifests: unknown[] }).manifests).toEqual([]);
  });

  it("an item no member has is 404", async () => {
    const m = await reg.call("GET", "grp/app/manifests/nope", { token: admin });
    expect(m.status).toBe(404);
    expect(await errorCodeOf(m)).toBe("MANIFEST_UNKNOWN");
    const b = await reg.call("GET", `grp/app/blobs/sha256:${"f".repeat(64)}`, { token: admin });
    expect(b.status).toBe(404);
    expect(await errorCodeOf(b)).toBe("BLOB_UNKNOWN");
    const t = await reg.call("GET", "grp/ghost/tags/list", { token: admin });
    expect(t.status).toBe(404);
    expect(await errorCodeOf(t)).toBe("NAME_UNKNOWN");
  });

  it("a failing mirror member does not hide a later member's content", async () => {
    await reg.createRepo({ name: "down", format: "docker", kind: "mirror", upstreams: [{ url: "http://127.0.0.1:1", authType: "none" }] });
    await reg.createRepo({ name: "grp2", format: "docker", kind: "group", members: ["down", "one"] });
    const token = reg.tokenFor([{ repo: "grp2", access: "read" }]);
    const res = await reg.call("GET", "grp2/app/manifests/1", { token });
    expect(res.status).toBe(200);
    expect(res.headers.get("docker-content-digest")).toBe(digests.one);
    await res.body?.cancel();
    const miss = await reg.call("GET", "grp2/app/manifests/nope", { token });
    expect(miss.status).toBe(502);
    expect(await errorCodeOf(miss)).toBe("UNAVAILABLE");
  });

  it("a hosted member that fails does not fall through to a later member", async () => {
    const data = randomBlob(77, 1500);
    fake.addBlob("app", data);
    expect((await pushBlob(reg, "one/app", data, admin)).status).toBe(201);
    await reg.createRepo({ name: "grp3", format: "docker", kind: "group", members: ["one", "mir"] });
    await reg.deps.db.update(dockerBlob).set({ store: "s3" }).where(eq(dockerBlob.digest, digestOf(data)));
    fake.reset();
    const res = await reg.call("GET", `grp3/app/blobs/${digestOf(data)}`, { token: admin });
    expect(res.status).toBe(500);
    expect(await errorCodeOf(res)).toBe("UNKNOWN");
    expect(fake.requests).toHaveLength(0);
  });

  it("push to a group → 405 UNSUPPORTED", async () => {
    const res = await reg.call("POST", "grp/app/blobs/uploads/", { token: admin });
    expect(res.status).toBe(405);
    expect(await errorCodeOf(res)).toBe("UNSUPPORTED");
    const del = await reg.call("DELETE", `grp/app/manifests/${digests.one}`, { token: admin });
    expect(del.status).toBe(405);
    expect(await errorCodeOf(del)).toBe("UNSUPPORTED");
  });

  it("token service never grants push on group/app", async () => {
    const res = await reg.call("GET", "token?service=weaver.test&scope=repository:grp/app:pull,push,delete", { token: admin });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as DockerClaims;
    expect(claims.access).toEqual([expect.objectContaining({ name: "grp/app", actions: ["pull"] })]);
  });
});

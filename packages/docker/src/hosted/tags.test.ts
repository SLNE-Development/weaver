import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  descriptorOf,
  errorCodeOf,
  pushBlob,
  pushManifest,
  startDockerTestRegistry,
  type DockerTestRegistry,
} from "../testing.js";
import { listTags } from "./tags.js";

describe("hosted tags", () => {
  let reg: DockerTestRegistry;
  let key: string;
  let repoId: string;
  const tags = ["b", "a", "C", "c", "a-1", "_x"];
  beforeAll(async () => {
    reg = await startDockerTestRegistry();
    repoId = (await reg.createRepo({ name: "hosted", format: "docker", kind: "hosted" })).id;
    key = reg.tokenFor([{ repo: "hosted", access: "write" }]);
    const config = Buffer.from("{}");
    expect((await pushBlob(reg, "hosted/app", config, key)).status).toBe(201);
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: descriptorOf(config, "application/vnd.oci.empty.v1+json"),
      layers: [],
    };
    for (const tag of tags) expect((await pushManifest(reg, "hosted/app", tag, manifest, key)).status).toBe(201);
    expect((await pushBlob(reg, "hosted/blobsonly", config, key)).status).toBe(201);
  });
  afterAll(async () => {
    await reg?.stop();
  });

  async function list(query = "") {
    const res = await reg.call("GET", `hosted/app/tags/list${query}`, { token: key });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    return { res, body: (await res.json()) as { name: string; tags: string[] } };
  }

  it("sorted lexically", async () => {
    const { res, body } = await list();
    expect(body).toEqual({ name: "hosted/app", tags: ["C", "_x", "a", "a-1", "b", "c"] });
    expect(res.headers.get("link")).toBeNull();
  });

  it("n=2 returns 2 tags and a Link to the next page", async () => {
    const { res, body } = await list("?n=2");
    expect(body.tags).toEqual(["C", "_x"]);
    expect(res.headers.get("link")).toBe('</v2/hosted/app/tags/list?n=2&last=_x>; rel="next"');
    const last = await list("?n=4&last=a-1");
    expect(last.body.tags).toEqual(["b", "c"]);
    expect(last.res.headers.get("link")).toBeNull();
  });

  it("last=b continues after b", async () => {
    const { body } = await list("?last=b");
    expect(body.tags).toEqual(["c"]);
  });

  it("a non-numeric n → 400 UNSUPPORTED", async () => {
    for (const n of ["abc", "-1", "2.5"]) {
      const res = await reg.call("GET", `hosted/app/tags/list?n=${n}`, { token: key });
      expect(res.status).toBe(400);
      expect(await errorCodeOf(res)).toBe("UNSUPPORTED");
    }
  });

  it("n=0 returns no tags", async () => {
    const { body } = await list("?n=0");
    expect(body.tags).toEqual([]);
  });

  it("caps pages at 1000", async () => {
    const page = await listTags(reg.deps.db, repoId, "app", 5000, null);
    expect(page).toEqual({ tags: ["C", "_x", "a", "a-1", "b", "c"], more: false });
    const two = await listTags(reg.deps.db, repoId, "app", 2, "a");
    expect(two).toEqual({ tags: ["a-1", "b"], more: true });
  });

  it("an image with blobs but no tags lists none; an unknown image → 404 NAME_UNKNOWN", async () => {
    const empty = await reg.call("GET", "hosted/blobsonly/tags/list", { token: key });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ name: "hosted/blobsonly", tags: [] });
    const res = await reg.call("GET", "hosted/nothing/tags/list", { token: key });
    expect(res.status).toBe(404);
    expect(await errorCodeOf(res)).toBe("NAME_UNKNOWN");
  });
});

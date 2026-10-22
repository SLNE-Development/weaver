import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checksumText } from "./checksum.js";
import { renderArtifactMetadata } from "./metadata.js";
import { startMavenFixture, type MavenFixture } from "./testing/fixture.js";
import { startStubUpstream, type StubUpstream } from "./testing/upstream.js";

const META = "org/ex/lib/maven-metadata.xml";

/** Artifact metadata XML of org.ex:lib with the given versions. */
const metaXml = (...versions: string[]) => renderArtifactMetadata({ groupId: "org.ex", artifactId: "lib", versions, lastUpdated: "20261022101010" });

describe("maven group repositories", () => {
  let fx: MavenFixture;
  let upstream: StubUpstream;

  /** PUTs a file into a hosted repository as admin-level token. */
  const put = async (repo: string, path: string, body: string) => {
    const token = await fx.token([{ repo, access: "write" }]);
    expect((await fx.request("PUT", `${repo}/${path}`, { body, token })).status).toBe(201);
  };

  beforeAll(async () => {
    fx = await startMavenFixture();
    upstream = await startStubUpstream();
    await fx.createRepo({ name: "a", format: "maven", kind: "hosted", visibility: "private" });
    await fx.createRepo({ name: "b", format: "maven", kind: "hosted", visibility: "public" });
    await fx.createRepo({ name: "m", format: "maven", kind: "mirror", visibility: "public", upstreams: [{ url: upstream.url, authType: "none" }] });
    await fx.createRepo({ name: "g", format: "maven", kind: "group", visibility: "private", members: ["a", "b", "m"] });
    await put("a", "org/ex/lib/1.0/lib-1.0.jar", "from-a");
    await put("b", "org/ex/lib/1.0/lib-1.0.jar", "from-b");
    await put("b", "org/ex/lib/2.0/lib-2.0.jar", "b-two");
    await put("a", "org/ex/lib/1.0/lib-1.0.pom", "<project/>");
  }, 120_000);

  afterAll(async () => {
    await upstream?.close();
    await fx?.stop();
  });

  beforeEach(() => {
    upstream.files.clear();
    upstream.hits.length = 0;
    upstream.down = false;
    upstream.statuses.clear();
  });

  /** A token with read on the group only. */
  const groupToken = () => fx.token([{ repo: "g", access: "read" }]);
  const get = async (path: string, method = "GET") => fx.request(method, `g/${path}`, { token: await groupToken() });

  it("first member wins", async () => {
    const res = await get("org/ex/lib/1.0/lib-1.0.jar");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-a");
  });

  it("falls through to later members", async () => {
    upstream.files.set("org/ex/other/1/other-1.jar", "from-upstream");
    const res = await get("org/ex/other/1/other-1.jar");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-upstream");
  });

  it("merges artifact metadata", async () => {
    upstream.files.set(META, metaXml("1.5"));
    const res = await get(META);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect([...body.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])).toEqual(["1.0", "1.5", "2.0"]);
    expect(body).toContain("<release>2.0</release>");
    const sha1 = await get(`${META}.sha1`);
    expect(await sha1.text()).toBe(checksumText(body, "sha1"));
  });

  it("metadata merge skips a member whose upstream is down", async () => {
    upstream.down = true;
    const res = await get(META);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect([...body.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])).toEqual(["1.0", "2.0"]);
  });

  it("file only in a dead mirror answers 502", async () => {
    upstream.down = true;
    expect((await get("org/ex/none/1/none-1.jar")).status).toBe(502);
  });

  it("an upstream 401 never becomes a client challenge", async () => {
    upstream.statuses.set("org/ex/none/1/none-1.jar", 401);
    const res = await get("org/ex/none/1/none-1.jar");
    expect(res.status).toBe(502);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("file in no member answers 404", async () => {
    expect((await get("org/ex/none/1/none-1.jar")).status).toBe(404);
  });

  it("metadata missing everywhere while a member failed answers 502, never a cacheable 404", async () => {
    upstream.down = true;
    expect((await get("org/ex/ghost/maven-metadata.xml")).status).toBe(502);
  });

  it("metadata in no member answers 404", async () => {
    expect((await get("org/ex/ghost/maven-metadata.xml")).status).toBe(404);
  });

  it("a private member is readable through a group token", async () => {
    const token = await groupToken();
    expect((await fx.request("GET", "a/org/ex/lib/1.0/lib-1.0.pom", { token })).status).toBe(403);
    const res = await fx.request("GET", "g/org/ex/lib/1.0/lib-1.0.pom", { token });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<project/>");
  });

  it("group token cannot PUT", async () => {
    const token = await fx.token([{ repo: "g", access: "read" }]);
    expect((await fx.request("PUT", "g/org/ex/lib/3.0/lib-3.0.jar", { token, body: "x" })).status).toBe(405);
  });

  it("serves HEAD without a body", async () => {
    const res = await get("org/ex/lib/1.0/lib-1.0.jar", "HEAD");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

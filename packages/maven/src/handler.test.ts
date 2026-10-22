import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMavenFixture, type MavenFixture } from "./testing/fixture.js";

describe("maven handler authorization", () => {
  let fx: MavenFixture;

  beforeAll(async () => {
    fx = await startMavenFixture();
    await fx.createRepo({ name: "releases", format: "maven", kind: "hosted", visibility: "public" });
    await fx.createRepo({ name: "secret", format: "maven", kind: "hosted", visibility: "private" });
    await fx.createRepo({ name: "proxy", format: "maven", kind: "mirror", visibility: "private", upstreams: [{ url: "http://127.0.0.1:1/", authType: "none" }] });
    await fx.createRepo({ name: "all", format: "maven", kind: "group", visibility: "private", members: ["releases", "secret"] });
    await fx.createRepo({ name: "pkgs", format: "npm", kind: "hosted", visibility: "public" });
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("unknown repo answers 404", async () => {
    expect((await fx.request("GET", "nope/a/b.jar")).status).toBe(404);
  });

  it("npm repo under /maven answers 404", async () => {
    expect((await fx.request("GET", "pkgs/a/b.jar")).status).toBe(404);
  });

  it("bare repo name redirects", async () => {
    const res = await fx.request("GET", "releases");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("http://weaver.test/maven/releases/");
  });

  it("anonymous GET on a private repo gets 401 with Basic challenge", async () => {
    const res = await fx.request("GET", "secret/a/b.jar");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Weaver"');
  });

  it("anonymous PUT to a public hosted repo gets 401 with Basic challenge", async () => {
    const res = await fx.request("PUT", "releases/a/b/1/b-1.jar", { body: "x" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Weaver"');
  });

  it("token without grant gets 403 on GET and PUT", async () => {
    const token = await fx.token([]);
    expect((await fx.request("GET", "secret/a/b.jar", { token })).status).toBe(403);
    expect((await fx.request("PUT", "secret/a/b/1/b-1.jar", { token, body: "x" })).status).toBe(403);
  });

  it("read token gets 403 on PUT", async () => {
    const token = await fx.token([{ repo: "releases", access: "read" }]);
    expect((await fx.request("PUT", "releases/a/b/1/b-1.jar", { token, body: "x" })).status).toBe(403);
  });

  it("invalid token gets 401 even on a public repo", async () => {
    const res = await fx.request("GET", "releases/a/b.jar", { token: "bogus" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Weaver"');
  });

  it("Basic and Bearer tokens are both accepted", async () => {
    const token = await fx.token([{ repo: "secret", access: "read" }]);
    expect((await fx.request("GET", "secret/a/b.jar", { token })).status).toBe(404);
    expect((await fx.request("GET", "secret/a/b.jar", { token, basic: true })).status).toBe(404);
  });

  it("PUT to a group or mirror answers 405 with Allow: GET, HEAD", async () => {
    for (const repo of ["all", "proxy"]) {
      const res = await fx.request("PUT", `${repo}/a/b/1/b-1.jar`, { body: "x" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("DELETE on hosted answers 405 with Allow: GET, HEAD, PUT", async () => {
    const res = await fx.request("DELETE", "releases/a/b/1/b-1.jar");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, PUT");
  });

  it("anonymous GET on a public repo is allowed", async () => {
    const res = await fx.request("GET", "releases/a/b/1/b-1.jar");
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("the releases/ directory form dispatches to the listing without a redirect", async () => {
    const root = await fx.request("GET", "releases/");
    expect(root.headers.get("location")).toBeNull();
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const empty = await fx.request("GET", "releases/org/example/");
    expect(empty.headers.get("location")).toBeNull();
    expect(empty.status).toBe(404);
  });

  it("group read token reads the group", async () => {
    const token = await fx.token([{ repo: "all", access: "read" }]);
    expect((await fx.request("GET", "all/a/b.jar", { token })).status).toBe(404);
  });
});

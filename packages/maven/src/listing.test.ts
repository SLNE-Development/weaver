import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderListing } from "./listing.js";
import { startMavenFixture, type MavenFixture } from "./testing/fixture.js";
import { startStubUpstream, type StubUpstream } from "./testing/upstream.js";

describe("maven directory listings", () => {
  let fx: MavenFixture;
  let upstream: StubUpstream;
  let token: string;

  beforeAll(async () => {
    fx = await startMavenFixture();
    upstream = await startStubUpstream({ "org/x/1/x-1.jar": "x" });
    await fx.createRepo({ name: "rel", format: "maven", kind: "hosted" });
    await fx.createRepo({ name: "first", format: "maven", kind: "hosted" });
    await fx.createRepo({ name: "second", format: "maven", kind: "hosted" });
    await fx.createRepo({ name: "both", format: "maven", kind: "group", members: ["first", "second"] });
    await fx.createRepo({ name: "proxy", format: "maven", kind: "mirror", upstreams: [{ url: upstream.url, authType: "none" }] });
    token = await fx.token(["rel", "first", "second", "both", "proxy"].map((repo) => ({ repo, access: "write" as const })));

    const put = async (path: string, body: string) => expect((await fx.request("PUT", path, { token, body })).status).toBe(201);
    await put("rel/org/example/lib/1.0/lib-1.0.jar", "jar-bytes");
    await put("rel/org/example/lib/1.0/lib-1.0.pom", "<project/>");
    await put("rel/a%3Cb%3E.txt", "odd");
    await put("first/x/1.txt", "aa");
    await put("second/x/1.txt", "bbbb");
    await put("second/x/2.txt", "ccc");
  }, 120_000);

  afterAll(async () => {
    await upstream?.close();
    await fx?.stop();
  });

  /** GETs a listing with the token and returns status, content type and body text. */
  const list = async (path: string) => {
    const res = await fx.request("GET", path, { token });
    return { status: res.status, type: res.headers.get("content-type"), html: await res.text() };
  };

  it("root lists top-level directories", async () => {
    const { status, type, html } = await list("rel/");
    expect(status).toBe(200);
    expect(type).toBe("text/html; charset=utf-8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Weaver: rel/</title>");
    expect(html).toContain('<a href="org/">org/</a>');
    expect(html).not.toContain('<a href="../">');
    expect(html).not.toContain("example/");
  });

  it("lists files with sizes in a version directory", async () => {
    const { status, html } = await list("rel/org/example/lib/1.0/");
    expect(status).toBe(200);
    expect(html).toContain("<title>Weaver: rel/org/example/lib/1.0/</title>");
    expect(html).toContain('<a href="../">../</a>');
    const jarLine = html.split("\n").find((line) => line.includes('href="lib-1.0.jar"'));
    expect(jarLine).toBeDefined();
    expect(jarLine).toMatch(/\s9\s/);
    expect(jarLine).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(html).toContain('<a href="lib-1.0.pom">lib-1.0.pom</a>');
  });

  it("escapes names", async () => {
    const { html } = await list("rel/");
    expect(html).toContain('<a href="a%3Cb%3E.txt">a&lt;b&gt;.txt</a>');
    expect(html).not.toContain("a<b>");
  });

  it("puts directories first, then sorts by name", async () => {
    const { html } = await list("rel/");
    expect(html.indexOf('href="org/"')).toBeLessThan(html.indexOf('href="a%3Cb%3E.txt"'));
  });

  it("unknown directory answers 404", async () => {
    expect((await list("rel/org/nothing/")).status).toBe(404);
  });

  it("group lists the union of members, first member wins", async () => {
    const { status, html } = await list("both/x/");
    expect(status).toBe(200);
    const one = html.split("\n").find((line) => line.includes('href="1.txt"'));
    expect(one).toMatch(/\s2\s/);
    expect(html).toContain('<a href="2.txt">2.txt</a>');
    expect(html.match(/href="1\.txt"/g)).toHaveLength(1);
  });

  it("mirror lists only cached assets", async () => {
    const { status, html } = await list("proxy/");
    expect(status).toBe(200);
    expect(html).not.toMatch(/<a href="(?!\.\.\/)/);
  });

  it("HEAD answers the listing headers without a body", async () => {
    const res = await fx.request("HEAD", "rel/", { token });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("renderListing encodes each href segment and escapes the title", () => {
    const html = renderListing("r&d", "a b/", [{ name: "c d", directory: true, size: null, updatedAt: null }]);
    expect(html).toContain("<title>Weaver: r&amp;d/a b/</title>");
    expect(html).toContain('<a href="c%20d/">c d/</a>');
  });
});

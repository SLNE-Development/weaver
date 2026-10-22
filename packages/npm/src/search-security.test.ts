import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test/harness.js";
import { startFakeRegistry, type FakeRegistry } from "./test/fake-registry.js";
import { makeTarball, publishBody } from "./test/fixtures.js";
import type { SearchResult } from "./search.js";
import { NO_ADVISORIES_QUICK } from "./security.js";

let h: Harness;
let fake: FakeRegistry;
let second: FakeRegistry;
let gzip: FakeRegistry;
let down: FakeRegistry;

/** Publishes `name@1.0.0` to `repo` with a description and keywords. */
async function publish(repo: string, name: string, description: string, keywords: string[]): Promise<void> {
  const body = publishBody(name, "1.0.0", await makeTarball(name, "1.0.0")) as Record<string, unknown> & {
    versions: Record<string, Record<string, unknown>>;
  };
  body["description"] = description;
  body.versions["1.0.0"]!["description"] = description;
  body.versions["1.0.0"]!["keywords"] = keywords;
  const res = await h.call("PUT", `${repo}/${name.replace("/", "%2f")}`, { token: h.tokens.writer, json: body });
  expect(res.status).toBe(201);
}

/** The package names of a search answer, in order. */
async function names(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as SearchResult).objects.map((o) => o.package.name);
}

const AUDIT_BODY = JSON.stringify({ "left-pad": ["1.3.0"], react: ["18.0.0"] });

beforeAll(async () => {
  h = await createHarness();
  fake = await startFakeRegistry([
    { name: "react", versions: ["18.0.0"] },
    { name: "react-dom", versions: ["18.0.0"] },
    { name: "left-pad", versions: ["1.3.0"] },
  ]);
  second = await startFakeRegistry([{ name: "react", versions: ["18.0.0"] }]);
  gzip = await startFakeRegistry([{ name: "react", versions: ["18.0.0"] }], { gzip: true });
  down = await startFakeRegistry([]);
  down.setOffline(true);

  await h.createRepo({ name: "npm-hosted", format: "npm", kind: "hosted", visibility: "public" });
  await h.createRepo({ name: "npm-private", format: "npm", kind: "hosted", visibility: "private" });
  const mirror = (name: string, url: string, config?: unknown) =>
    h.createRepo({ name, format: "npm", kind: "mirror", visibility: "public", upstreams: [{ url, authType: "none" }], config });
  await mirror("npm-mirror", fake.url);
  await mirror("npm-second", second.url);
  await mirror("npm-gzip", gzip.url);
  await mirror("npm-down", down.url);
  await mirror("npm-offline", fake.url, { offline: true });
  await h.createRepo({ name: "npm-group", format: "npm", kind: "group", visibility: "public", members: ["npm-hosted", "npm-mirror", "npm-second"] });
  await h.createRepo({ name: "npm-group-hosted", format: "npm", kind: "group", visibility: "public", members: ["npm-hosted"] });
  await h.createRepo({ name: "npm-group-down", format: "npm", kind: "group", visibility: "public", members: ["npm-hosted", "npm-down"] });
  await h.createRepo({ name: "npm-hosted-b", format: "npm", kind: "hosted", visibility: "public" });
  await h.createRepo({ name: "npm-group2", format: "npm", kind: "group", visibility: "public", members: ["npm-hosted", "npm-hosted-b", "npm-mirror"] });
  await mirror("npm-rules", fake.url, { rules: { deny: ["react-dom"] } });
  await mirror("npm-allow", fake.url, { rules: { allow: ["left-*", "react"] } });
  await h.createRepo({ name: "npm-group-rules", format: "npm", kind: "group", visibility: "public", members: ["npm-hosted", "npm-rules"] });
  await h.createRepo({ name: "npm-group-mirrors", format: "npm", kind: "group", visibility: "public", members: ["npm-mirror", "npm-second"] });

  await publish("npm-hosted", "react", "the real thing", ["ui"]);
  await publish("npm-hosted", "alpha", "helpers for React apps", []);
  await publish("npm-hosted", "@acme/widgets", "widgets", ["react", "ui"]);
  await publish("npm-hosted", "zeta-react", "z", []);
  await publish("npm-hosted", "unrelated", "nothing to see", ["misc"]);
  await publish("npm-private", "secret-react", "private", []);
  await publish("npm-hosted-b", "react", "a shadow copy", []);
  await publish("npm-hosted-b", "react-b-only", "b", []);
}, 180_000);

afterAll(async () => {
  await h?.stop();
  await fake?.close();
  await second?.close();
  await gzip?.close();
  await down?.close();
});

describe("npm search", () => {
  it("hosted search finds by name, description and keyword", async () => {
    const res = await h.call("GET", "npm-hosted/-/v1/search?text=react");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as SearchResult;
    expect(body.objects.map((o) => o.package.name).sort()).toEqual(["@acme/widgets", "alpha", "react", "zeta-react"]);
    expect(body.total).toBe(4);
    expect(typeof body.time).toBe("string");
    const react = body.objects.find((o) => o.package.name === "react")!;
    expect(react.package).toMatchObject({ name: "react", version: "1.0.0", description: "the real thing", keywords: ["ui"] });
    expect(react.package.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(react.score).toEqual({ final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } });
    expect(react.searchScore).toBe(1);
  });

  // npm search reads `package.maintainers` of every entry (`data.maintainers.map(...)`); without it npm 11 exits 1
  // without printing a result or an error.
  it("every hosted entry lists its maintainers, as npm search requires", async () => {
    const body = (await (await h.call("GET", "npm-hosted/-/v1/search?text=react")).json()) as SearchResult;
    expect(body.objects.length).toBeGreaterThan(0);
    for (const o of body.objects) expect(o.package.maintainers).toEqual([]);
    const group = (await (await h.call("GET", "npm-group-hosted/-/v1/search?text=react")).json()) as SearchResult;
    for (const o of group.objects) expect(Array.isArray(o.package.maintainers)).toBe(true);
  });

  it("exact name ranks first", async () => {
    expect(await names(await h.call("GET", "npm-hosted/-/v1/search?text=react"))).toEqual(["react", "@acme/widgets", "alpha", "zeta-react"]);
  });

  it("pages with size and from", async () => {
    const res = await h.call("GET", "npm-hosted/-/v1/search?text=react&size=2&from=1");
    const body = (await res.json()) as SearchResult;
    expect(body.objects.map((o) => o.package.name)).toEqual(["@acme/widgets", "alpha"]);
    expect(body.total).toBe(4);
    expect(await names(await h.call("GET", "npm-hosted/-/v1/search?text=react&size=abc&from=-3"))).toHaveLength(4);
  });

  it("needs read access", async () => {
    expect((await h.call("GET", "npm-private/-/v1/search?text=react")).status).toBe(401);
    expect(await names(await h.call("GET", "npm-private/-/v1/search?text=react", { token: h.tokens.reader }))).toEqual(["secret-react"]);
  });

  it("answers GET and HEAD only", async () => {
    const res = await h.call("POST", "npm-hosted/-/v1/search?text=react", { body: "{}" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("mirror search is forwarded with the query string", async () => {
    const res = await h.call("GET", "npm-mirror/-/v1/search?text=react&size=5", { token: h.tokens.reader });
    expect(await names(res)).toEqual(["react", "react-dom"]);
    expect(fake.hits).toContain("/-/v1/search?text=react&size=5");
    const forwarded = fake.requests.find((r) => r.url === "/-/v1/search?text=react&size=5")!;
    expect(forwarded.headers.authorization).toBeUndefined();
  });

  it("an offline mirror answers an empty search", async () => {
    const res = await h.call("GET", "npm-offline/-/v1/search?text=react");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ objects: [], total: 0 });
  });

  it("group search lists hosted results before upstream and dedups", async () => {
    const before = second.hits.length;
    const res = await h.call("GET", "npm-group/-/v1/search?text=react");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResult;
    expect(body.objects.map((o) => o.package.name)).toEqual(["react", "@acme/widgets", "alpha", "zeta-react", "react-dom"]);
    expect(body.objects[0]!.package.description).toBe("the real thing");
    expect(body.total).toBe(4 + 2 - 1);
    expect(second.hits.length).toBe(before);
  });

  it("group search dedups hosted members, earlier member first, and counts each name once", async () => {
    const before = fake.hits.length;
    const res = await h.call("GET", "npm-group2/-/v1/search?text=react");
    const body = (await res.json()) as SearchResult;
    expect(body.objects.map((o) => o.package.name)).toEqual(["react", "@acme/widgets", "alpha", "react-b-only", "zeta-react", "react-dom"]);
    expect(body.objects[0]!.package.description).toBe("the real thing");
    expect(body.total).toBe(5 + 2 - 1);
    expect(fake.hits.slice(before)).toEqual(["/-/v1/search?text=react&size=15&from=0"]);
  });

  it("group search pages across the hosted and upstream parts", async () => {
    const page = async (from: number) => {
      const before = fake.hits.length;
      const got = await names(await h.call("GET", `npm-group2/-/v1/search?text=react&size=3&from=${from}`));
      return { got, hits: fake.hits.slice(before) };
    };
    expect(await page(0)).toEqual({ got: ["react", "@acme/widgets", "alpha"], hits: ["/-/v1/search?text=react&size=1&from=0"] });
    // The upstream "react" is dropped on every page, since a hosted member has the name.
    expect(await page(3)).toEqual({ got: ["react-b-only", "zeta-react"], hits: ["/-/v1/search?text=react&size=1&from=0"] });
    expect(await page(6)).toEqual({ got: ["react-dom"], hits: ["/-/v1/search?text=react&size=3&from=1"] });
    expect(await names(await h.call("GET", "npm-group2/-/v1/search?text=react&size=2"))).toHaveLength(2);
  });

  it("mirror rules filter upstream search results", async () => {
    expect(await names(await h.call("GET", "npm-rules/-/v1/search?text=react"))).toEqual(["react"]);
    const allow = (await (await h.call("GET", "npm-allow/-/v1/search?text=e")).json()) as SearchResult;
    expect(allow.objects.map((o) => o.package.name)).toEqual(["react", "left-pad"]);
    expect(allow.total).toBe(2);
    expect(await names(await h.call("GET", "npm-group-rules/-/v1/search?text=react"))).toEqual(["react", "@acme/widgets", "alpha", "zeta-react"]);
  });

  it("group search keeps hosted results when the mirror member is down", async () => {
    expect(await names(await h.call("GET", "npm-group-down/-/v1/search?text=react"))).toEqual(["react", "@acme/widgets", "alpha", "zeta-react"]);
  });

  it("gzip upstream is passed through decoded", async () => {
    const res = await h.call("GET", "npm-gzip/-/v1/search?text=react", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await names(res)).toEqual(["react"]);
    const audit = await h.call("POST", "npm-gzip/-/npm/v1/security/advisories/bulk", {
      body: AUDIT_BODY,
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
    });
    expect(audit.status).toBe(200);
    expect(audit.headers.get("content-encoding")).toBeNull();
    expect(await audit.json()).toEqual({});
  });
});

describe("npm audit", () => {
  it("hosted bulk advisory answers {}", async () => {
    const res = await h.call("POST", "npm-hosted/-/npm/v1/security/advisories/bulk", { body: AUDIT_BODY, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("hosted audits answer no advisories", async () => {
    for (const path of ["audits", "audits/quick"]) {
      const res = await h.call("POST", `npm-hosted/-/npm/v1/security/${path}`, { body: "{}", headers: { "content-type": "application/json" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(NO_ADVISORIES_QUICK);
    }
    expect((await h.call("POST", "npm-hosted/-/npm/v1/security/other", { body: "{}" })).status).toBe(404);
    const get = await h.call("GET", "npm-hosted/-/npm/v1/security/advisories/bulk");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("needs read access", async () => {
    expect((await h.call("POST", "npm-private/-/npm/v1/security/advisories/bulk", { body: "{}" })).status).toBe(401);
    expect((await h.call("POST", "npm-private/-/npm/v1/security/advisories/bulk", { body: "{}", token: h.tokens.reader })).status).toBe(200);
  });

  it("mirror bulk advisory forwards the gzip body unchanged", async () => {
    const gz = gzipSync(Buffer.from(AUDIT_BODY));
    const res = await h.call("POST", "npm-mirror/-/npm/v1/security/advisories/bulk", {
      body: gz,
      token: h.tokens.reader,
      headers: { "content-type": "application/json", "content-encoding": "gzip", "x-forwarded-for": "10.0.0.1" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const forwarded = fake.requests.filter((r) => r.url === "/-/npm/v1/security/advisories/bulk").at(-1)!;
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers["content-encoding"]).toBe("gzip");
    expect(forwarded.headers["content-type"]).toBe("application/json");
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(forwarded.headers["x-forwarded-for"]).toBeUndefined();
    expect(forwarded.body.equals(gz)).toBe(true);
  });

  it("group audit goes to the first mirror member", async () => {
    const before = { fake: fake.hits.length, second: second.hits.length };
    const res = await h.call("POST", "npm-group-mirrors/-/npm/v1/security/audits/quick", {
      body: "{}",
      token: h.tokens.reader,
      headers: { "content-type": "application/json", cookie: "a=b" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(fake.hits.slice(before.fake)).toEqual(["/-/npm/v1/security/audits/quick"]);
    expect(second.hits.length).toBe(before.second);
    const forwarded = fake.requests.at(-1)!;
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(forwarded.headers.cookie).toBeUndefined();
  });

  it("group bulk audit keeps names served by hosted members out of the upstream request", async () => {
    const body = { react: ["1.0.0"], "@acme/widgets": ["1.0.0"], "left-pad": ["1.3.0"] };
    const res = await h.call("POST", "npm-group/-/npm/v1/security/advisories/bulk", {
      body: gzipSync(Buffer.from(JSON.stringify(body))),
      token: h.tokens.reader,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    const forwarded = fake.requests.at(-1)!;
    expect(forwarded.url).toBe("/-/npm/v1/security/advisories/bulk");
    expect(forwarded.headers["content-encoding"]).toBe("gzip");
    expect(forwarded.headers.authorization).toBeUndefined();
    expect(JSON.parse(gunzipSync(forwarded.body).toString("utf8"))).toEqual({ "left-pad": ["1.3.0"] });
  });

  it("mirror bulk audit drops names its rules exclude", async () => {
    const res = await h.call("POST", "npm-rules/-/npm/v1/security/advisories/bulk", {
      body: JSON.stringify({ "react-dom": ["18.0.0"], "left-pad": ["1.3.0"] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const forwarded = fake.requests.at(-1)!;
    expect(forwarded.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(forwarded.body.toString("utf8"))).toEqual({ "left-pad": ["1.3.0"] });

    await h.call("POST", "npm-allow/-/npm/v1/security/advisories/bulk", { body: JSON.stringify({ "react-dom": ["18.0.0"], react: ["18.0.0"] }) });
    expect(JSON.parse(fake.requests.at(-1)!.body.toString("utf8"))).toEqual({ react: ["18.0.0"] });
  });

  it("a bulk audit with nothing left to ask answers {} without the upstream", async () => {
    const before = fake.hits.length;
    const res = await h.call("POST", "npm-group/-/npm/v1/security/advisories/bulk", { body: JSON.stringify({ react: ["1.0.0"] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(fake.hits.length).toBe(before);
  });

  it("a compressed bulk audit that decodes beyond 16 MiB is a 413", async () => {
    const bomb = gzipSync(Buffer.alloc(17 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const before = fake.hits.length;
    for (const repo of ["npm-group", "npm-rules"]) {
      const res = await h.call("POST", `${repo}/-/npm/v1/security/advisories/bulk`, {
        body: bomb,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toHaveProperty("error");
    }
    expect(fake.hits.length).toBe(before);
  });

  it("a bulk audit naming more packages than SQL parameters allow is filtered in one query", async () => {
    const body: Record<string, string[]> = { react: ["1.0.0"], "left-pad": ["1.3.0"] };
    for (let i = 0; i < 70_000; i++) body[`pkg-${i}`] = ["1.0.0"];
    const res = await h.call("POST", "npm-group/-/npm/v1/security/advisories/bulk", { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    const forwarded = JSON.parse(fake.requests.at(-1)!.body.toString("utf8")) as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("react");
    expect(Object.keys(forwarded)).toHaveLength(70_001);
  });

  it("a bulk audit body that cannot be filtered is refused", async () => {
    const bad = await h.call("POST", "npm-rules/-/npm/v1/security/advisories/bulk", { body: "not json", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    const encoded = await h.call("POST", "npm-group/-/npm/v1/security/advisories/bulk", { body: "x", headers: { "content-encoding": "br" } });
    expect(encoded.status).toBe(415);
  });

  it("a quick audit through a mirror with rules fails instead of leaking names", async () => {
    const before = fake.hits.length;
    for (const repo of ["npm-rules", "npm-allow"]) {
      for (const path of ["audits/quick", "audits"]) {
        const res = await h.call("POST", `${repo}/-/npm/v1/security/${path}`, { body: "{}", headers: { "content-type": "application/json" } });
        expect(res.status).toBe(502);
        expect(await res.json()).toHaveProperty("error");
      }
    }
    expect(fake.hits.length).toBe(before);
  });

  it("a quick audit through a group with hosted members fails instead of leaking names", async () => {
    const before = fake.hits.length;
    for (const path of ["audits/quick", "audits"]) {
      const res = await h.call("POST", `npm-group/-/npm/v1/security/${path}`, { body: "{}", headers: { "content-type": "application/json" } });
      expect(res.status).toBe(502);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.json()).toHaveProperty("error");
    }
    expect(fake.hits.length).toBe(before);
  });

  it("a group without a mirror member and an offline mirror give the hosted answer", async () => {
    for (const repo of ["npm-group-hosted", "npm-offline"]) {
      const res = await h.call("POST", `${repo}/-/npm/v1/security/audits/quick`, { body: "{}", headers: { "content-type": "application/json" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(NO_ADVISORIES_QUICK);
    }
  });

  it("an unreachable mirror is a 502, not a silent all-clear", async () => {
    const res = await h.call("POST", "npm-down/-/npm/v1/security/advisories/bulk", { body: AUDIT_BODY });
    expect(res.status).toBe(502);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});

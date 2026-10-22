import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createAssetService, recordUsage } from "@weaver/core";
import { asset, component, createDb } from "@weaver/db";
import { createNpmHandler } from "./handler.js";
import { createNpmStore, formatRev } from "./store.js";
import { createHarness, type Harness } from "./test/harness.js";
import { digestsOf, makeTarball, publishBody } from "./test/fixtures.js";

const CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

let h: Harness;
let tarball: Buffer;

/** Publishes `name@version` to `repo` as the writer. */
async function publish(name: string, version: string, tgz: Buffer, opts: { repo?: string; tag?: string; readme?: string } = {}) {
  return h.call("PUT", `${opts.repo ?? "npm-hosted"}/${name.replace("/", "%2f")}`, {
    token: h.tokens.writer,
    json: publishBody(name, version, tgz, opts),
  });
}

beforeAll(async () => {
  h = await createHarness();
  await h.createRepo({ name: "npm-hosted", format: "npm", kind: "hosted", visibility: "public" });
  await h.createRepo({ name: "npm-private", format: "npm", kind: "hosted", visibility: "private" });
  await h.createRepo({ name: "npm-mirror", format: "npm", kind: "mirror", upstreams: [{ url: "https://registry.npmjs.org", authType: "none" }] });
  await h.createRepo({ name: "npm-group", format: "npm", kind: "group", members: ["npm-hosted"], visibility: "public" });
  await h.createRepo({ name: "maven-hosted", format: "maven", kind: "hosted" });
  tarball = await makeTarball("@acme/ui", "1.0.0");
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE npm_package, asset, component, usage_event CASCADE`);
});

describe("hosted npm", () => {
  it("publish then install metadata", async () => {
    const res = await publish("@acme/ui", "1.0.0", tarball);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string; rev: string };
    expect(body).toMatchObject({ ok: true, id: "@acme/ui" });
    expect(body.rev).toMatch(/^1-[0-9a-f]{16}$/);

    const meta = await h.call("GET", "npm-hosted/@acme%2fui", { headers: { accept: CORGI } });
    expect(meta.status).toBe(200);
    expect(meta.headers.get("content-type")).toBe("application/vnd.npm.install-v1+json");
    const doc = (await meta.json()) as { versions: Record<string, { dist: { integrity: string } }>; "dist-tags": Record<string, string> };
    expect(doc.versions["1.0.0"]!.dist.integrity).toBe(digestsOf(tarball).integrity);
    expect(doc["dist-tags"]).toEqual({ latest: "1.0.0" });

    const tgz = await h.call("GET", "npm-hosted/@acme/ui/-/ui-1.0.0.tgz");
    expect(tgz.status).toBe(200);
    expect(tgz.headers.get("content-type")).toBe("application/octet-stream");
    expect(tgz.headers.get("content-length")).toBe(String(tarball.length));
    expect(Buffer.from(await tgz.arrayBuffer()).equals(tarball)).toBe(true);
  });

  it("serves the full packument with _rev, readme and time", async () => {
    expect((await publish("@acme/ui", "1.0.0", tarball, { readme: "# ui" })).status).toBe(201);
    const res = await h.call("GET", "npm-hosted/@acme%2fui");
    expect(res.headers.get("content-type")).toBe("application/json");
    const doc = (await res.json()) as Record<string, unknown> & { time: Record<string, string>; _rev: string };
    expect(doc).toMatchObject({ _id: "@acme/ui", name: "@acme/ui", readme: "# ui", description: "the @acme/ui package" });
    expect(doc._rev).toMatch(/^1-[0-9a-f]{16}$/);
    expect(Object.keys(doc.time).sort()).toEqual(["1.0.0", "created", "modified"]);
    expect(doc).not.toHaveProperty("_attachments");
    const head = await h.call("HEAD", "npm-hosted/@acme%2fui");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("tarball urls stay under the serving repo", async () => {
    await publish("@acme/ui", "1.0.0", tarball);
    for (const accept of [CORGI, "application/json"]) {
      const doc = (await (await h.call("GET", "npm-hosted/@acme%2fui", { headers: { accept } })).json()) as {
        versions: Record<string, { dist: { tarball: string } }>;
      };
      expect(doc.versions["1.0.0"]!.dist.tarball).toBe("https://weaver.slne.dev/npm/npm-hosted/@acme/ui/-/ui-1.0.0.tgz");
    }
    const manifest = (await (await h.call("GET", "npm-hosted/@acme%2fui/1.0.0")).json()) as { dist: { tarball: string } };
    expect(manifest.dist.tarball).toBe("https://weaver.slne.dev/npm/npm-hosted/@acme/ui/-/ui-1.0.0.tgz");
  });

  it("scoped name spellings", async () => {
    await publish("@acme/ui", "1.0.0", tarball);
    const ids = [];
    for (const p of ["npm-hosted/@acme%2Fui", "npm-hosted/@acme/ui", "npm-hosted/@acme%2fui"]) {
      const res = await h.call("GET", p);
      expect(res.status, p).toBe(200);
      ids.push(((await res.json()) as { _id: string })._id);
    }
    expect(ids).toEqual(["@acme/ui", "@acme/ui", "@acme/ui"]);
    expect((await h.call("GET", "npm-hosted/@acme%2fui/-/ui-1.0.0.tgz")).status).toBe(200);
  });

  it("republish is refused", async () => {
    expect((await publish("@acme/ui", "1.0.0", tarball)).status).toBe(201);
    const again = await publish("@acme/ui", "1.0.0", tarball);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("previously published");
  });

  it("publishes a second version and keeps tags", async () => {
    await publish("@acme/ui", "1.0.0", tarball);
    const next = await makeTarball("@acme/ui", "1.1.0-beta.1");
    const res = await publish("@acme/ui", "1.1.0-beta.1", next, { tag: "beta" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { rev: string }).rev).toMatch(/^2-/);
    const doc = (await (await h.call("GET", "npm-hosted/@acme%2fui")).json()) as { "dist-tags": Record<string, string> };
    expect(doc["dist-tags"]).toEqual({ latest: "1.0.0", beta: "1.1.0-beta.1" });
  });

  it("refuses to publish over a tombstoned version", async () => {
    await publish("@acme/ui", "1.0.0", tarball);
    await h.db.execute(sql`UPDATE npm_package SET document = jsonb_set(document, '{versions}', '{}'::jsonb)`);
    const res = await publish("@acme/ui", "1.0.0", tarball);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "You cannot publish over the previously published versions: 1.0.0." });
  });

  it("concurrent publish of one version", async () => {
    const a = await makeTarball("@acme/ui", "1.0.0", { description: "a" });
    const b = await makeTarball("@acme/ui", "1.0.0", { description: "b" });
    const [ra, rb] = await Promise.all([publish("@acme/ui", "1.0.0", a), publish("@acme/ui", "1.0.0", b)]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    const winner = ra.status === 201 ? a : b;
    const [row] = await h.db.select().from(asset).where(eq(asset.path, "@acme/ui/-/ui-1.0.0.tgz"));
    expect(row!.sha512).toBe(createHash("sha512").update(winner).digest("hex"));
    const served = await h.call("GET", "npm-hosted/@acme/ui/-/ui-1.0.0.tgz");
    expect(Buffer.from(await served.arrayBuffer()).equals(winner)).toBe(true);
  });

  it("publishes more packages at once than the pool has connections", async () => {
    const small = createDb(h.url, { max: 2, connectionTimeoutMillis: 10_000 });
    try {
      const assets = createAssetService({ db: small, stores: h.deps.stores });
      const handler = createNpmHandler({ ...h.deps, db: small, assets, usage: (input) => recordUsage(small, input) });
      const names = Array.from({ length: 8 }, (_, i) => `pool-${i}`);
      const tarballs = await Promise.all(names.map((n) => makeTarball(n, "1.0.0")));
      const responses = await Promise.all(
        names.map((n, i) =>
          handler(
            new Request(`${h.publicUrl}/npm/npm-hosted/${n}`, {
              method: "PUT",
              headers: { authorization: `Bearer ${h.tokens.writer}`, "content-type": "application/json" },
              body: JSON.stringify(publishBody(n, "1.0.0", tarballs[i]!)),
            }),
            `npm-hosted/${n}`,
          ),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual(names.map(() => 201));
      expect(await h.db.select().from(asset)).toHaveLength(8);
    } finally {
      await small.$client.end();
    }
  }, 60_000);

  it("integrity mismatch is rejected", async () => {
    const body = publishBody("@acme/bad", "1.0.0", tarball) as { versions: Record<string, { dist: { shasum: string } }> };
    body.versions["1.0.0"]!.dist.shasum = "0".repeat(40);
    const res = await h.call("PUT", "npm-hosted/@acme%2fbad", { token: h.tokens.writer, json: body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "integrity mismatch" });
    expect(await h.db.select().from(asset)).toHaveLength(0);
    expect((await h.call("GET", "npm-hosted/@acme%2fbad")).status).toBe(404);
  });

  it("deletes the tarball when the document cannot be saved", async () => {
    await h.db.execute(sql`ALTER TABLE npm_package ADD CONSTRAINT npm_test_fail CHECK (name <> '@acme/fail')`);
    try {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await publish("@acme/fail", "1.0.0", await makeTarball("@acme/fail", "1.0.0"));
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(await h.db.select().from(asset)).toHaveLength(0);
      expect(await h.db.select().from(component)).toHaveLength(0);
    } finally {
      await h.db.execute(sql`ALTER TABLE npm_package DROP CONSTRAINT npm_test_fail`);
    }
  });

  it("a failed publish keeps a component it did not create", async () => {
    const [repo] = await h.db.execute<{ id: string }>(sql`SELECT id FROM repository WHERE name = 'npm-hosted'`).then((r) => r.rows);
    await h.db.insert(component).values({ repositoryId: repo!.id, namespace: "acme", name: "fail", version: "1.0.0", metadata: { kept: true } });
    await h.db.execute(sql`ALTER TABLE npm_package ADD CONSTRAINT npm_test_fail CHECK (name <> '@acme/fail')`);
    try {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await publish("@acme/fail", "1.0.0", await makeTarball("@acme/fail", "1.0.0"));
      spy.mockRestore();
      expect(res.status).toBe(500);
      const rows = await h.db.select().from(component);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata).toEqual({ kept: true });
      expect(await h.db.select().from(asset)).toHaveLength(0);
    } finally {
      await h.db.execute(sql`ALTER TABLE npm_package DROP CONSTRAINT npm_test_fail`);
    }
  });

  it("treats blank digests as absent and only logs a wrong attachment length", async () => {
    const body = publishBody("blank", "1.0.0", tarball) as {
      versions: Record<string, { dist: Record<string, unknown> }>;
      _attachments: Record<string, { length: number }>;
    };
    body.versions["1.0.0"]!.dist = { integrity: "", shasum: "  " };
    body._attachments["blank-1.0.0.tgz"]!.length = 1;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await h.call("PUT", "npm-hosted/blank", { token: h.tokens.writer, json: body });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect(res.status).toBe(201);
    const m = (await (await h.call("GET", "npm-hosted/blank/1.0.0")).json()) as { dist: Record<string, string> };
    expect(m.dist).toMatchObject(digestsOf(tarball));
  });

  it("refuses a version differing only in build metadata", async () => {
    expect((await publish("@acme/ui", "1.0.0+a", tarball)).status).toBe(201);
    const res = await publish("@acme/ui", "1.0.0+b", tarball);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "You cannot publish over the previously published versions: 1.0.0+b." });
    expect((await publish("@acme/ui", "1.0.0", tarball)).status).toBe(409);
    expect((await publish("@acme/ui", "1.0.1", tarball)).status).toBe(201);
  });

  it("validates the publish body", async () => {
    const put = (path: string, json: unknown) => h.call("PUT", path, { token: h.tokens.writer, json });
    expect((await put("npm-hosted/@acme%2fother", publishBody("@acme/ui", "1.0.0", tarball))).status).toBe(400);
    expect((await put("npm-hosted/Bad-Name", publishBody("Bad-Name", "1.0.0", tarball))).status).toBe(400);
    expect((await put("npm-hosted/ok", publishBody("ok", "not-semver", tarball))).status).toBe(400);
    const two = publishBody("ok", "1.0.0", tarball) as { versions: Record<string, unknown> };
    two.versions["2.0.0"] = { ...(two.versions["1.0.0"] as object), version: "2.0.0" };
    expect((await put("npm-hosted/ok", two)).status).toBe(400);
    const res = await h.call("PUT", "npm-hosted/ok", { token: h.tokens.writer, body: "{not json", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(await h.db.select().from(asset)).toHaveLength(0);
  });

  it("fills in missing digests", async () => {
    const body = publishBody("left-pad", "1.0.0", tarball) as { versions: Record<string, { dist: Record<string, unknown> }> };
    body.versions["1.0.0"]!.dist = {};
    expect((await h.call("PUT", "npm-hosted/left-pad", { token: h.tokens.writer, json: body })).status).toBe(201);
    const m = (await (await h.call("GET", "npm-hosted/left-pad/1.0.0")).json()) as { dist: Record<string, string> };
    expect(m.dist).toEqual({ ...digestsOf(tarball), tarball: "https://weaver.slne.dev/npm/npm-hosted/left-pad/-/left-pad-1.0.0.tgz" });
  });

  it("rejects oversized bodies with 413", async () => {
    const res = await h.call("PUT", "npm-hosted/big", {
      token: h.tokens.writer,
      body: "{}",
      headers: { "content-type": "application/json", "content-length": String(257 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
  });

  it("auth", async () => {
    const anon = await h.call("GET", "npm-private/@acme%2fui");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Weaver"');
    expect(await anon.json()).toHaveProperty("error");
    const anonPut = await h.call("PUT", "npm-private/@acme%2fui", { json: publishBody("@acme/ui", "1.0.0", tarball) });
    expect(anonPut.status).toBe(401);
    const readerPut = await h.call("PUT", "npm-hosted/@acme%2fui", { token: h.tokens.reader, json: publishBody("@acme/ui", "1.0.0", tarball) });
    expect(readerPut.status).toBe(403);
    const viewerPut = await h.call("PUT", "npm-hosted/@acme%2fui", { token: h.tokens.viewerWriter, json: publishBody("@acme/ui", "1.0.0", tarball) });
    expect(viewerPut.status).toBe(403);
    const bad = await h.call("GET", "npm-hosted/@acme%2fui", { token: "nope" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toBe('Basic realm="Weaver"');
    expect(await h.db.select().from(asset)).toHaveLength(0);

    expect((await publish("@acme/ui", "1.0.0", tarball, { repo: "npm-private" })).status).toBe(201);
    expect((await h.call("GET", "npm-private/@acme%2fui", { token: h.tokens.reader })).status).toBe(200);
    expect((await h.call("GET", "npm-private/@acme/ui/-/ui-1.0.0.tgz")).status).toBe(401);
    expect((await h.call("GET", "npm-private/@acme/ui/-/ui-1.0.0.tgz", { token: h.tokens.reader })).status).toBe(200);
  });

  it("writes to a group or mirror answer 405", async () => {
    for (const repo of ["npm-group", "npm-mirror"]) {
      const res = await h.call("PUT", `${repo}/@acme%2fui`, { json: publishBody("@acme/ui", "1.0.0", tarball) });
      expect(res.status, repo).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect(await res.json()).toHaveProperty("error");
    }
  });

  it("version route resolves dist-tags", async () => {
    await publish("@acme/ui", "1.0.0", tarball);
    const latest = await h.call("GET", "npm-hosted/@acme%2fui/latest");
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as { version: string }).version).toBe("1.0.0");
    expect((await h.call("GET", "npm-hosted/@acme%2fui/1.0.0")).status).toBe(200);
    const unknown = await h.call("GET", "npm-hosted/@acme%2fui/9.9.9");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "version not found: 9.9.9" });
    expect((await h.call("GET", "npm-hosted/@acme%2fnone/latest")).status).toBe(404);
  });

  it("components and usage", async () => {
    await publish("@acme/ui", "1.0.0", tarball);
    const [c] = await h.db
      .select()
      .from(component)
      .where(and(eq(component.namespace, "acme"), eq(component.name, "ui"), eq(component.version, "1.0.0")));
    expect(c).toBeDefined();
    expect(c!.metadata).toMatchObject({ name: "@acme/ui", version: "1.0.0" });
    const uploads = await h.db.execute(sql`SELECT action, bytes FROM usage_event`);
    expect(uploads.rows).toEqual([{ action: "upload", bytes: String(tarball.length) }]);

    expect((await h.call("HEAD", "npm-hosted/@acme/ui/-/ui-1.0.0.tgz")).status).toBe(200);
    const res = await h.call("GET", "npm-hosted/@acme/ui/-/ui-1.0.0.tgz");
    await res.arrayBuffer();
    const [after] = await h.db.select().from(component).where(eq(component.id, c!.id));
    expect(after!.downloadCount).toBe(1);
  });

  it("missing packages and tarballs are 404", async () => {
    expect((await h.call("GET", "npm-hosted/nothing")).status).toBe(404);
    const res = await h.call("GET", "npm-hosted/nothing/-/nothing-1.0.0.tgz");
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty("error");
  });

  it("unknown repo or non-npm repo is 404", async () => {
    for (const p of ["ghost/left-pad", "maven-hosted/left-pad", "ghost/-/ping"]) {
      const res = await h.call("GET", p);
      expect(res.status, p).toBe(404);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  it("answers ping for every kind", async () => {
    for (const repo of ["npm-hosted", "npm-private", "npm-mirror", "npm-group"]) {
      const res = await h.call("GET", `${repo}/-/ping`);
      expect(res.status, repo).toBe(200);
      expect(await res.json()).toEqual({});
    }
  });
});

describe("npm store", () => {
  it("formats revs from a stable hash", () => {
    const doc = { _id: "a", name: "a", "dist-tags": {}, versions: {}, time: { b: "1", a: "2" } };
    const rev = formatRev(3, doc);
    expect(rev).toMatch(/^3-[0-9a-f]{16}$/);
    expect(formatRev(3, { ...doc, time: { a: "2", b: "1" } })).toBe(rev);
  });

  it("searches names, descriptions and keywords, exact name first", async () => {
    const store = createNpmStore(h.db);
    const [repo] = await h.db.execute<{ id: string }>(sql`SELECT id FROM repository WHERE name = 'npm-hosted'`).then((r) => r.rows);
    const mk = (name: string, description: string, keywords: string[] = []) => ({
      _id: name,
      name,
      description,
      keywords,
      "dist-tags": {},
      versions: {},
      time: {},
    });
    for (const doc of [mk("zeta-ui", "x"), mk("ui", "y"), mk("alpha", "a UI kit"), mk("beta", "z", ["ui"]), mk("other", "o")]) {
      await store.locked(repo!.id, doc.name, (tx) => store.save(tx, repo!.id, doc.name, doc, null));
    }
    const all = await store.search([repo!.id], "ui", 10, 0);
    expect(all.total).toBe(4);
    expect(all.documents.map((d) => d.name)).toEqual(["ui", "alpha", "beta", "zeta-ui"]);
    const page = await store.search([repo!.id], "ui", 2, 1);
    expect(page.total).toBe(4);
    expect(page.documents.map((d) => d.name)).toEqual(["alpha", "beta"]);
    expect((await store.search([], "ui", 10, 0)).total).toBe(0);
  });

  it("rejects a save with a stale rev", async () => {
    const store = createNpmStore(h.db);
    const [repo] = await h.db.execute<{ id: string }>(sql`SELECT id FROM repository WHERE name = 'npm-hosted'`).then((r) => r.rows);
    const doc = { _id: "x", name: "x", "dist-tags": {}, versions: {}, time: {} };
    expect(await store.locked(repo!.id, "x", (tx) => store.save(tx, repo!.id, "x", doc, null))).toBe(1);
    expect(await store.locked(repo!.id, "x", (tx) => store.save(tx, repo!.id, "x", doc, 1))).toBe(2);
    await expect(store.locked(repo!.id, "x", (tx) => store.save(tx, repo!.id, "x", doc, 1))).rejects.toThrow();
    expect((await store.get(repo!.id, "x"))!.rev).toBe(2);
    await store.locked(repo!.id, "x", (tx) => store.remove(tx, repo!.id, "x"));
    expect(await store.get(repo!.id, "x")).toBeNull();
  });
});

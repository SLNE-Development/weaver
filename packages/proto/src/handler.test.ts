import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAssetService,
  createMirrorEngine,
  createRegistry,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  packArchive,
  RegistryError,
  type FormatHandler,
  type KeyPermission,
  type MirrorEngine,
  type Principal,
  type ProtoFile,
  type Repo,
  type RepoService,
  type ServerSettings,
  type ValidationIssue,
} from "@weaver/core";
import { user } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createProtoHandler } from "./handler.js";
import { serveFormatHandler, type HandlerUpstream } from "./testing/upstream.js";

const PUBLIC_URL = "http://weaver.test";

/** Who owns the test principals; inserted as users so publishes can name them. */
const USERS = [
  { id: "u-admin", role: "admin" },
  { id: "u-maintainer", role: "maintainer" },
  { id: "u-viewer", role: "viewer" },
] as const;

const admin: Principal = { kind: "user", userId: "u-admin", role: "admin" };

type Params = { repo: string; group: string; name: string; version: string };

function proto(path: string, body: string, imports: string[] = []): ProtoFile {
  const pkg = path.replace(/\/[^/]+$/, "").replaceAll("/", ".");
  const importLines = imports.map((i) => `import "${i}";`).join("\n");
  return { path, content: `syntax = "proto3";\npackage ${pkg};\n${importLines}\n${body}\n` };
}

const moneyFiles = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; }")];
const orderFiles = [
  proto("acme/order/v1/order.proto", "message Order { acme.money.v1.Money total = 1; }", ["acme/money/v1/money.proto"]),
];

const money: Params = { repo: "releases", group: "acme", name: "money", version: "1.0.0" };
const order: Params = { repo: "releases", group: "acme", name: "order", version: "1.0.0" };

/** The path below `/api/v1/` of a version, plus `suffix` (e.g. "/archive?build=1"). */
function versionPath(p: Params, suffix = ""): string {
  return `repos/${p.repo}/artifacts/${p.group}/${p.name}/${p.version}${suffix}`;
}

async function errorOf(res: Response): Promise<{ code: string; message: string; details?: unknown }> {
  const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
  expect(typeof body.error.message).toBe("string");
  return body.error;
}

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("proto /api/v1 handler", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let repos: RepoService;
  let engine: MirrorEngine;
  let handler: FormatHandler;
  let up: HandlerUpstream;
  let downPort: number;
  /** What the validate stub reports for the next publishes. */
  let issues: ValidationIssue[] = [];
  /** Bearer tokens and the principals they stand for; rebuilt per test from the repository ids. */
  let principals: Record<string, Principal> = {};

  /**
   * Sends `method` `path` (below `/api/v1/`, query included) to the handler as a plain Request,
   * with `token` as bearer credentials.
   */
  function call(method: string, path: string, opts: { token?: string; body?: RequestInit["body"]; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const init: RequestInit & { duplex?: string } = { method, headers, body: opts.body };
    if (opts.body instanceof ReadableStream) init.duplex = "half";
    const req = new Request(`${PUBLIC_URL}/api/v1/${path}`, init);
    return handler(req, path.split("?")[0]!);
  }

  async function publish(
    p: Params,
    opts: { token?: string; files?: ProtoFile[]; dependencies?: string[]; manifest?: object; query?: string } = {},
  ): Promise<Response> {
    const form = new FormData();
    const manifest = opts.manifest ?? { group: p.group, name: p.name, version: p.version, dependencies: opts.dependencies ?? [] };
    form.set("manifest", JSON.stringify(manifest));
    const archive = await packArchive(opts.files ?? moneyFiles);
    form.set("archive", new Blob([new Uint8Array(archive)], { type: "application/gzip" }), "archive.tar.gz");
    return call("PUT", versionPath(p, opts.query ?? ""), { token: opts.token, body: form });
  }

  const resolve = (body: object, token?: string) => call("POST", "resolve", { token, body: JSON.stringify(body) });

  beforeAll(async () => {
    testDb = await startTestDb();
    for (const u of USERS) await testDb.db.insert(user).values({ id: u.id, name: u.id, email: `${u.id}@weaver.test`, role: u.role });
    blobDir = await mkdtemp(join(tmpdir(), "weaver-proto-handler-"));
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    const secretKey = deriveSecretKey("proto-handler-test");
    repos = createRepoService({ db: testDb.db, stores, secretKey });
    const registry = createRegistry({ db: testDb.db, stores, repos, validate: () => Promise.resolve(issues) });
    const assets = createAssetService({ db: testDb.db, stores });
    const settings = (): Promise<ServerSettings> => Promise.resolve({ anonymousView: false, defaultCacheStore: "local" });
    engine = createMirrorEngine({ db: testDb.db, stores, repos, assets, settings });
    handler = createProtoHandler({
      db: testDb.db,
      stores,
      repos,
      assets,
      mirror: engine,
      principal: (req) => {
        const header = req.headers.get("authorization");
        if (header === null) return Promise.resolve({ kind: "anonymous" });
        const found = principals[header.replace(/^Bearer /, "")];
        if (!found) return Promise.reject(new RegistryError("unauthorized", "Invalid API key"));
        return Promise.resolve(found);
      },
      settings,
      publicUrl: PUBLIC_URL,
      secretKey,
      usage: () => Promise.resolve(),
      registry,
    });
    // The same handler on a local port, so mirrors can use it (or themselves) as their upstream.
    up = await serveFormatHandler(handler);
    downPort = await closedPort();
  });

  afterAll(async () => {
    await up?.close();
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    issues = [];
    up.hits = [];
    const releases = await repos.create(admin, {
      name: "releases",
      format: "proto",
      kind: "hosted",
      visibility: "public",
      config: { allowSnapshots: false },
    });
    const priv = await repos.create(admin, { name: "private", format: "proto", kind: "hosted", visibility: "private" });
    const mirrorOf = (name: string, url: string) =>
      repos.create(admin, {
        name,
        format: "proto",
        kind: "mirror",
        visibility: "public",
        upstreams: [{ url, authType: "bearer", secret: "remote-admin" }],
      });
    await mirrorOf("remote-mirror", `${up.origin}/api/v1/repos/releases`);
    await mirrorOf("loop", `${up.origin}/api/v1/repos/loop`);
    await mirrorOf("down", `http://127.0.0.1:${downPort}/api/v1/repos/releases`);
    await repos.create(admin, { name: "all", format: "proto", kind: "group", visibility: "public", members: ["releases"] });

    const grant = (repo: Repo, access: "read" | "write"): KeyPermission => ({ repositoryId: repo.id, repository: repo.name, groupPrefix: null, access });
    const key = (keyId: string, userId: string, role: "admin" | "maintainer" | "viewer", permissions: KeyPermission[]): Principal => ({
      kind: "apikey",
      keyId,
      userId,
      role,
      permissions,
    });
    principals = {
      maintainer: key("k-maintainer", "u-maintainer", "maintainer", [grant(releases, "write"), grant(priv, "write")]),
      reader: key("k-reader", "u-maintainer", "maintainer", [grant(priv, "read")]),
      admin: key("k-admin", "u-admin", "admin", [grant(releases, "write")]),
      viewerOwned: key("k-viewer", "u-viewer", "viewer", [grant(releases, "write")]),
      "remote-admin": admin,
    };
  });

  afterEach(async () => {
    await engine.drain();
    for (const repo of await repos.list()) {
      if (repo.kind === "group") await repos.delete(admin, repo.name);
    }
    for (const repo of await repos.list()) await repos.delete(admin, repo.name);
  });

  describe("PUT publish", () => {
    it("publishes, then lists the version, serves the manifest and the archive", async () => {
      const res = await publish(money, { token: "maintainer" });
      expect(res.status).toBe(201);
      const published = (await res.json()) as { coordinate: string; buildNumber: number; sha256: string; redeployed: boolean };
      expect(published).toEqual({
        coordinate: "acme:money:1.0.0",
        buildNumber: 1,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        redeployed: false,
      });

      const list = await call("GET", "repos/releases/artifacts/acme/money");
      expect(list.status).toBe(200);
      const { versions } = (await list.json()) as { versions: { version: string; isSnapshot: boolean; latestBuild: number; updatedAt: string }[] };
      expect(versions).toEqual([{ version: "1.0.0", isSnapshot: false, latestBuild: 1, updatedAt: expect.any(String) }]);
      expect(new Date(versions[0]!.updatedAt).toISOString()).toBe(versions[0]!.updatedAt);

      const manifest = await call("GET", versionPath(money));
      expect(manifest.status).toBe(200);
      const info = (await manifest.json()) as Record<string, unknown>;
      expect(info).toMatchObject({
        repository: "releases",
        coordinate: "acme:money:1.0.0",
        buildNumber: 1,
        sha256: published.sha256,
        files: ["acme/money/v1/money.proto"],
        dependencies: [],
      });
      expect(new Date(info.createdAt as string).toISOString()).toBe(info.createdAt);

      const archive = await call("GET", versionPath(money, "/archive"));
      expect(archive.status).toBe(200);
      expect(archive.headers.get("content-type")).toBe("application/gzip");
      expect(archive.headers.get("x-weaver-sha256")).toBe(published.sha256);
      expect(archive.headers.get("content-disposition")).toBe('attachment; filename="money-1.0.0.tar.gz"');
      expect(archive.headers.get("cache-control")).toBe("private, no-store");
      const bytes = Buffer.from(await archive.arrayBuffer());
      expect(archive.headers.get("content-length")).toBe(String(bytes.length));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(published.sha256);
    });

    it("answers 422 validation_failed with the validator's issues", async () => {
      issues = [{ path: "acme/money/v1/money.proto", line: 1, column: 1, message: "syntax error" }];
      const res = await publish(money, { token: "maintainer" });
      expect(res.status).toBe(422);
      const error = await errorOf(res);
      expect(error.code).toBe("validation_failed");
      expect(error.details).toMatchObject({ issues });
    });

    it("rejects publishing an existing release as immutable", async () => {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      const again = await publish(money, { token: "maintainer" });
      expect(again.status).toBe(409);
      expect((await errorOf(again)).code).toBe("immutable");
    });

    it("requires a token (401) with write access (403) on a private repository", async () => {
      const target = { ...money, repo: "private" };
      const anonymous = await publish(target);
      expect(anonymous.status).toBe(401);
      expect((await errorOf(anonymous)).code).toBe("unauthorized");

      const readOnly = await publish(target, { token: "reader" });
      expect(readOnly.status).toBe(403);
      expect((await errorOf(readOnly)).code).toBe("forbidden");
    });

    it("rejects an invalid token with 401", async () => {
      const res = await publish(money, { token: "not-a-key" });
      expect(res.status).toBe(401);
      expect((await errorOf(res)).code).toBe("unauthorized");
    });

    it("rejects a manifest that does not match the URL with 400", async () => {
      const res = await publish(money, {
        token: "maintainer",
        manifest: { group: "acme", name: "money", version: "2.0.0", dependencies: [] },
      });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_request");
    });

    it("rejects a request without the multipart fields with 400", async () => {
      const form = new FormData();
      form.set("manifest", "{not json");
      const res = await call("PUT", versionPath(money), { token: "maintainer", body: form });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_request");
    });

    it("rejects an oversized Content-Length with 413 before reading the body", async () => {
      const res = await call("PUT", versionPath(money), {
        token: "maintainer",
        headers: { "content-length": String(10 * 1024 * 1024 + 64 * 1024 + 1) },
        body: "x",
      });
      expect(res.status).toBe(413);
      expect((await errorOf(res)).code).toBe("payload_too_large");
    });

    it("rejects a body larger than the limit with 413 even without Content-Length", async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ < 12) controller.enqueue(chunk);
          else controller.close();
        },
      });
      const res = await call("PUT", versionPath(money), {
        token: "maintainer",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body,
      });
      expect(res.status).toBe(413);
      expect((await errorOf(res)).code).toBe("payload_too_large");
    });

    it("PUT to a group answers 405 method_not_allowed, and so does DELETE on a mirror", async () => {
      const put = await publish({ ...money, repo: "all" }, { token: "remote-admin" });
      expect(put.status).toBe(405);
      expect((await errorOf(put)).code).toBe("method_not_allowed");
      const del = await call("DELETE", versionPath({ ...money, repo: "remote-mirror" }), { token: "remote-admin" });
      expect(del.status).toBe(405);
      expect((await errorOf(del)).code).toBe("method_not_allowed");
    });
  });

  describe("POST resolve", () => {
    it("returns the transitive artifacts with absolute archive URLs", async () => {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      expect((await publish(order, { token: "maintainer", files: orderFiles, dependencies: ["acme:money:1.0.0"] })).status).toBe(201);

      const res = await resolve({ repositories: ["releases"], dependencies: ["acme:order:1.0.0"] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { artifacts: Record<string, unknown>[]; conflicts: unknown[] };
      expect(body.conflicts).toEqual([]);
      expect(body.artifacts).toEqual([
        {
          repository: "releases",
          coordinate: "acme:money:1.0.0",
          group: "acme",
          name: "money",
          version: "1.0.0",
          buildNumber: 1,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          archiveUrl: `${PUBLIC_URL}/api/v1/repos/releases/artifacts/acme/money/1.0.0/archive?build=1`,
        },
        {
          repository: "releases",
          coordinate: "acme:order:1.0.0",
          group: "acme",
          name: "order",
          version: "1.0.0",
          buildNumber: 1,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          archiveUrl: `${PUBLIC_URL}/api/v1/repos/releases/artifacts/acme/order/1.0.0/archive?build=1`,
        },
      ]);
    });

    it("resolve archiveUrl uses the addressed repository and public url", async () => {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      const res = await resolve({ repositories: ["all"], dependencies: ["acme:money:1.0.0"] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { artifacts: { repository: string; archiveUrl: string }[] };
      expect(body.artifacts).toEqual([
        expect.objectContaining({
          repository: "all",
          archiveUrl: "http://weaver.test/api/v1/repos/all/artifacts/acme/money/1.0.0/archive?build=1",
        }),
      ]);
    });

    it("leaves excluded group:name keys and their subtrees out of the resolution", async () => {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      expect((await publish(order, { token: "maintainer", files: orderFiles, dependencies: ["acme:money:1.0.0"] })).status).toBe(201);

      const withoutMoney = await resolve({ repositories: ["releases"], dependencies: ["acme:order:1.0.0"], exclude: ["acme:money"] });
      expect(withoutMoney.status).toBe(200);
      const body = (await withoutMoney.json()) as { artifacts: { coordinate: string }[]; conflicts: unknown[] };
      expect(body.artifacts.map((a) => a.coordinate)).toEqual(["acme:order:1.0.0"]);

      const withoutOrder = await resolve({
        repositories: ["releases"],
        dependencies: ["acme:order:1.0.0", "acme:local:9.9.9"],
        exclude: ["acme:order", "acme:local"],
      });
      expect(withoutOrder.status).toBe(200);
      expect(((await withoutOrder.json()) as { artifacts: unknown[] }).artifacts).toEqual([]);

      const invalid = await resolve({ repositories: ["releases"], dependencies: [], exclude: ["acme:money:1.0.0"] });
      expect(invalid.status).toBe(400);
      expect((await errorOf(invalid)).code).toBe("invalid_request");
    });

    it("rejects a malformed body with 400", async () => {
      const res = await resolve({ repositories: ["releases"], dependencies: ["not-a-coordinate"] });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_request");
      const notJson = await call("POST", "resolve", { body: "{" });
      expect(notJson.status).toBe(400);
      expect((await errorOf(notJson)).code).toBe("invalid_request");
    });

    it("rejects a body over 1 MiB with 413", async () => {
      const res = await call("POST", "resolve", { body: JSON.stringify({ repositories: [], dependencies: [], pad: "x".repeat(1024 * 1024) }) });
      expect(res.status).toBe(413);
      expect((await errorOf(res)).code).toBe("payload_too_large");
    });

    it("reports a missing dependency as 404", async () => {
      const res = await resolve({ repositories: ["releases"], dependencies: ["acme:missing:1.0.0"] });
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe("not_found");
    });

    it("hides artifacts of a private repository from callers that can't read it, like missing ones", async () => {
      expect((await publish({ ...money, repo: "private" }, { token: "maintainer" })).status).toBe(201);
      const resolveAs = (token: string | undefined, dependency: string) =>
        resolve({ repositories: ["private"], dependencies: [dependency] }, token);

      const hidden = await resolveAs(undefined, "acme:money:1.0.0");
      expect(hidden.status).toBe(404);
      const hiddenError = await errorOf(hidden);
      expect(hiddenError.code).toBe("not_found");
      const missing = await resolveAs(undefined, "acme:absent:1.0.0");
      expect(missing.status).toBe(404);
      expect(hiddenError.message.replace("money", "X")).toBe((await errorOf(missing)).message.replace("absent", "X"));

      const readable = await resolveAs("reader", "acme:money:1.0.0");
      expect(readable.status).toBe(200);
      const body = (await readable.json()) as { artifacts: { repository: string; coordinate: string }[] };
      expect(body.artifacts).toEqual([expect.objectContaining({ repository: "private", coordinate: "acme:money:1.0.0" })]);
    });
  });

  describe("DELETE", () => {
    async function publishBoth() {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      expect((await publish(order, { token: "maintainer", files: orderFiles, dependencies: ["acme:money:1.0.0"] })).status).toBe(201);
    }

    const del = (p: Params, token?: string, query = "") => call("DELETE", versionPath(p, query), { token });

    it("refuses with 409 has_dependents, and lets an admin force it", async () => {
      await publishBoth();
      const blocked = await del(money, "maintainer");
      expect(blocked.status).toBe(409);
      const error = await errorOf(blocked);
      expect(error.code).toBe("has_dependents");
      expect(error.details).toEqual({
        dependents: [{ repository: "releases", coordinate: { group: "acme", name: "order", version: "1.0.0" } }],
        hiddenDependents: 0,
      });

      expect((await del(money, "maintainer", "?force=true")).status).toBe(403);

      const forced = await del(money, "admin", "?force=true");
      expect(forced.status).toBe(204);
      expect(await forced.text()).toBe("");
      expect((await call("GET", versionPath(money))).status).toBe(404);
    });

    it("deletes a version without dependents with 204", async () => {
      await publishBoth();
      expect((await del(order, "maintainer")).status).toBe(204);
    });

    it("requires authentication (401) and the delete permission (403)", async () => {
      await publishBoth();
      expect((await del(order)).status).toBe(401);
      expect((await del(order, "viewerOwned")).status).toBe(403);
    });
  });

  describe("GET manifest and HEAD archive", () => {
    async function downloadCount(p: Params): Promise<number> {
      const res = await call("GET", versionPath(p));
      return ((await res.json()) as { downloadCount: number }).downloadCount;
    }

    it("lists dependencies as group:name:version strings, like the coordinate", async () => {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      expect((await publish(order, { token: "maintainer", files: orderFiles, dependencies: ["acme:money:1.0.0"] })).status).toBe(201);
      const res = await call("GET", versionPath(order));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ coordinate: "acme:order:1.0.0", dependencies: ["acme:money:1.0.0"] });
    });

    it("does not count reading the manifest as a download", async () => {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      await downloadCount(money);
      expect(await downloadCount(money)).toBe(0);
    });

    it("answers HEAD on the archive with its headers only, without counting a download", async () => {
      const published = (await (await publish(money, { token: "maintainer" })).json()) as { sha256: string };
      const get = await call("GET", versionPath(money, "/archive"));
      const size = (await get.arrayBuffer()).byteLength;
      expect(await downloadCount(money)).toBe(1);

      const head = await call("HEAD", versionPath(money, "/archive"));
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("application/gzip");
      expect(head.headers.get("content-length")).toBe(String(size));
      expect(head.headers.get("x-weaver-sha256")).toBe(published.sha256);
      expect(head.headers.get("content-disposition")).toBe('attachment; filename="money-1.0.0.tar.gz"');
      expect(await head.text()).toBe("");
      expect(await downloadCount(money)).toBe(1);
    });

    it("serves the build named by ?build= on the archive and the manifest, 404 once it is gone, 400 when malformed", async () => {
      const snap: Params = { repo: "private", group: "acme", name: "money", version: "1.0.0-SNAPSHOT" };
      const first = (await (await publish(snap, { token: "maintainer" })).json()) as { sha256: string };
      const changed = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; string currency = 2; }")];
      const second = (await (await publish(snap, { token: "maintainer", files: changed })).json()) as { sha256: string };

      const get = (query: string) => call("GET", versionPath(snap, `/archive${query}`), { token: "maintainer" });
      expect((await get("")).headers.get("x-weaver-sha256")).toBe(second.sha256);
      expect((await get("?build=1")).headers.get("x-weaver-sha256")).toBe(first.sha256);
      expect((await get("?build=2")).headers.get("x-weaver-sha256")).toBe(second.sha256);
      const head = await call("HEAD", versionPath(snap, "/archive?build=1"), { token: "maintainer" });
      expect(head.headers.get("x-weaver-sha256")).toBe(first.sha256);

      const manifest = (query: string) => call("GET", versionPath(snap, query), { token: "maintainer" });
      expect(await (await manifest("")).json()).toMatchObject({ buildNumber: 2, sha256: second.sha256 });
      expect(await (await manifest("?build=1")).json()).toMatchObject({ buildNumber: 1, sha256: first.sha256 });
      expect((await manifest("?build=3")).status).toBe(404);

      const gone = await get("?build=3");
      expect(gone.status).toBe(404);
      expect((await errorOf(gone)).code).toBe("not_found");
      for (const bad of ["?build=abc", "?build=0", "?build=-1", "?build=1.5"]) {
        const res = await get(bad);
        expect(res.status, bad).toBe(400);
        expect((await errorOf(res)).code).toBe("invalid_request");
        expect((await manifest(bad)).status, bad).toBe(400);
      }
    });

    it("answers HEAD with 404 for a version the caller can't read", async () => {
      const hidden = { ...money, repo: "private" };
      expect((await publish(hidden, { token: "maintainer" })).status).toBe(201);
      expect((await call("HEAD", versionPath(hidden, "/archive"))).status).toBe(404);
    });
  });

  describe("unknown repository", () => {
    const ghost: Params = { repo: "ghost", group: "acme", name: "money", version: "1.0.0" };

    it("answers 404 not_found on every route", async () => {
      const list = await call("GET", "repos/ghost/artifacts/acme/money");
      expect(list.status).toBe(404);
      expect((await errorOf(list)).code).toBe("not_found");
      expect((await call("GET", versionPath(ghost))).status).toBe(404);
      expect((await call("GET", versionPath(ghost, "/archive"))).status).toBe(404);
      expect((await publish(ghost, { token: "maintainer" })).status).toBe(404);
    });

    it("does not disclose a private repository to anonymous readers", async () => {
      const hidden = { ...money, repo: "private" };
      expect((await publish(hidden, { token: "maintainer" })).status).toBe(201);
      expect((await call("GET", versionPath(hidden))).status).toBe(404);
      expect((await call("GET", versionPath(hidden), { token: "reader" })).status).toBe(200);
    });
  });

  describe("mirrors", () => {
    it("archive through a mirror streams upstream bytes with x-weaver-sha256", async () => {
      const published = (await (await publish(money, { token: "maintainer" })).json()) as { sha256: string };
      const res = await call("GET", versionPath({ ...money, repo: "remote-mirror" }, "/archive"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="money-1.0.0.tar.gz"');
      const sha = res.headers.get("x-weaver-sha256");
      expect(sha).toBe(published.sha256);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
      // The mirror asked this same handler, with the remote instance's token and one more hop.
      const hit = up.hits.find((h) => h.url === "/api/v1/repos/releases/artifacts/acme/money/1.0.0/archive");
      expect(hit?.headers.authorization).toBe("Bearer remote-admin");
      expect(hit?.headers["x-weaver-hops"]).toBe("1");
    });

    it("manifest through a mirror names the mirror and honours ?build=", async () => {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      const res = await call("GET", versionPath({ ...money, repo: "remote-mirror" }, "?build=1"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ repository: "remote-mirror", coordinate: "acme:money:1.0.0", buildNumber: 1 });
      expect(up.hits.map((h) => h.url)).toContain("/api/v1/repos/releases/artifacts/acme/money/1.0.0?build=1");
    });

    it("mirror loop stops at the hop limit", async () => {
      const started = Date.now();
      const res = await call("GET", "repos/loop/artifacts/acme/money");
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe("not_found");
      expect(Date.now() - started).toBeLessThan(5000);
      // The handler itself was asked with hops 1 to 5, and refused the last one.
      expect(up.hits.map((h) => h.headers["x-weaver-hops"])).toEqual(["1", "2", "3", "4", "5"]);

      const looped = await call("GET", "repos/releases/artifacts/acme/money", { headers: { "x-weaver-hops": "5" } });
      expect(looped.status).toBe(404);
      expect(await errorOf(looped)).toEqual({ code: "not_found", message: "Mirror loop detected" });
      const atLimit = await call("POST", "resolve", { headers: { "x-weaver-hops": "4" }, body: JSON.stringify({ repositories: [], dependencies: [] }) });
      expect(atLimit.status).toBe(200);
    });

    it("upstream_unavailable maps to 502", async () => {
      const res = await call("GET", "repos/down/artifacts/acme/money");
      expect(res.status).toBe(502);
      expect((await errorOf(res)).code).toBe("upstream_unavailable");
      const archive = await call("GET", versionPath({ ...money, repo: "down" }, "/archive"));
      expect(archive.status).toBe(502);
    });
  });

  describe("routing", () => {
    it("unknown path is 404 and wrong method on a known path is 405 with allow", async () => {
      for (const path of ["", "repos", "repos/releases", "repos/releases/artifacts/acme", "repos/r/artifacts/g/n/v/archive/x", "other", "repos/r/files/g/n"]) {
        const res = await call("GET", path);
        expect(res.status, path).toBe(404);
        expect((await errorOf(res)).code, path).toBe("not_found");
      }
      const cases: Array<[string, string, string]> = [
        ["POST", "repos/r/artifacts/g/n", "GET"],
        ["PUT", "repos/r/artifacts/g/n", "GET"],
        ["POST", "repos/r/artifacts/g/n/1.0.0", "GET, PUT, DELETE"],
        ["HEAD", "repos/r/artifacts/g/n/1.0.0", "GET, PUT, DELETE"],
        ["PUT", "repos/r/artifacts/g/n/1.0.0/archive", "GET, HEAD"],
        ["GET", "resolve", "POST"],
      ];
      for (const [method, path, allow] of cases) {
        const res = await call(method, path);
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get("allow"), `${method} ${path}`).toBe(allow);
        if (method !== "HEAD") expect((await errorOf(res)).code).toBe("method_not_allowed");
      }
    });

    it("decodes percent-encoded segments and rejects malformed ones with 400", async () => {
      expect((await publish(money, { token: "maintainer" })).status).toBe(201);
      expect((await call("GET", "repos/rel%65ases/artifacts/acme/money")).status).toBe(200);
      const bad = await call("GET", "repos/releases/artifacts/ac%2Fme/money");
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).code).toBe("invalid_request");
      expect((await call("GET", "repos/releases/artifacts/acme/%E0%A4%A")).status).toBe(400);
    });
  });
});

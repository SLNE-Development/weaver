import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssetService,
  createMirrorEngine,
  createRegistry,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  packArchive,
  RegistryError,
  type Coordinate,
  type KeyPermission,
  type MirrorEngine,
  type Principal,
  type Registry,
  type Repo,
  type RepoService,
  type ServerSettings,
  type UsageInput,
} from "@weaver/core";
import { protoArtifact, protoBuild, protoVersion, user } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createMirrorSource } from "./mirror-source.js";
import { createProtoService, type ProtoService } from "./service.js";
import { createProtoHandler } from "./handler.js";
import { serveFormatHandler, type HandlerUpstream } from "./testing/upstream.js";

const admin: Principal = { kind: "user", userId: "proto-admin", role: "admin" };
const reader: Principal = { kind: "user", userId: "proto-reader", role: "viewer" };

const coord = (name: string, version: string, group = "acme"): Coordinate => ({ group, name, version });
const money = coord("money", "1.0.0");
const readOn = (r: Repo, groupPrefix: string | null = null): KeyPermission => ({
  repositoryId: r.id,
  repository: r.name,
  groupPrefix,
  access: "read",
});
const keyWith = (...permissions: KeyPermission[]): Principal => ({
  kind: "apikey",
  keyId: "key-reader",
  userId: "proto-reader",
  role: "viewer",
  permissions,
});

/** Settles `promise` and returns its RegistryError, failing when it resolves or throws something else. */
async function registryError(promise: Promise<unknown>): Promise<RegistryError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RegistryError);
  return error as RegistryError;
}

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer());
}

describe("proto service", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let repos: RepoService;
  let registry: Registry;
  let engine: MirrorEngine;
  let service: ProtoService;
  let up: HandlerUpstream;
  let downPort: number;
  const usage = vi.fn<(input: UsageInput) => Promise<void>>(() => Promise.resolve());

  let rel: Repo;
  let snap: Repo;
  let remote: Repo;
  let all: Repo;

  /** Publishes `c` with `dependencies` to the hosted repo `repo`; every publish of a snapshot is a new build. */
  async function publish(repo: Repo, c: Coordinate, dependencies: string[] = []) {
    const writer: Principal = {
      kind: "apikey",
      keyId: `key-write-${repo.name}`,
      userId: admin.kind === "user" ? admin.userId : "",
      role: "admin",
      permissions: [{ repositoryId: repo.id, repository: repo.name, groupPrefix: null, access: "write" }],
    };
    return registry.publish(writer, {
      repository: repo.name,
      manifest: { ...c, dependencies },
      archive: await packArchive([
        { path: `${c.group}/${c.name}/v1/${c.name}.proto`, content: `syntax = "proto3";\n// ${c.version} ${Math.random()}\n` },
      ]),
    });
  }

  /** Creates a proto mirror of the hosted repo `remote` behind the test upstream, or of a closed port. */
  function mirror(name: string, opts: { down?: boolean; cache?: boolean } = {}): Promise<Repo> {
    const origin = opts.down ? `http://127.0.0.1:${downPort}` : up.origin;
    return repos.create(admin, {
      name,
      format: "proto",
      kind: "mirror",
      config: opts.cache ? { cache: { enabled: true } } : {},
      upstreams: [{ url: `${origin}/api/v1/repos/remote`, authType: "none" }],
    });
  }

  function group(name: string, members: string[]): Promise<Repo> {
    return repos.create(admin, { name, format: "proto", kind: "group", members });
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    for (const u of [admin, reader]) {
      if (u.kind !== "user") continue;
      await testDb.db.insert(user).values({ id: u.userId, name: u.userId, email: `${u.userId}@weaver.test`, role: u.role });
    }
    blobDir = await mkdtemp(join(tmpdir(), "weaver-proto-service-"));
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    const secretKey = deriveSecretKey("proto-service-test");
    repos = createRepoService({ db: testDb.db, stores, secretKey });
    registry = createRegistry({ db: testDb.db, stores, repos, validate: () => Promise.resolve([]) });
    const settings = (): Promise<ServerSettings> => Promise.resolve({ anonymousView: false, defaultCacheStore: "local" });
    const assets = createAssetService({ db: testDb.db, stores });
    engine = createMirrorEngine({ db: testDb.db, stores, repos, assets, settings });
    const mirrorSource = createMirrorSource({ mirror: engine });
    service = createProtoService({ registry, repos, mirrorSource, usage });
    // The remote Weaver instance: the real /api/v1 handler over the same database, serving hosted
    // repo `remote` to the mirrors as admin.
    up = await serveFormatHandler(
      createProtoHandler({
        db: testDb.db,
        stores,
        repos,
        assets,
        mirror: engine,
        principal: () => Promise.resolve(admin),
        settings,
        publicUrl: "http://remote.test",
        secretKey,
        usage: () => Promise.resolve(),
        registry,
      }),
    );
    downPort = await closedPort();
  });

  afterAll(async () => {
    await up?.close();
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    usage.mockClear();
    rel = await repos.create(admin, { name: "rel", format: "proto", kind: "hosted" });
    snap = await repos.create(admin, { name: "snap", format: "proto", kind: "hosted", config: { resolutionPriority: 1 } });
    remote = await repos.create(admin, { name: "remote", format: "proto", kind: "hosted" });
    await mirror("up-mirror");
    all = await group("all", ["rel", "up-mirror"]);
  });

  afterEach(async () => {
    await engine.drain();
    for (const repo of await repos.list()) {
      if (repo.kind === "group") await repos.delete(admin, repo.name);
    }
    for (const repo of await repos.list()) await repos.delete(admin, repo.name);
  });

  it("resolve follows the client's repository order", async () => {
    await publish(rel, money);
    await publish(remote, money);
    const first = await service.resolve(reader, ["up-mirror", "rel"], [money], {}, 0);
    expect(first.nodes.map((n) => n.repository)).toEqual(["up-mirror"]);
    const reversed = await service.resolve(reader, ["rel", "up-mirror"], [money], {}, 0);
    expect(reversed.nodes.map((n) => n.repository)).toEqual(["rel"]);
  });

  it("resolve does not search repos outside the list", async () => {
    await publish(snap, money);
    const error = await registryError(service.resolve(reader, ["rel"], [money], {}, 0));
    expect(error.code).toBe("not_found");
    expect(error.details).toMatchObject({ path: ["acme:money:1.0.0"] });
  });

  it("resolve through a group names the group", async () => {
    const published = await publish(rel, money);
    const { nodes } = await service.resolve(reader, ["all"], [money], {}, 0);
    expect(nodes).toEqual([
      { coordinate: money, repository: "all", buildNumber: published.buildNumber, sha256: published.sha256, dependencies: [] },
    ]);
  });

  it("highest version wins across mixed entries", async () => {
    await publish(rel, money);
    await publish(rel, coord("order", "1.0.0"), ["acme:money:1.0.0"]);
    await publish(remote, coord("money", "1.1.0"));
    await publish(remote, coord("invoice", "1.0.0"), ["acme:money:1.1.0"]);

    const result = await service.resolve(reader, ["rel", "up-mirror"], [coord("order", "1.0.0"), coord("invoice", "1.0.0")], {}, 0);
    expect(result.nodes.map((n) => [`${n.coordinate.name}:${n.coordinate.version}`, n.repository])).toEqual([
      ["invoice:1.0.0", "up-mirror"],
      ["money:1.1.0", "up-mirror"],
      ["order:1.0.0", "rel"],
    ]);
    expect(result.conflicts).toEqual([{ group: "acme", name: "money", requested: ["1.0.0", "1.1.0"], selected: "1.1.0" }]);
  });

  it("group read grants private members", async () => {
    await publish(rel, money);
    const p = keyWith(readOn(all));
    const info = await service.getManifest(p, "all", money, {}, 0);
    expect(info).toMatchObject({ repository: "all", coordinate: money, buildNumber: 1 });
    expect((await registryError(service.getManifest(p, "rel", money, {}, 0))).code).toBe("not_found");
  });

  it("a group-prefix entry on a group grants only the groups it covers", async () => {
    await publish(rel, money);
    await publish(rel, coord("money", "1.0.0", "other"));
    const p = keyWith(readOn(all, "acme"));
    expect((await service.getManifest(p, "all", money, {}, 0)).repository).toBe("all");
    expect((await service.resolve(p, ["all"], [money], {}, 0)).nodes[0]?.repository).toBe("all");
    expect((await registryError(service.getManifest(p, "all", coord("money", "1.0.0", "other"), {}, 0))).code).toBe("not_found");
    expect((await registryError(service.resolve(p, ["all"], [coord("money", "1.0.0", "other")], {}, 0))).code).toBe("not_found");
  });

  it("non-proto and unreadable entries are skipped", async () => {
    await repos.create(admin, { name: "npm-hosted", format: "npm", kind: "hosted", visibility: "public" });
    const other = await repos.create(admin, { name: "private-other", format: "proto", kind: "hosted" });
    await publish(other, money);
    await publish(rel, money);
    const p = keyWith(readOn(rel));
    const { nodes } = await service.resolve(p, ["npm-hosted", "private-other", "rel"], [money], {}, 0);
    expect(nodes.map((n) => n.repository)).toEqual(["rel"]);
    expect((await registryError(service.resolve(p, ["npm-hosted"], [money], {}, 0))).code).toBe("not_found");
    expect((await registryError(service.getManifest(p, "npm-hosted", money, {}, 0))).code).toBe("not_found");
  });

  it("group lists the union of member versions newest first", async () => {
    await publish(remote, money);
    await publish(remote, coord("money", "1.1.0"));
    await publish(rel, money);
    const relVersions = await registry.hosted.versions(rel, "acme", "money");
    const remoteVersions = await registry.hosted.versions(remote, "acme", "money");

    const versions = await service.listVersions(reader, "all", "acme", "money", 0);
    expect(versions.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(versions[1]).toEqual(relVersions[0]);
    expect(versions[1]!.updatedAt).not.toEqual(remoteVersions.find((v) => v.version === "1.0.0")!.updatedAt);
  });

  it("group snapshot comes from the first member that has it", async () => {
    const x = coord("x", "1.0.0-SNAPSHOT");
    for (let i = 0; i < 2; i++) await publish(rel, x);
    for (let i = 0; i < 5; i++) await publish(remote, x);
    expect((await service.getManifest(reader, "all", x, {}, 0)).buildNumber).toBe(2);
    expect((await service.resolve(reader, ["all"], [x], {}, 0)).nodes[0]?.buildNumber).toBe(2);
    expect((await service.getManifest(reader, "up-mirror", x, {}, 0)).buildNumber).toBe(5);
  });

  it("group skips a failing mirror member", async () => {
    await publish(rel, money);
    await mirror("up-mirror-down", { down: true });
    await group("down-first", ["up-mirror-down", "rel"]);
    const { nodes } = await service.resolve(reader, ["down-first"], [money], {}, 0);
    expect(nodes.map((n) => n.repository)).toEqual(["down-first"]);
    expect((await service.getManifest(reader, "down-first", money, {}, 0)).repository).toBe("down-first");
    expect((await service.listVersions(reader, "down-first", "acme", "money", 0)).map((v) => v.version)).toEqual(["1.0.0"]);
  });

  it("group reports upstream_unavailable when nothing else has it", async () => {
    await publish(rel, money);
    await mirror("up-mirror-down", { down: true });
    await group("down-only", ["up-mirror-down"]);
    expect((await registryError(service.resolve(reader, ["down-only"], [money], {}, 0))).code).toBe("upstream_unavailable");
    expect((await registryError(service.getManifest(reader, "down-only", money, {}, 0))).code).toBe("upstream_unavailable");
    expect((await registryError(service.listVersions(reader, "down-only", "acme", "money", 0))).code).toBe("upstream_unavailable");
    expect((await registryError(service.archive(reader, "down-only", money, {}, "GET", 0))).code).toBe("upstream_unavailable");
    // A group member that answers not_found does not hide the failure, and a later entry still wins.
    await group("down-then-empty", ["up-mirror-down", "snap"]);
    expect((await registryError(service.getManifest(reader, "down-then-empty", money, {}, 0))).code).toBe("upstream_unavailable");
    expect((await service.resolve(reader, ["down-only", "rel"], [money], {}, 0)).nodes[0]?.repository).toBe("rel");
  });

  it("a superseded version only behind a down mirror does not fail the resolution", async () => {
    // order -> money:1.0.0 and invoice; invoice -> money:1.1.0, so money:1.0.0 is looked up, then superseded.
    await publish(rel, money);
    await publish(rel, coord("money", "1.1.0"));
    await publish(rel, coord("invoice", "1.0.0"), ["acme:money:1.1.0"]);
    await publish(rel, coord("order", "1.0.0"), ["acme:money:1.0.0", "acme:invoice:1.0.0"]);
    await registry.deleteVersion(admin, "rel", money, { force: true });
    await mirror("up-mirror-down", { down: true });

    const { nodes } = await service.resolve(reader, ["up-mirror-down", "rel"], [coord("order", "1.0.0")], {}, 0);
    expect(nodes.map((n) => `${n.coordinate.name}:${n.coordinate.version}`)).toEqual(["invoice:1.0.0", "money:1.1.0", "order:1.0.0"]);

    // A coordinate that stays live and only the down mirror could have had is upstream_unavailable, not not_found.
    const error = await registryError(service.resolve(reader, ["up-mirror-down", "rel"], [coord("absent", "1.0.0")], {}, 0));
    expect(error.code).toBe("upstream_unavailable");
    expect((await registryError(service.resolve(reader, ["rel"], [coord("absent", "1.0.0")], {}, 0))).code).toBe("not_found");
  });

  describe("pinned mirror snapshot build gone upstream", () => {
    const x = coord("x", "1.0.0-SNAPSHOT");

    /** Deletes build `buildNumber` of `x` from the hosted repo `remote`, as an upstream cleanup would. */
    async function deleteRemoteBuild(buildNumber: number) {
      const [row] = await testDb.db
        .select({ id: protoBuild.id })
        .from(protoBuild)
        .innerJoin(protoVersion, eq(protoVersion.id, protoBuild.versionId))
        .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
        .where(and(eq(protoArtifact.repositoryId, remote.id), eq(protoVersion.version, x.version), eq(protoBuild.buildNumber, buildNumber)));
      await testDb.db.delete(protoBuild).where(eq(protoBuild.id, row!.id));
    }

    it("is not_found", async () => {
      await publish(remote, x);
      await publish(remote, x);
      await deleteRemoteBuild(1);
      const error = await registryError(service.archive(reader, "up-mirror", x, { buildNumber: 1 }, "GET", 0));
      expect(error.code).toBe("not_found");
      expect(error.message).toBe("Build 1 of acme:x:1.0.0-SNAPSHOT was not found");
    });

    it("is served from the cache after a prior download", async () => {
      await publish(remote, x);
      await publish(remote, x);
      await mirror("up-cached", { cache: true });
      const first = await service.archive(reader, "up-cached", x, { buildNumber: 1 }, "GET", 0);
      const bytes = await readAll(first.body);
      await engine.drain();
      await deleteRemoteBuild(1);

      const again = await service.archive(reader, "up-cached", x, { buildNumber: 1 }, "GET", 0);
      expect(["stale", "hit"]).toContain(again.cache);
      expect(await readAll(again.body)).toEqual(bytes);
    });
  });

  it("archive download records usage once with the addressed repo id", async () => {
    const published = await publish(rel, money);
    const got = await service.archive(reader, "all", money, {}, "GET", 0);
    const bytes = await readAll(got.body);
    expect(got).toMatchObject({ size: bytes.length, sha256: published.sha256, filename: "money-1.0.0.tar.gz", cache: null });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage.mock.calls[0]![0]).toMatchObject({
      repositoryId: all.id,
      path: "acme/money/1.0.0",
      action: "download",
      bytes: bytes.length,
      principal: reader,
      // The hosted member's component, so the download counts on the package.
      componentId: expect.any(String),
    });

    usage.mockClear();
    const head = await service.archive(reader, "all", money, {}, "HEAD", 0);
    expect(head).toMatchObject({ body: null, size: bytes.length, sha256: published.sha256 });
    expect(usage).not.toHaveBeenCalled();
  });

  it("mirror archive download reports the mirror's cache result", async () => {
    const published = await publish(remote, money);
    const got = await service.archive(reader, "up-mirror", money, {}, "GET", 0);
    await readAll(got.body);
    expect(got).toMatchObject({ sha256: published.sha256, cache: "bypass", filename: "money-1.0.0.tar.gz" });
    expect(usage.mock.calls[0]![0]).toMatchObject({ repositoryId: (await repos.get("up-mirror"))!.id, cache: "bypass" });
  });
});

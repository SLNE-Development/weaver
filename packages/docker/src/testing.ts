import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RegistryError,
  createAssetService,
  createMirrorEngine,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  extractToken,
  type Access,
  type CreateRepoInput,
  type FormatDeps,
  type FormatHandler,
  type KeyPermission,
  type Principal,
  type Repo,
  type Role,
  type ServerSettings,
  type UsageInput,
} from "@weaver/core";
import { startTestDb } from "@weaver/db/testing";
import { createDockerHandlerWith, type DockerOptions } from "./handler.js";

/** A running registry over a throwaway database and local store, for tests only. */
export interface DockerTestRegistry {
  /** The wired dependencies, so tests can reach the services directly. */
  deps: FormatDeps;
  /** The docker handler under test. */
  handler: FormatHandler;
  /** The directory the handler spools uploads to. */
  uploadDir: string;
  /** The root directory of the local object store. */
  storePath: string;
  /** Every usage event the handler recorded, oldest first. */
  usage: UsageInput[];
  /** Sends a request to `http://weaver.test/v2/<rest>` (`rest` may carry a query); `token` is passed as the basic-auth password. */
  call(
    method: string,
    rest: string,
    init?: { headers?: Record<string, string>; body?: RequestInit["body"]; token?: string },
  ): Promise<Response>;
  /** Creates a repository as an admin. */
  createRepo(input: CreateRepoInput): Promise<Repo>;
  /** Issues a test token that acts as an API key holding `perms` on the named repositories, owned by a `role` user (default maintainer). */
  tokenFor(perms: Array<{ repo: string; access: Access }>, opts?: { role?: Role }): string;
  /** Stops the database and removes the temporary directories. */
  stop(): Promise<void>;
}

const ADMIN: Principal = { kind: "user", userId: "test-admin", role: "admin" };

/**
 * Starts a {@link DockerTestRegistry}; `fetchImpl` replaces the mirror engine's upstream fetch and
 * `dockerOptions` adds handler options (such as test hooks) beside the temporary upload directory.
 */
export async function startDockerTestRegistry(
  opts: { fetchImpl?: typeof fetch; dockerOptions?: Omit<DockerOptions, "uploadDir"> } = {},
): Promise<DockerTestRegistry> {
  const testDb = await startTestDb();
  const dir = await mkdtemp(join(tmpdir(), "weaver-docker-test-"));
  const secretKey = deriveSecretKey("docker-test");
  const storePath = join(dir, "blobs");
  const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: storePath });
  const repos = createRepoService({ db: testDb.db, stores, secretKey });
  const assets = createAssetService({ db: testDb.db, stores });
  const settings = (): Promise<ServerSettings> => Promise.resolve({ anonymousView: false, defaultCacheStore: "local" });
  const mirror = createMirrorEngine({ db: testDb.db, stores, repos, assets, settings, fetchImpl: opts.fetchImpl });
  const tokens = new Map<string, { perms: Array<{ repo: string; access: Access }>; role: Role }>();
  const usage: UsageInput[] = [];
  const uploadDir = join(dir, "uploads");

  const deps: FormatDeps = {
    db: testDb.db,
    stores,
    repos,
    assets,
    mirror,
    secretKey,
    publicUrl: "http://weaver.test",
    settings,
    usage(input) {
      usage.push(input);
      return Promise.resolve();
    },
    async principal(req) {
      const token = extractToken(req.headers);
      if (token === null) return { kind: "anonymous" };
      const entry = tokens.get(token);
      if (!entry) throw new RegistryError("unauthorized", "Invalid API key");
      const permissions: KeyPermission[] = [];
      for (const p of entry.perms) {
        const repo = await repos.get(p.repo);
        if (repo) permissions.push({ repositoryId: repo.id, repository: repo.name, groupPrefix: null, access: p.access });
      }
      return { kind: "apikey", keyId: token, userId: "test-user", role: entry.role, permissions };
    },
  };
  const handler = createDockerHandlerWith(deps, { ...opts.dockerOptions, uploadDir });

  return {
    deps,
    handler,
    uploadDir,
    storePath,
    usage,
    call(method, rest, init = {}) {
      const headers = new Headers(init.headers);
      if (init.token !== undefined) headers.set("authorization", `Basic ${Buffer.from(`x:${init.token}`).toString("base64")}`);
      // Node needs `duplex: "half"` to send a stream body; it is harmless for other bodies.
      const req = new Request(`http://weaver.test/v2/${rest}`, { method, headers, body: init.body, duplex: "half" } as RequestInit);
      // Like the mount, the handler gets the path only; the query stays on the request URL.
      return handler(req, rest.split("?")[0]!);
    },
    createRepo: (input) => repos.create(ADMIN, input),
    tokenFor(perms, opts = {}) {
      const token = `test-token-${tokens.size + 1}`;
      tokens.set(token, { perms, role: opts.role ?? "maintainer" });
      return token;
    },
    async stop() {
      await mirror.drain();
      await testDb.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A deterministic pseudo-random byte generator (xorshift32); the same seed always yields the same bytes. */
export function seededBytes(seed: number): (length: number) => Buffer {
  let state = seed >>> 0 || 0x9e3779b9;
  return (length) => {
    const out = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

/** `size` deterministic pseudo-random bytes from `seed`. */
export function randomBlob(seed: number, size: number): Buffer {
  return seededBytes(seed)(size);
}

/** The `sha256:<hex>` digest of `data`. */
export function digestOf(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** An OCI descriptor of `data` with `mediaType`, as a manifest references it. */
export function descriptorOf(data: Buffer, mediaType: string): { mediaType: string; digest: string; size: number } {
  return { mediaType, digest: digestOf(data), size: data.length };
}

/** Pushes `data` as a monolithic blob upload to image `name`; resolves to the response (201 on success). */
export function pushBlob(reg: DockerTestRegistry, name: string, data: Buffer, token: string): Promise<Response> {
  return reg.call("POST", `${name}/blobs/uploads/?digest=${encodeURIComponent(digestOf(data))}`, { token, body: data });
}

/**
 * PUTs a manifest to `name` under `reference`; `manifest` is serialized with `JSON.stringify` unless it is
 * already a Buffer, and `mediaType` (default: the manifest's own) becomes the Content-Type.
 */
export function pushManifest(
  reg: DockerTestRegistry,
  name: string,
  reference: string,
  manifest: unknown,
  token: string,
  mediaType?: string,
): Promise<Response> {
  const body = Buffer.isBuffer(manifest) ? manifest : Buffer.from(JSON.stringify(manifest));
  const type = mediaType ?? (manifest as { mediaType?: string }).mediaType ?? "application/vnd.oci.image.manifest.v1+json";
  return reg.call("PUT", `${name}/manifests/${reference}`, { token, body, headers: { "content-type": type } });
}

/** The OCI error code of an error response. */
export async function errorCodeOf(res: Response): Promise<string> {
  return ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;
}

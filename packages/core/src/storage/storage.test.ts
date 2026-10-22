import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStoreSetFromEnv, getBuffer, putBuffer, type ObjectStore } from "./index.js";
import { createLocalStore } from "./local.js";
import { createS3Store } from "./s3.js";

const MiB = 1024 * 1024;

/** Yields `total` deterministic bytes in 1 MiB chunks, so the body is never held as one buffer while streaming. */
function generated(total: number): { stream: () => Readable; bytes: () => Buffer } {
  const chunk = (i: number) => {
    const out = Buffer.alloc(Math.min(MiB, total - i * MiB));
    for (let j = 0; j < out.length; j++) out[j] = (i * 31 + j * 7 + (j >> 8)) & 0xff;
    return out;
  };
  const count = Math.ceil(total / MiB);
  return {
    stream: () =>
      Readable.from(
        (function* () {
          for (let i = 0; i < count; i++) yield chunk(i);
        })(),
      ),
    bytes: () => Buffer.concat(Array.from({ length: count }, (_, i) => chunk(i))),
  };
}

function digestsOf(data: Buffer) {
  const hex = (alg: string) => createHash(alg).update(data).digest("hex");
  return { md5: hex("md5"), sha1: hex("sha1"), sha256: hex("sha256"), sha512: hex("sha512") };
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

function sharedSuite(name: string, make: () => Promise<{ store: ObjectStore; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    let store: ObjectStore;
    let cleanup: () => Promise<void>;
    const prefix = `t${Date.now()}`;
    const key = (n: string) => `${prefix}/repo/dev.group/name/1.0.0/${n}.tar.gz`;

    const created = new Set<string>();

    beforeAll(async () => {
      const made = await make();
      cleanup = made.cleanup;
      const inner = made.store;
      store = {
        id: inner.id,
        put: (k, d, o) => {
          created.add(k);
          return inner.put(k, d, o);
        },
        get: (k, o) => inner.get(k, o),
        head: (k) => inner.head(k),
        delete: (k) => inner.delete(k),
        deleteMany: (ks) => inner.deleteMany(ks),
      };
    });
    afterAll(async () => {
      await store.deleteMany([...created]);
      await cleanup();
    });

    it("put then get returns the same bytes", async () => {
      const data = Buffer.from([0, 1, 2, 255, 128, 7]);
      await putBuffer(store, key("1"), data);
      expect((await getBuffer(store, key("1")))?.equals(data)).toBe(true);
    });

    it("overwrites an existing key", async () => {
      await putBuffer(store, key("2"), Buffer.from("a"));
      await putBuffer(store, key("2"), Buffer.from("b"));
      expect((await getBuffer(store, key("2")))?.toString()).toBe("b");
    });

    it("returns null for a missing key", async () => {
      expect(await store.get(key("missing"))).toBeNull();
      expect(await getBuffer(store, key("missing"))).toBeNull();
    });

    it("delete then get returns null", async () => {
      await putBuffer(store, key("3"), Buffer.from("x"));
      await store.delete(key("3"));
      expect(await store.get(key("3"))).toBeNull();
    });

    it("deleting a missing key does not throw", async () => {
      await expect(store.delete(key("nope"))).resolves.toBeUndefined();
    });

    it("put streams a 20 MiB generated stream and returns size and all four digests", async () => {
      const gen = generated(20 * MiB);
      const result = await store.put(key("big"), gen.stream());
      const expected = gen.bytes();
      expect(result).toEqual({ size: expected.length, ...digestsOf(expected) });
      const read = await store.get(key("big"));
      expect(read?.size).toBe(expected.length);
      expect(read?.range).toBeUndefined();
      expect((await readAll(read!.body)).equals(expected)).toBe(true);
    }, 120_000);

    it("put of a buffer returns its digests", async () => {
      const data = randomBytes(1000);
      expect(await store.put(key("buf"), data)).toEqual({ size: 1000, ...digestsOf(data) });
    });

    it("put aborted via signal leaves no object", async () => {
      const controller = new AbortController();
      let sent = 0;
      const body = new Readable({
        read() {
          sent++;
          if (sent === 3) controller.abort();
          this.push(Buffer.alloc(MiB, sent));
        },
      });
      await expect(store.put(key("aborted"), body, { signal: controller.signal })).rejects.toThrow();
      expect(await store.head(key("aborted"))).toBeNull();
    }, 60_000);

    for (const [label, total] of [
      ["single-part", 64 * 1024],
      ["multipart", 10 * MiB],
    ] as const) {
      it(`put aborted after the body has ended leaves no object (${label})`, async () => {
        const controller = new AbortController();
        const body = generated(total).stream();
        // The whole body has been read, so only the request that writes it is still in flight.
        body.once("end", () => controller.abort());
        await expect(store.put(key(`aborted-late-${label}`), body, { signal: controller.signal })).rejects.toThrow();
        // A request that kept running in the background would only show up after the rejection.
        await sleep(1000);
        expect(await store.head(key(`aborted-late-${label}`))).toBeNull();
      }, 60_000);
    }

    it("put fails and writes nothing when the body is longer than contentLength", async () => {
      await expect(store.put(key("too-long"), Buffer.from("0123456789"), { contentLength: 4 })).rejects.toThrow(
        /contentLength/,
      );
      expect(await store.head(key("too-long"))).toBeNull();
    });

    it("put fails and writes nothing when the body is shorter than contentLength", async () => {
      await expect(store.put(key("too-short"), Buffer.from("0123"), { contentLength: 10 })).rejects.toThrow(
        /contentLength/,
      );
      expect(await store.head(key("too-short"))).toBeNull();
    });

    it("put of a multipart stream longer than contentLength writes nothing", async () => {
      await expect(
        store.put(key("too-long-big"), generated(10 * MiB).stream(), { contentLength: 9 * MiB }),
      ).rejects.toThrow(/contentLength/);
      expect(await store.head(key("too-long-big"))).toBeNull();
    }, 60_000);

    it("put already aborted leaves no object", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        store.put(key("pre-aborted"), Buffer.from("x"), { signal: controller.signal }),
      ).rejects.toThrow();
      expect(await store.head(key("pre-aborted"))).toBeNull();
    });

    it("get with range returns exactly the requested bytes", async () => {
      const data = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
      await putBuffer(store, key("range"), data);
      const read = await store.get(key("range"), { range: { start: 10, end: 19 } });
      expect(read?.range).toEqual({ start: 10, end: 19 });
      expect(read?.size).toBe(100);
      const body = await readAll(read!.body);
      expect(body.length).toBe(10);
      expect(body.equals(data.subarray(10, 20))).toBe(true);
    });

    it("get with an open-ended range reads to the end", async () => {
      const data = Buffer.from(Array.from({ length: 50 }, (_, i) => i));
      await putBuffer(store, key("range-open"), data);
      const read = await store.get(key("range-open"), { range: { start: 40 } });
      expect(read?.range).toEqual({ start: 40, end: 49 });
      expect((await readAll(read!.body)).equals(data.subarray(40))).toBe(true);
    });

    it("get with a range starting past the end rejects with RangeError", async () => {
      await putBuffer(store, key("range-past"), Buffer.from("0123456789"));
      await expect(store.get(key("range-past"), { range: { start: 10 } })).rejects.toBeInstanceOf(RangeError);
      expect(await store.get(key("range-past-missing"), { range: { start: 0, end: 1 } })).toBeNull();
    });

    it("head returns size; missing key returns null", async () => {
      await putBuffer(store, key("head"), Buffer.from("hello"));
      expect(await store.head(key("head"))).toEqual({ size: 5 });
      expect(await store.head(key("head-missing"))).toBeNull();
    });

    it("deleteMany ignores missing keys", async () => {
      await putBuffer(store, key("dm1"), Buffer.from("1"));
      await putBuffer(store, key("dm2"), Buffer.from("2"));
      await expect(store.deleteMany([key("dm1"), key("dm-missing"), key("dm2")])).resolves.toBeUndefined();
      expect(await store.head(key("dm1"))).toBeNull();
      expect(await store.head(key("dm2"))).toBeNull();
      await expect(store.deleteMany([])).resolves.toBeUndefined();
    });
  });
}

sharedSuite("local store", async () => {
  const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
  return { store: createLocalStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
});

describe("local store specifics", () => {
  it("has id local", () => {
    expect(createLocalStore(tmpdir()).id).toBe("local");
  });

  it("rejects keys containing '..'", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      await expect(putBuffer(store, "../x", Buffer.from("a"))).rejects.toThrow(/\.\./);
      await expect(store.get("../x")).rejects.toThrow(/\.\./);
      await expect(store.head("../x")).rejects.toThrow(/\.\./);
      await expect(store.delete("a/../../x")).rejects.toThrow(/\.\./);
      await expect(store.deleteMany(["a/../../x"])).rejects.toThrow(/\.\./);
      await expect(store.get("a\\..\\..\\x")).rejects.toThrow(/\.\./);
      await expect(store.get("a/..")).rejects.toThrow(/\.\./);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts '..' inside a path segment, as in the artifact name foo..bar", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      const key = "releases/acme/foo..bar/1.0.0-rc..1/archive.tar.gz";
      await putBuffer(store, key, Buffer.from("a"));
      expect(await getBuffer(store, key)).toEqual(Buffer.from("a"));
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute and empty keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      await expect(putBuffer(store, "/abs", Buffer.from("a"))).rejects.toThrow();
      await expect(putBuffer(store, "", Buffer.from("a"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no temp files behind after put", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      await putBuffer(store, "a/b/c.tar.gz", Buffer.from("a"));
      expect(await readdir(join(root, "a", "b"))).toEqual(["c.tar.gz"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no temp files behind after an aborted put", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      const controller = new AbortController();
      const body = new Readable({
        read() {
          controller.abort();
          this.push(Buffer.alloc(1024));
        },
      });
      await expect(store.put("a/b/c.tar.gz", body, { signal: controller.signal })).rejects.toThrow();
      expect(await readdir(join(root, "a", "b"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Starts a throwaway SeaweedFS S3 server (same image and flags as docker-compose.yml) with a
 * `weaver` bucket. `S3_TEST_ENDPOINT` overrides it with an already running server.
 */
async function startTestS3(): Promise<{ endpoint: string; stop(): Promise<void> }> {
  if (process.env.S3_TEST_ENDPOINT) return { endpoint: process.env.S3_TEST_ENDPOINT, stop: async () => {} };
  const container = await new GenericContainer("chrislusf/seaweedfs:4.48")
    .withCommand(["server", "-s3", "-s3.port=9000", "-dir=/data"])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  try {
    // The bucket can only be created once both the master and the filer answer.
    const healthy = "wget -q -O /dev/null http://127.0.0.1:9333/cluster/status && wget -q -O /dev/null http://127.0.0.1:8888/";
    for (let attempt = 0; ; attempt++) {
      if ((await container.exec(["sh", "-c", healthy])).exitCode === 0) break;
      if (attempt >= 60) throw new Error("SeaweedFS did not become healthy");
      await sleep(1000);
    }
    const created = await container.exec([
      "sh",
      "-c",
      "echo 's3.bucket.create -name weaver' | weed shell -master=127.0.0.1:9333",
    ]);
    if (!/created bucket|already exists/.test(created.output)) {
      throw new Error(`Creating the test bucket failed: ${created.output}`);
    }
  } catch (error) {
    await container.stop();
    throw error;
  }
  return {
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * HTTP proxy to `target` that holds each committing request (PutObject, CompleteMultipartUpload)
 * for `delayMs` after it has fully arrived, calling `onCommit` first. That makes "abort while the
 * request that creates the object is in flight" deterministic.
 */
async function startCommitDelayProxy(
  target: string,
  delayMs: number,
  onCommit: () => void,
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const upstream = new URL(target);
  const isCommit = (req: IncomingMessage) => {
    const query = new URL(req.url ?? "/", "http://x").searchParams;
    return (req.method === "PUT" && !query.has("partNumber")) || (req.method === "POST" && query.has("uploadId"));
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const forward = () => {
        const out = request(
          { hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers },
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          },
        );
        out.on("error", () => res.destroy());
        out.end(Buffer.concat(chunks));
      };
      if (isCommit(req)) {
        onCommit();
        setTimeout(forward, delayMs);
      } else {
        forward();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("s3 store", () => {
  let server: { endpoint: string; stop(): Promise<void> } | undefined;
  const s3Opts = {
    endpoint: "",
    bucket: process.env.S3_TEST_BUCKET ?? "weaver",
    region: "us-east-1",
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "test",
  };

  beforeAll(async () => {
    server = await startTestS3();
    s3Opts.endpoint = server.endpoint;
  }, 180_000);
  afterAll(async () => {
    await server?.stop();
  });

  sharedSuite("s3 (S3-compatible server)", async () => ({
    store: createS3Store(s3Opts),
    cleanup: async () => {},
  }));

  it("has id s3", () => {
    expect(createS3Store(s3Opts).id).toBe("s3");
  });

  for (const [label, total] of [
    ["single-part PutObject", 64 * 1024],
    ["multipart CompleteMultipartUpload", 10 * MiB],
  ] as const) {
    it(`put aborted while the ${label} is in flight leaves no object`, async () => {
      const controller = new AbortController();
      const proxy = await startCommitDelayProxy(s3Opts.endpoint, 500, () => controller.abort());
      const k = `t${Date.now()}/aborted-in-flight/${total}.tar.gz`;
      try {
        const store = createS3Store({ ...s3Opts, endpoint: proxy.endpoint });
        await expect(store.put(k, generated(total).stream(), { signal: controller.signal })).rejects.toThrow();
        // Give a request that would keep running in the background time to land.
        await sleep(1500);
        expect(await createS3Store(s3Opts).head(k)).toBeNull();
      } finally {
        await createS3Store(s3Opts).delete(k);
        await proxy.close();
      }
    }, 60_000);
  }

  it("throws (rather than returning null) when the bucket does not exist", async () => {
    const store = createS3Store({ ...s3Opts, bucket: "weaver-no-such-bucket" });
    await expect(store.get("a/b/c.tar.gz")).rejects.toThrow();
  });
});

describe("createStoreSetFromEnv", () => {
  const s3Env = {
    S3_BUCKET: "b",
    S3_REGION: "r",
    S3_ACCESS_KEY_ID: "a",
    S3_SECRET_ACCESS_KEY: "s",
  };

  it("creates a local primary store", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: root });
      expect(stores.primary.id).toBe("local");
      expect(stores.configured()).toEqual(["local"]);
      await putBuffer(stores.primary, "k/v", Buffer.from("z"));
      expect((await getBuffer(stores.primary, "k/v"))?.toString()).toBe("z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates an s3 primary store when fully configured", () => {
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "s3", ...s3Env });
    expect(stores.primary.id).toBe("s3");
    expect(stores.get("s3")).toBe(stores.primary);
    expect(stores.get("local")).toBeNull();
    expect(stores.configured()).toEqual(["s3"]);
  });

  it("configures both stores when both are set and picks primary by STORAGE_DRIVER", () => {
    const env = { STORAGE_LOCAL_PATH: tmpdir(), ...s3Env };
    const local = createStoreSetFromEnv({ ...env, STORAGE_DRIVER: "local" });
    expect(local.primary.id).toBe("local");
    expect(local.configured()).toEqual(["local", "s3"]);
    expect(local.get("local")).toBe(local.primary);
    expect(local.get("s3")?.id).toBe("s3");

    const s3 = createStoreSetFromEnv({ ...env, STORAGE_DRIVER: "s3" });
    expect(s3.primary.id).toBe("s3");
    expect(s3.configured()).toEqual(["local", "s3"]);
    expect(s3.get("local")?.id).toBe("local");
  });

  it('get("s3") is null when S3_BUCKET is unset', () => {
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: tmpdir() });
    expect(stores.get("s3")).toBeNull();
  });

  it("throws on missing or invalid config", () => {
    expect(() => createStoreSetFromEnv({})).toThrow(/STORAGE_DRIVER/);
    expect(() => createStoreSetFromEnv({ STORAGE_DRIVER: "ftp" })).toThrow(/STORAGE_DRIVER/);
    expect(() => createStoreSetFromEnv({ STORAGE_DRIVER: "local" })).toThrow(/STORAGE_LOCAL_PATH/);
    expect(() => createStoreSetFromEnv({ STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
    expect(() => createStoreSetFromEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(/S3_REGION/);
    expect(() =>
      createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: tmpdir(), S3_BUCKET: "b" }),
    ).toThrow(/S3_REGION/);
  });
});

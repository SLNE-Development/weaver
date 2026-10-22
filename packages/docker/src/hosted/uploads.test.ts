import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerBlob, dockerUpload } from "@weaver/db";
import { digestOf, randomBlob, seededBytes, startDockerTestRegistry, type DockerTestRegistry } from "../testing.js";
import { SpoolError, SpoolOffsetError, appendToSpool } from "./spool.js";

const MiB = 1024 * 1024;

/** Size of a file, 0 when it does not exist. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Every file below `dir`, as paths relative to it. */
async function filesBelow(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  } catch {
    return [];
  }
}

describe("hosted blob uploads", () => {
  let reg: DockerTestRegistry;
  let key: string;
  let beforeBlobUpsert: ((digest: string, storageKey: string) => Promise<void>) | undefined;
  beforeAll(async () => {
    reg = await startDockerTestRegistry({
      dockerOptions: { beforeBlobUpsert: (digest, storageKey) => beforeBlobUpsert?.(digest, storageKey) ?? Promise.resolve() },
    });
    await reg.createRepo({ name: "hosted", format: "docker", kind: "hosted" });
    await reg.createRepo({ name: "other", format: "docker", kind: "hosted" });
    key = reg.tokenFor([
      { repo: "hosted", access: "write" },
      { repo: "other", access: "write" },
    ]);
  });
  afterAll(async () => {
    await reg?.stop();
  });

  async function codeOf(res: Response): Promise<string> {
    return ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;
  }
  async function start(name: string): Promise<string> {
    const res = await reg.call("POST", `${name}/blobs/uploads/`, { token: key });
    expect(res.status).toBe(202);
    const id = res.headers.get("docker-upload-uuid")!;
    expect(res.headers.get("location")).toBe(`/v2/${name}/blobs/uploads/${id}`);
    return id;
  }
  function patch(name: string, id: string, body: RequestInit["body"], range?: string): Promise<Response> {
    return reg.call("PATCH", `${name}/blobs/uploads/${id}`, {
      token: key,
      body,
      headers: range ? { "content-range": range, "content-type": "application/octet-stream" } : {},
    });
  }
  function finish(name: string, id: string, digest: string, body?: RequestInit["body"]): Promise<Response> {
    return reg.call("PUT", `${name}/blobs/uploads/${id}?digest=${encodeURIComponent(digest)}`, { token: key, body });
  }
  async function getBlob(name: string, digest: string): Promise<Buffer> {
    const res = await reg.call("GET", `${name}/blobs/${digest}`, { token: key });
    expect(res.status).toBe(200);
    return Buffer.from(await res.arrayBuffer());
  }
  async function blobRows(digest: string) {
    return reg.deps.db.select().from(dockerBlob).where(eq(dockerBlob.digest, digest));
  }
  async function storedObjects(digest: string): Promise<string[]> {
    const hex = digest.slice("sha256:".length);
    const files = await filesBelow(join(reg.storePath, "docker", "blobs", "sha256"));
    return files.filter((f) => f.includes(hex));
  }

  it("monolithic POST ?digest= stores and serves the blob", async () => {
    const data = randomBlob(1, 5000);
    const digest = digestOf(data);
    const res = await reg.call("POST", `hosted/mono/blobs/uploads/?digest=${encodeURIComponent(digest)}`, {
      token: key,
      body: data,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`/v2/hosted/mono/blobs/${digest}`);
    expect(res.headers.get("docker-content-digest")).toBe(digest);
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    const get = await reg.call("GET", `hosted/mono/blobs/${digest}`, { token: key });
    expect(get.status).toBe(200);
    expect(get.headers.get("docker-content-digest")).toBe(digest);
    expect(digestOf(Buffer.from(await get.arrayBuffer()))).toBe(digest);
    expect(reg.usage).toContainEqual(expect.objectContaining({ action: "upload", bytes: 5000 }));
  });

  it("POST answers 202 with Range 0-0 and an empty body", async () => {
    const res = await reg.call("POST", "hosted/app/blobs/uploads/", { token: key });
    expect(res.status).toBe(202);
    expect(res.headers.get("range")).toBe("0-0");
    expect(res.headers.get("content-length")).toBe("0");
    expect(res.headers.get("docker-upload-uuid")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.text()).toBe("");
  });

  it("POST, PATCH whole body, PUT empty (docker push flow)", async () => {
    const data = randomBlob(2, 3000);
    const digest = digestOf(data);
    const id = await start("hosted/app");
    const p = await patch("hosted/app", id, data);
    expect(p.status).toBe(202);
    expect(p.headers.get("range")).toBe("0-2999");
    expect(p.headers.get("location")).toBe(`/v2/hosted/app/blobs/uploads/${id}`);
    expect(p.headers.get("docker-upload-uuid")).toBe(id);
    const put = await finish("hosted/app", id, digest);
    expect(put.status).toBe(201);
    expect(put.headers.get("location")).toBe(`/v2/hosted/app/blobs/${digest}`);
    expect(put.headers.get("docker-content-digest")).toBe(digest);
    expect(await getBlob("hosted/app", digest)).toEqual(data);
    expect(await sizeOf(join(reg.uploadDir, id))).toBe(0);
    expect(await reg.deps.db.select().from(dockerUpload).where(eq(dockerUpload.id, id))).toHaveLength(0);
  });

  it("chunked PATCHes with Content-Range 0-999, 1000-1999 then PUT with final chunk", async () => {
    const data = randomBlob(3, 2500);
    const digest = digestOf(data);
    const id = await start("hosted/chunks");
    const a = await patch("hosted/chunks", id, data.subarray(0, 1000), "0-999");
    expect(a.status).toBe(202);
    expect(a.headers.get("range")).toBe("0-999");
    const b = await patch("hosted/chunks", id, data.subarray(1000, 2000), "1000-1999");
    expect(b.status).toBe(202);
    expect(b.headers.get("range")).toBe("0-1999");
    const put = await finish("hosted/chunks", id, digest, data.subarray(2000));
    expect(put.status).toBe(201);
    expect(await getBlob("hosted/chunks", digest)).toEqual(data);
  });

  it("out-of-order chunk → 416 with Range 0-999", async () => {
    const data = randomBlob(4, 3000);
    const id = await start("hosted/ooo");
    expect((await patch("hosted/ooo", id, data.subarray(0, 1000), "0-999")).status).toBe(202);
    const res = await patch("hosted/ooo", id, data.subarray(2000), "2000-2999");
    expect(res.status).toBe(416);
    expect(res.headers.get("range")).toBe("0-999");
    expect(res.headers.get("location")).toBe(`/v2/hosted/ooo/blobs/uploads/${id}`);
    expect(res.headers.get("docker-upload-uuid")).toBe(id);
    expect(res.headers.get("content-length")).not.toBe("0");
    expect(await codeOf(res)).toBe("RANGE_INVALID");
    const status = await reg.call("GET", `hosted/ooo/blobs/uploads/${id}`, { token: key });
    expect(status.headers.get("range")).toBe("0-999");
  });

  it("resumes after an interrupted PATCH", async () => {
    const data = randomBlob(5, 1000);
    const digest = digestOf(data);
    const id = await start("hosted/resume");
    const spool = join(reg.uploadDir, id);
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(data.subarray(0, 600)));
          return;
        }
        // The connection drops once the delivered bytes reached the server.
        for (let i = 0; i < 500 && (await sizeOf(spool)) < 600; i++) await delay(10);
        controller.error(new Error("connection reset"));
      },
    });
    const broken = await patch("hosted/resume", id, body);
    expect(broken.status).toBe(400);
    expect(broken.headers.get("range")).toBe("0-599");
    expect(broken.headers.get("content-length")).not.toBe("0");
    expect(await codeOf(broken)).toBe("BLOB_UPLOAD_INVALID");
    const status = await reg.call("GET", `hosted/resume/blobs/uploads/${id}`, { token: key });
    expect(status.status).toBe(204);
    expect(status.headers.get("range")).toBe("0-599");
    expect(status.headers.get("docker-upload-uuid")).toBe(id);
    const rest = await patch("hosted/resume", id, data.subarray(600), "600-999");
    expect(rest.status).toBe(202);
    expect(rest.headers.get("range")).toBe("0-999");
    const put = await finish("hosted/resume", id, digest);
    expect(put.status).toBe(201);
    expect(put.headers.get("docker-content-digest")).toBe(digest);
    expect(await getBlob("hosted/resume", digest)).toEqual(data);
  });

  it("wrong digest on PUT → 400 DIGEST_INVALID and no blob row", async () => {
    const data = randomBlob(6, 1200);
    const wrong = digestOf(randomBlob(66, 1200));
    const id = await start("hosted/wrong");
    expect((await patch("hosted/wrong", id, data)).status).toBe(202);
    const res = await finish("hosted/wrong", id, wrong);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("DIGEST_INVALID");
    expect(await blobRows(wrong)).toHaveLength(0);
    expect(await blobRows(digestOf(data))).toHaveLength(0);
    expect(await storedObjects(digestOf(data))).toHaveLength(0);
    expect(await storedObjects(wrong)).toHaveLength(0);
    // The upload is kept so the client can retry with the right digest.
    const retry = await finish("hosted/wrong", id, digestOf(data));
    expect(retry.status).toBe(201);
  });

  it("PUT without a digest → 400 DIGEST_INVALID", async () => {
    const id = await start("hosted/nodigest");
    const res = await reg.call("PUT", `hosted/nodigest/blobs/uploads/${id}`, { token: key });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("DIGEST_INVALID");
  });

  it("64 MiB PATCH is spooled with backpressure", async () => {
    const total = 64 * MiB;
    const chunk = 64 * 1024;
    const id = await start("hosted/big");
    const spool = join(reg.uploadDir, id);
    const next = seededBytes(7);
    const hash = createHash("sha256");
    let produced = 0;
    let maxLag = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          maxLag = Math.max(maxLag, produced - (await sizeOf(spool)));
          if (produced >= total) {
            controller.close();
            return;
          }
          const bytes = next(chunk);
          hash.update(bytes);
          produced += bytes.length;
          controller.enqueue(new Uint8Array(bytes));
        },
      },
      { highWaterMark: 1 },
    );
    const res = await patch("hosted/big", id, body);
    expect(res.status).toBe(202);
    expect(res.headers.get("range")).toBe(`0-${total - 1}`);
    expect(maxLag).toBeLessThanOrEqual(4 * MiB);
    const digest = `sha256:${hash.digest("hex")}`;
    const put = await finish("hosted/big", id, digest);
    expect(put.status).toBe(201);
    const head = await reg.call("HEAD", `hosted/big/blobs/${digest}`, { token: key });
    expect(head.headers.get("content-length")).toBe(String(total));
  }, 120_000);

  it("concurrent uploads of one digest dedupe", async () => {
    const data = randomBlob(8, 4096);
    const digest = digestOf(data);
    const a = await start("hosted/dup");
    const b = await start("other/dup");
    expect((await patch("hosted/dup", a, data)).status).toBe(202);
    expect((await patch("other/dup", b, data)).status).toBe(202);
    // Hold both finalizes after their object is stored and before the row upsert, so both race the
    // unique key and exactly one takes the loser path (deleting its own object).
    const keys: string[] = [];
    let release!: () => void;
    const bothStored = new Promise<void>((resolve) => (release = resolve));
    beforeBlobUpsert = async (d, storageKey) => {
      if (d !== digest) return;
      keys.push(storageKey);
      if (keys.length === 2) release();
      await bothStored;
    };
    try {
      const [ra, rb] = await Promise.all([finish("hosted/dup", a, digest), finish("other/dup", b, digest)]);
      expect(ra.status).toBe(201);
      expect(rb.status).toBe(201);
    } finally {
      beforeBlobUpsert = undefined;
    }
    expect(keys).toHaveLength(2);
    const rows = await blobRows(digest);
    expect(rows).toHaveLength(1);
    expect(keys).toContain(rows[0]!.storageKey);
    expect(await storedObjects(digest)).toHaveLength(1);
    expect(await getBlob("hosted/dup", digest)).toEqual(data);
    expect(await getBlob("other/dup", digest)).toEqual(data);
  });

  it("second push of an existing digest stores nothing new and links it", async () => {
    const data = randomBlob(9, 2048);
    const digest = digestOf(data);
    const first = await reg.call("POST", `hosted/first/blobs/uploads/?digest=${encodeURIComponent(digest)}`, {
      token: key,
      body: data,
    });
    expect(first.status).toBe(201);
    const [before] = await blobRows(digest);
    const id = await start("hosted/second");
    expect((await patch("hosted/second", id, data)).status).toBe(202);
    expect((await finish("hosted/second", id, digest)).status).toBe(201);
    const rows = await blobRows(digest);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.storageKey).toBe(before!.storageKey);
    expect(await storedObjects(digest)).toHaveLength(1);
    expect(await getBlob("hosted/second", digest)).toEqual(data);
  });

  it("an unknown or foreign upload id → 404 BLOB_UPLOAD_UNKNOWN", async () => {
    const unknown = await reg.call("GET", `hosted/app/blobs/uploads/${randomUUID()}`, { token: key });
    expect(unknown.status).toBe(404);
    expect(await codeOf(unknown)).toBe("BLOB_UPLOAD_UNKNOWN");
    const id = await start("hosted/mine");
    const foreign = await patch("other/mine", id, Buffer.from("x"));
    expect(foreign.status).toBe(404);
    expect(await codeOf(foreign)).toBe("BLOB_UPLOAD_UNKNOWN");
    const otherImage = await reg.call("PUT", `hosted/yours/blobs/uploads/${id}?digest=${digestOf(Buffer.from(""))}`, {
      token: key,
    });
    expect(otherImage.status).toBe(404);
  });

  it("DELETE upload → 204 and the spool file is gone", async () => {
    const id = await start("hosted/cancel");
    expect((await patch("hosted/cancel", id, randomBlob(10, 100))).status).toBe(202);
    expect(await sizeOf(join(reg.uploadDir, id))).toBe(100);
    const res = await reg.call("DELETE", `hosted/cancel/blobs/uploads/${id}`, { token: key });
    expect(res.status).toBe(204);
    await expect(stat(join(reg.uploadDir, id))).rejects.toThrow();
    const status = await reg.call("GET", `hosted/cancel/blobs/uploads/${id}`, { token: key });
    expect(status.status).toBe(404);
  });

  it("appendToSpool cuts leftovers past the offset, rejects a short file and keeps completed writes on failure", async () => {
    const path = join(reg.uploadDir, `spool-${randomUUID()}`);
    await writeFile(path, Buffer.from("abcdefXYZ"));
    const body = (bytes: Buffer) => new Blob([new Uint8Array(bytes)]).stream();
    expect(await appendToSpool(path, body(Buffer.from("gh")), 6)).toBe(2);
    expect(await readFile(path, "utf8")).toBe("abcdefgh");
    await expect(appendToSpool(path, body(Buffer.from("x")), 20)).rejects.toBeInstanceOf(SpoolOffsetError);
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("boom"));
      },
    });
    await expect(appendToSpool(path, failing, 8)).rejects.toBeInstanceOf(SpoolError);
    expect(await readFile(path, "utf8")).toBe("abcdefgh");
  });

  it("upload status needs push access", async () => {
    const id = await start("hosted/status");
    const reader = reg.tokenFor([{ repo: "hosted", access: "read" }]);
    const res = await reg.call("GET", `hosted/status/blobs/uploads/${id}`, { token: reader });
    expect(res.status).toBe(403);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digestOf, randomBlob, startDockerTestRegistry, type DockerTestRegistry } from "../testing.js";
import { findLinkedBlob } from "./blobs.js";

describe("hosted blobs", () => {
  let reg: DockerTestRegistry;
  let key: string;
  let secretKey: string;
  const data = randomBlob(42, 4000);
  const digest = digestOf(data);
  beforeAll(async () => {
    reg = await startDockerTestRegistry();
    await reg.createRepo({ name: "hosted", format: "docker", kind: "hosted" });
    await reg.createRepo({ name: "other", format: "docker", kind: "hosted" });
    await reg.createRepo({ name: "secret", format: "docker", kind: "hosted" });
    key = reg.tokenFor([
      { repo: "hosted", access: "write" },
      { repo: "other", access: "write" },
    ]);
    secretKey = reg.tokenFor([{ repo: "secret", access: "write" }]);
    expect((await push("hosted/app", data, key)).status).toBe(201);
  });
  afterAll(async () => {
    await reg?.stop();
  });

  function push(name: string, body: Buffer, token: string): Promise<Response> {
    return reg.call("POST", `${name}/blobs/uploads/?digest=${encodeURIComponent(digestOf(body))}`, { token, body });
  }
  async function codeOf(res: Response): Promise<string> {
    return ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;
  }
  async function jwtFor(scope: string, basicKey: string): Promise<string> {
    const req = new Request(`http://weaver.test/v2/token?service=weaver.test&scope=${encodeURIComponent(scope)}`, {
      headers: { authorization: `Basic ${Buffer.from(`x:${basicKey}`).toString("base64")}` },
    });
    const res = await reg.handler(req, "token");
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  it("GET streams the blob with digest, type, ranges and etag headers", async () => {
    const res = await reg.call("GET", `hosted/app/blobs/${digest}`, { token: key });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("docker-content-digest")).toBe(digest);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toBe(`"${digest}"`);
    expect(res.headers.get("content-length")).toBe("4000");
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data);
    expect(reg.usage).toContainEqual(expect.objectContaining({ action: "download", bytes: 4000 }));
  });

  it("GET with Range: bytes=10-19 → 206 with 10 bytes and Content-Range bytes 10-19/<size>", async () => {
    const res = await reg.call("GET", `hosted/app/blobs/${digest}`, { token: key, headers: { range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/4000");
    expect(res.headers.get("content-length")).toBe("10");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data.subarray(10, 20));
  });

  it("an open-ended range reads to the end", async () => {
    const res = await reg.call("GET", `hosted/app/blobs/${digest}`, { token: key, headers: { range: "bytes=3990-" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 3990-3999/4000");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data.subarray(3990));
  });

  it("an unsatisfiable range → 416", async () => {
    const res = await reg.call("GET", `hosted/app/blobs/${digest}`, { token: key, headers: { range: "bytes=5000-5009" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */4000");
    expect(await codeOf(res)).toBe("RANGE_INVALID");
  });

  it("HEAD has Content-Length and no body", async () => {
    const res = await reg.call("HEAD", `hosted/app/blobs/${digest}`, { token: key });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("4000");
    expect(res.headers.get("docker-content-digest")).toBe(digest);
    expect(await res.text()).toBe("");
  });

  it("an unknown blob → 404 BLOB_UNKNOWN", async () => {
    const res = await reg.call("GET", `hosted/app/blobs/${digestOf(Buffer.from("nope"))}`, { token: key });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("BLOB_UNKNOWN");
  });

  it("blob of another repo is 404 BLOB_UNKNOWN until mounted", async () => {
    const before = await reg.call("GET", `other/app/blobs/${digest}`, { token: key });
    expect(before.status).toBe(404);
    expect(await codeOf(before)).toBe("BLOB_UNKNOWN");
    const other = await reg.call("HEAD", `hosted/elsewhere/blobs/${digest}`, { token: key });
    expect(other.status).toBe(404);
  });

  it("mount from a readable repo → 201", async () => {
    const res = await reg.call("POST", `other/app/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=hosted/app`, {
      token: key,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`/v2/other/app/blobs/${digest}`);
    expect(res.headers.get("docker-content-digest")).toBe(digest);
    const get = await reg.call("GET", `other/app/blobs/${digest}`, { token: key });
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(data);
  });

  it("mount from an unreadable repo → 202 upload", async () => {
    const hidden = randomBlob(43, 900);
    expect((await push("secret/app", hidden, secretKey)).status).toBe(201);
    const res = await reg.call(
      "POST",
      `hosted/stolen/blobs/uploads/?mount=${encodeURIComponent(digestOf(hidden))}&from=secret/app`,
      { token: key },
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("location")).toMatch(/^\/v2\/hosted\/stolen\/blobs\/uploads\/[0-9a-f-]{36}$/);
    const get = await reg.call("GET", `hosted/stolen/blobs/${digestOf(hidden)}`, { token: key });
    expect(get.status).toBe(404);
  });

  it("mount with a JWT lacking pull on the source → 202 upload, even when the key could read it", async () => {
    const jwt = await jwtFor("repository:other/jwt:pull,push", key);
    const res = await reg.call("POST", `other/jwt/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=hosted/app`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(202);
    const target = (await reg.deps.repos.get("other"))!;
    expect(await findLinkedBlob(reg.deps.db, target.id, "jwt", digest)).toBeNull();
  });

  it("mount with a JWT holding pull on the source → 201", async () => {
    const jwt = await jwtFor("repository:other/jwt2:pull,push repository:hosted/app:pull", key);
    const res = await reg.call("POST", `other/jwt2/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=hosted/app`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(201);
  });

  it("mount of a digest the source does not have → 202 upload", async () => {
    const missing = digestOf(Buffer.from("missing"));
    const res = await reg.call("POST", `other/app/blobs/uploads/?mount=${encodeURIComponent(missing)}&from=hosted/app`, {
      token: key,
    });
    expect(res.status).toBe(202);
  });

  it("DELETE blob → 202 then GET 404", async () => {
    const own = randomBlob(44, 300);
    expect((await push("hosted/del", own, key)).status).toBe(201);
    const del = await reg.call("DELETE", `hosted/del/blobs/${digestOf(own)}`, { token: key });
    expect(del.status).toBe(202);
    const get = await reg.call("GET", `hosted/del/blobs/${digestOf(own)}`, { token: key });
    expect(get.status).toBe(404);
    expect(await codeOf(get)).toBe("BLOB_UNKNOWN");
    const again = await reg.call("DELETE", `hosted/del/blobs/${digestOf(own)}`, { token: key });
    expect(again.status).toBe(404);
  });
});

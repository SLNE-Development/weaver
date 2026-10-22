import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDockerTestRegistry, type DockerTestRegistry } from "./testing.js";

const hex = "a".repeat(64);

describe("docker handler", () => {
  let reg: DockerTestRegistry;
  let token: string;
  beforeAll(async () => {
    reg = await startDockerTestRegistry();
    await reg.createRepo({ name: "hosted", format: "docker", kind: "hosted" });
    token = reg.tokenFor([{ repo: "hosted", access: "read" }]);
  });
  afterAll(async () => {
    await reg?.stop();
  });

  async function codeOf(res: Response): Promise<string> {
    return ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;
  }

  it("unknown route answers 404 with OCI body and registry/2.0 header", async () => {
    const res = await reg.call("GET", "nothing/here");
    expect(res.status).toBe(404);
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(((await res.json()) as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it("GET /v2/ without auth gives 401 with a Bearer challenge", async () => {
    const res = await reg.call("GET", "");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="http://weaver.test/v2/token",service="weaver.test"');
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    expect(await codeOf(res)).toBe("UNAUTHORIZED");
  });

  it("GET /v2/ with a valid basic token gives 200 {}", async () => {
    const res = await reg.call("GET", "", { token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
  });

  it("an unknown token gives 401 with the challenge", async () => {
    const res = await reg.call("GET", "", { token: "nope" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer realm=");
  });

  it("a malformed repository name gives 400 NAME_INVALID", async () => {
    const res = await reg.call("GET", "Bad/Name/manifests/latest", { token });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("NAME_INVALID");
  });

  it("an invalid manifest reference gives 400 MANIFEST_INVALID", async () => {
    const res = await reg.call("GET", "hosted/app/manifests/-bad", { token });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("MANIFEST_INVALID");
  });

  it("an invalid digest-shaped manifest reference gives 400 DIGEST_INVALID", async () => {
    const res = await reg.call("GET", "hosted/app/manifests/sha256:xyz", { token });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("DIGEST_INVALID");
  });

  it("an invalid blob digest gives 400 DIGEST_INVALID", async () => {
    const res = await reg.call("GET", "hosted/app/blobs/sha256:short", { token });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("DIGEST_INVALID");
  });

  it("an invalid referrers digest gives 400 DIGEST_INVALID", async () => {
    const res = await reg.call("GET", "hosted/app/referrers/latest", { token });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("DIGEST_INVALID");
  });

  it("an invalid upload id gives 404 BLOB_UPLOAD_UNKNOWN", async () => {
    const res = await reg.call("GET", "hosted/app/blobs/uploads/not-a-uuid", { token });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  it("a trailing slash on a manifest path is an unknown route", async () => {
    const res = await reg.call("GET", "hosted/app/manifests/latest/", { token });
    expect(res.status).toBe(404);
  });

  it("an unknown repository gives 404 NAME_UNKNOWN to an authenticated caller", async () => {
    const res = await reg.call("GET", `other/app/blobs/sha256:${hex}`, { token });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("NAME_UNKNOWN");
  });

  it("an anonymous caller on a private repository gets 401, not a name oracle", async () => {
    const res = await reg.call("GET", `hosted/app/blobs/sha256:${hex}`);
    expect(res.status).toBe(401);
  });

  it("a key without access gets 403 DENIED", async () => {
    const other = reg.tokenFor([]);
    const res = await reg.call("GET", `hosted/app/blobs/sha256:${hex}`, { token: other });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("DENIED");
  });

  it("POST blobs/uploads without a trailing slash passes validation like the slashed form", async () => {
    const a = await reg.call("POST", "hosted/app/blobs/uploads", { token });
    const b = await reg.call("POST", "hosted/app/blobs/uploads/", { token });
    expect(a.status).toBe(b.status);
    expect(a.status).not.toBe(404);
  });
});

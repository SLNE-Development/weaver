import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startDockerTestRegistry, type DockerTestRegistry } from "../testing.js";
import type { DockerClaims } from "./jwt.js";

function basic(token: string, user = "x"): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

function decode(token: string): DockerClaims {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as DockerClaims;
}

describe("docker token endpoint", () => {
  let reg: DockerTestRegistry;
  let writeKey: string;
  let viewerKey: string;
  beforeAll(async () => {
    reg = await startDockerTestRegistry();
    await reg.createRepo({ name: "pub", format: "docker", kind: "hosted", visibility: "public" });
    await reg.createRepo({ name: "priv", format: "docker", kind: "hosted" });
    await reg.createRepo({
      name: "mirror",
      format: "docker",
      kind: "mirror",
      upstreams: [{ url: "https://registry.example", authType: "none" }],
    });
    await reg.createRepo({ name: "grp", format: "docker", kind: "group", members: ["priv", "mirror"] });
    await reg.createRepo({
      name: "hub",
      format: "docker",
      kind: "mirror",
      visibility: "public",
      dockerRoot: true,
      upstreams: [{ url: "https://registry-1.docker.io", authType: "none" }],
    });
    writeKey = reg.tokenFor([
      { repo: "priv", access: "write" },
      { repo: "mirror", access: "write" },
      { repo: "grp", access: "write" },
    ]);
    viewerKey = reg.tokenFor([{ repo: "priv", access: "write" }], { role: "viewer" });
  });
  afterAll(async () => {
    await reg?.stop();
  });

  /** Sends `GET /v2/token` through the handler with the given query and headers. */
  function get(query: string, headers: Record<string, string> = {}): Promise<Response> {
    return reg.handler(new Request(`http://weaver.test/v2/token?${query}`, { headers }), "token");
  }
  function post(form: Record<string, string>): Promise<Response> {
    return reg.handler(
      new Request("http://weaver.test/v2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }),
      "token",
    );
  }
  /** The decoded access entries of a token response, with each bound repository id replaced by the repository's name. */
  async function accessOf(res: Response): Promise<DockerClaims["access"]> {
    expect(res.status).toBe(200);
    const access = decode(((await res.json()) as { token: string }).token).access;
    return Promise.all(
      access.map(async (e) => {
        if (e.repo === undefined) return e;
        const repo = await reg.deps.repos.getById(e.repo);
        return { ...e, repo: repo?.name ?? `missing:${e.repo}` };
      }),
    );
  }

  it("anonymous GET grants pull on a public hosted repo and nothing on a private one", async () => {
    const res = await get("service=weaver.test&scope=repository:pub/app:pull&scope=repository:priv/app:pull");
    expect(await accessOf(res)).toEqual([
      { type: "repository", name: "pub/app", actions: ["pull"], repo: "pub" },
      { type: "repository", name: "priv/app", actions: [], repo: "priv" },
    ]);
  });

  it("anonymous token claims", async () => {
    const res = await get("scope=repository:pub/app:pull,push");
    const body = (await res.json()) as { token: string };
    const c = decode(body.token);
    expect(c).toMatchObject({ iss: "weaver", aud: "weaver.test", sub: "anonymous", wv: { kind: "anonymous" } });
    expect(c.exp - c.iat).toBe(300);
    expect(c.access).toMatchObject([{ type: "repository", name: "pub/app", actions: ["pull"] }]);
  });

  it("basic with a write key grants pull,push", async () => {
    const res = await get("scope=repository:priv/app:pull,push", { authorization: basic(writeKey) });
    expect(await accessOf(res)).toEqual([{ type: "repository", name: "priv/app", actions: ["pull", "push"], repo: "priv" }]);
  });

  it("basic key token carries attribution", async () => {
    const res = await get("scope=repository:priv/app:pull", { authorization: basic(writeKey) });
    const c = decode(((await res.json()) as { token: string }).token);
    expect(c.sub).toBe("test-user");
    expect(c.wv).toEqual({ kind: "apikey", userId: "test-user", keyId: writeKey, role: "maintainer" });
  });

  it("viewer-owned key gets pull only", async () => {
    const res = await get("scope=repository:priv/app:pull,push,delete", { authorization: basic(viewerKey) });
    expect(await accessOf(res)).toEqual([{ type: "repository", name: "priv/app", actions: ["pull"], repo: "priv" }]);
  });

  it("invalid basic → 401 UNAUTHORIZED", async () => {
    const res = await get("scope=repository:priv/app:pull", { authorization: basic("wrong") });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { errors: Array<{ code: string; message: string }> };
    expect(body.errors[0]!.code).toBe("UNAUTHORIZED");
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="weaver.test"');
  });

  it("push on a group or mirror is never granted", async () => {
    const res = await get("scope=repository:mirror/app:pull,push,delete&scope=repository:grp/app:pull,push", {
      authorization: basic(writeKey),
    });
    expect(await accessOf(res)).toEqual([
      { type: "repository", name: "mirror/app", actions: ["pull"], repo: "mirror" },
      { type: "repository", name: "grp/app", actions: ["pull"], repo: "grp" },
    ]);
  });

  it("group read grants pull on group/app", async () => {
    const groupReader = reg.tokenFor([{ repo: "grp", access: "read" }]);
    const res = await get("scope=repository:grp/app:pull&scope=repository:priv/app:pull", {
      authorization: basic(groupReader),
    });
    expect(await accessOf(res)).toEqual([
      { type: "repository", name: "grp/app", actions: ["pull"], repo: "grp" },
      { type: "repository", name: "priv/app", actions: [], repo: "priv" },
    ]);
  });

  it('root mirror scope "library/nginx" is granted when the root mirror is public', async () => {
    const res = await get("scope=repository:library/nginx:pull");
    expect(await accessOf(res)).toEqual([{ type: "repository", name: "library/nginx", actions: ["pull"], repo: "hub" }]);
  });

  it("a bare repository name or a malformed name grants nothing", async () => {
    const res = await get("scope=repository:priv:pull&scope=repository:Bad/Name:pull", { authorization: basic(writeKey) });
    expect(await accessOf(res)).toEqual([
      { type: "repository", name: "priv", actions: [] },
      { type: "repository", name: "Bad/Name", actions: [] },
    ]);
  });

  it("POST form grant_type=password works", async () => {
    const res = await post({
      grant_type: "password",
      username: "someone",
      password: writeKey,
      service: "weaver.test",
      scope: "repository:priv/app:pull,push",
      client_id: "containerd",
    });
    expect(await accessOf(res)).toEqual([{ type: "repository", name: "priv/app", actions: ["pull", "push"], repo: "priv" }]);
  });

  it("POST grant_type=password with a bad password → 401 UNAUTHORIZED", async () => {
    const res = await post({ grant_type: "password", username: "someone", password: "wrong", scope: "repository:priv/app:pull" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe("UNAUTHORIZED");
  });

  it("POST grant_type=refresh_token → 400 unsupported_grant_type", async () => {
    const res = await post({ grant_type: "refresh_token", refresh_token: "x", service: "weaver.test" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported_grant_type" });
  });

  it("response has token, access_token, expires_in 300, issued_at", async () => {
    const res = await get("service=weaver.test");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["access_token", "expires_in", "issued_at", "token"]);
    expect(body.access_token).toBe(body.token);
    expect(body.expires_in).toBe(300);
    expect(new Date(body.issued_at as string).toISOString()).toBe(body.issued_at);
    expect(decode(body.token as string).access).toEqual([]);
  });

  it("scope given twice and space-separated both parse", async () => {
    const twice = await get("scope=repository:pub/a:pull&scope=repository:pub/b:pull");
    const spaced = await get(`scope=${encodeURIComponent("repository:pub/a:pull repository:pub/b:pull")}`);
    const expected = [{ type: "repository", name: "pub/a", actions: ["pull"], repo: "pub" }, { type: "repository", name: "pub/b", actions: ["pull"], repo: "pub" }];
    expect(await accessOf(twice)).toEqual(expected);
    expect(await accessOf(spaced)).toEqual(expected);
  });

  it("other methods, HEAD included → 405 UNSUPPORTED", async () => {
    for (const method of ["PUT", "HEAD"]) {
      const res = await reg.handler(new Request("http://weaver.test/v2/token", { method }), "token");
      expect(res.status).toBe(405);
    }
  });

  it("more than 32 distinct names → 400 invalid_scope", async () => {
    const names = (n: number): string => Array.from({ length: n }, (_, i) => `scope=repository:pub/a${i}:pull`).join("&");
    const ok = await get(`${names(32)}&scope=repository:pub/a0:push`);
    expect(ok.status).toBe(200);
    const res = await get(names(33));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_scope" });
    const scope = Array.from({ length: 33 }, (_, i) => `repository:pub/a${i}:pull`).join(" ");
    const form = await post({ grant_type: "password", password: writeKey, scope });
    expect(form.status).toBe(400);
  });

  it("a POST body above 64 KiB → 413", async () => {
    const big = await post({ grant_type: "password", password: writeKey, pad: "x".repeat(64 * 1024) });
    expect(big.status).toBe(413);
    const streamed = await reg.handler(
      new Request("http://weaver.test/v2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < 80; i++) c.enqueue(new Uint8Array(1024).fill(120));
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
      "token",
    );
    expect(streamed.status).toBe(413);
  });

  it("dockerRoot is resolved once per token request", async () => {
    const spy = vi.spyOn(reg.deps.repos, "dockerRoot");
    try {
      const res = await get("scope=repository:library/a:pull&scope=repository:library/b:pull&scope=repository:x/y:pull");
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

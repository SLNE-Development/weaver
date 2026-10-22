import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RegistryError } from "@weaver/core";
import { DockerError } from "../errors.js";
import { createDockerHandlerWith } from "../handler.js";
import { resolveTarget, type Target } from "../target.js";
import { startDockerTestRegistry, type DockerTestRegistry } from "../testing.js";
import { identify, requireAccess } from "./authorize.js";
import { signToken, tokenKey, type AccessEntry, type DockerClaims } from "./jwt.js";

const REALM = 'Bearer realm="http://weaver.test/v2/token",service="weaver.test"';

describe("docker request authorization", () => {
  let reg: DockerTestRegistry;
  let readKey: string;
  let writeKey: string;
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
    readKey = reg.tokenFor([{ repo: "priv", access: "read" }]);
    writeKey = reg.tokenFor([
      { repo: "priv", access: "write" },
      { repo: "mirror", access: "write" },
    ]);
  });
  afterAll(async () => {
    await reg?.stop();
  });

  async function tokenFrom(query: string, key?: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Basic ${Buffer.from(`x:${key}`).toString("base64")}`;
    const res = await reg.handler(new Request(`http://weaver.test/v2/token?${query}`, { headers }), "token");
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }
  function bearer(method: string, rest: string, jwt: string): Promise<Response> {
    return reg.call(method, rest, { headers: { authorization: `Bearer ${jwt}` } });
  }
  function jwt(access: AccessEntry[], at: Date, wv: DockerClaims["wv"] = { kind: "anonymous" }): string {
    const iat = Math.floor(at.getTime() / 1000);
    return signToken(tokenKey(reg.deps.secretKey), {
      iss: "weaver",
      aud: "weaver.test",
      sub: wv.userId ?? "anonymous",
      iat,
      nbf: iat,
      exp: iat + 300,
      jti: randomUUID(),
      access,
      wv,
    });
  }
  async function target(name: string): Promise<Target> {
    return (await resolveTarget(reg.deps.repos, name))!;
  }
  async function codeOf(res: Response): Promise<string> {
    return ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;
  }

  it('anonymous on private → 401 with scope="repository:priv/app:pull"', async () => {
    const res = await reg.call("GET", "priv/app/manifests/latest");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`${REALM},scope="repository:priv/app:pull"`);
    expect(await codeOf(res)).toBe("UNAUTHORIZED");
  });

  it("anonymous push scope names push and pull", async () => {
    const res = await reg.call("POST", "priv/app/blobs/uploads/");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`${REALM},scope="repository:priv/app:pull,push"`);
  });

  it("anonymous JWT lacking the scope → 401 insufficient_scope", async () => {
    const t = await tokenFrom("scope=repository:priv/app:pull");
    const res = await bearer("GET", "priv/app/manifests/latest", t);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `${REALM},scope="repository:priv/app:pull",error="insufficient_scope"`,
    );
  });

  it("anonymous JWT with pull on a public repo passes authorization", async () => {
    const t = await tokenFrom("scope=repository:pub/app:pull");
    const res = await bearer("GET", "pub/app/manifests/latest", t);
    expect([401, 403]).not.toContain(res.status);
  });

  it("JWT lacking push → 403 DENIED", async () => {
    const t = await tokenFrom("scope=repository:priv/app:pull,push", readKey);
    const res = await bearer("PUT", "priv/app/manifests/latest", t);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("DENIED");
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("JWT with pull,push authorizes push", async () => {
    const t = await tokenFrom("scope=repository:priv/app:pull,push", writeKey);
    const res = await bearer("POST", "priv/app/blobs/uploads/", t);
    expect([401, 403, 405]).not.toContain(res.status);
  });

  it("JWT for another image → 401 insufficient_scope", async () => {
    const t = await tokenFrom("scope=repository:priv/app:pull,push", writeKey);
    const res = await bearer("GET", "priv/other/manifests/latest", t);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `${REALM},scope="repository:priv/other:pull",error="insufficient_scope"`,
    );
  });

  it("an authenticated JWT that was refused an evaluated scope → 403 DENIED", async () => {
    const other = reg.tokenFor([]);
    const t = await tokenFrom("scope=repository:priv/app:pull", other);
    const res = await bearer("GET", "priv/app/manifests/latest", t);
    expect(res.status).toBe(403);
  });

  it("claims are bound to the repository: a recreated repository does not inherit a token", async () => {
    await reg.createRepo({ name: "ephemeral", format: "docker", kind: "hosted", visibility: "public" });
    const t = await tokenFrom("scope=repository:ephemeral/app:pull");
    expect((await bearer("GET", "ephemeral/app/manifests/latest", t)).status).not.toBe(401);
    await reg.deps.repos.delete({ kind: "user", userId: "test-admin", role: "admin" }, "ephemeral");
    await reg.createRepo({ name: "ephemeral", format: "docker", kind: "hosted" });
    const res = await bearer("GET", "ephemeral/app/manifests/latest", t);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it('alg "none" and "RS256" tokens are rejected with a plain 401', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        iss: "weaver",
        aud: "weaver.test",
        sub: "anonymous",
        iat: Math.floor(Date.now() / 1000),
        nbf: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        jti: "x",
        access: [{ type: "repository", name: "priv/app", actions: ["pull"] }],
        wv: { kind: "anonymous" },
      }),
    ).toString("base64url");
    for (const alg of ["none", "RS256"]) {
      const header = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
      const sig = alg === "none" ? "" : Buffer.alloc(256, 7).toString("base64url");
      const res = await bearer("GET", "priv/app/manifests/latest", `${header}.${payload}.${sig}`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`${REALM},scope="repository:priv/app:pull"`);
    }
  });

  it("push to mirror → 405 UNSUPPORTED", async () => {
    const res = await reg.call("PUT", "mirror/app/manifests/latest", { token: writeKey });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { errors: Array<{ code: string; message: string }> };
    expect(body.errors[0]).toMatchObject({ code: "UNSUPPORTED", message: "mirror is a mirror repository and read-only" });
  });

  it("anonymous push to a private mirror is challenged, not told its kind", async () => {
    const res = await reg.call("DELETE", "mirror/app/manifests/latest");
    expect(res.status).toBe(401);
  });

  it("raw basic access token authorizes without JWT", async () => {
    const req = new Request("http://weaver.test/v2/priv/app/manifests/latest", {
      headers: { authorization: `Basic ${Buffer.from(`x:${readKey}`).toString("base64")}` },
    });
    const caller = await identify(reg.deps, req);
    expect(caller.claims).toBeNull();
    expect(caller.principal.kind).toBe("apikey");
    const t = await target("priv/app");
    expect(() => requireAccess(reg.deps, caller, t, "pull")).not.toThrow();
    expect(() => requireAccess(reg.deps, caller, t, "push")).toThrow(DockerError);
    const res = await reg.call("GET", "priv/app/manifests/latest", { token: readKey });
    expect([401, 403]).not.toContain(res.status);
  });

  it("a raw access token sent as Bearer authorizes too", async () => {
    const res = await reg.call("GET", "priv/app/manifests/latest", { headers: { authorization: `Bearer ${readKey}` } });
    expect([401, 403]).not.toContain(res.status);
  });

  it('expired JWT → 401 with error="invalid_token"', async () => {
    const old = jwt([{ type: "repository", name: "priv/app", actions: ["pull"] }], new Date(Date.now() - 3600_000));
    const res = await bearer("GET", "priv/app/manifests/latest", old);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`${REALM},scope="repository:priv/app:pull",error="invalid_token"`);
    await expect(
      identify(reg.deps, new Request("http://weaver.test/v2/", { headers: { authorization: `Bearer ${old}` } })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("a JWT signed with another key → 401 invalid_token", async () => {
    const forged = signToken(Buffer.alloc(32, 1), {
      iss: "weaver",
      aud: "weaver.test",
      sub: "anonymous",
      iat: Math.floor(Date.now() / 1000),
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: "x",
      access: [{ type: "repository", name: "priv/app", actions: ["pull", "push"] }],
      wv: { kind: "anonymous" },
    });
    const res = await bearer("GET", "priv/app/manifests/latest", forged);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("claims alone authorize: a user JWT with pull passes", async () => {
    const priv = await reg.deps.repos.get("priv");
    const t = jwt([{ type: "repository", name: "priv/app", actions: ["pull"], repo: priv!.id }], new Date(), {
      kind: "user",
      userId: "u1",
      role: "viewer",
    });
    const caller = await identify(reg.deps, new Request("http://weaver.test/v2/", { headers: { authorization: `Bearer ${t}` } }));
    expect(caller.principal).toEqual({ kind: "user", userId: "u1", role: "viewer" });
    expect(caller.claims?.sub).toBe("u1");
    const tg = await target("priv/app");
    expect(() => requireAccess(reg.deps, caller, tg, "pull")).not.toThrow();
    expect(() => requireAccess(reg.deps, caller, tg, "delete")).toThrow(expect.objectContaining({ status: 403 }) as Error);
  });

  it("GET /v2/ accepts a valid anonymous JWT and rejects an invalid one", async () => {
    const t = await tokenFrom("service=weaver.test");
    const ok = await bearer("GET", "", t);
    expect(ok.status).toBe(200);
    const bad = await bearer("GET", "", `${t}x`);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toBe(`${REALM},error="invalid_token"`);
  });

  it("an anonymous caller cannot probe repository names through NAME_INVALID", async () => {
    const anon = await reg.call("GET", "priv/manifests/latest");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(`${REALM},scope="repository:priv:pull"`);
    const authed = await reg.call("GET", "priv/manifests/latest", { token: readKey });
    expect(authed.status).toBe(400);
    expect(await codeOf(authed)).toBe("NAME_INVALID");
  });

  it("an anonymous caller on an unknown name gets the challenge with scope", async () => {
    const res = await reg.call("GET", "nope/app/manifests/latest");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`${REALM},scope="repository:nope/app:pull"`);
  });

  it("invalid_request maps to 400 and payload_too_large to 413", async () => {
    for (const [code, status] of [
      ["invalid_request", 400],
      ["payload_too_large", 413],
    ] as const) {
      const handler = createDockerHandlerWith(
        { ...reg.deps, principal: () => Promise.reject(new RegistryError(code, "nope")) },
        { uploadDir: "unused" },
      );
      const res = await handler(new Request("http://weaver.test/v2/priv/app/manifests/latest"), "priv/app/manifests/latest");
      expect(res.status).toBe(status);
      expect(res.headers.get("content-type")).toBe("application/json");
    }
  });
});

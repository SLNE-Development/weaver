import { randomUUID } from "node:crypto";
import { encryptSecret } from "@weaver/core";
import { apikey, auditEvent, npmLoginSession, user } from "@weaver/db";
import { and, eq, gt, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./test/harness.js";
import {
  hashPollSecret,
  LOGIN_SESSION_TTL_MS,
  MAX_PENDING_LOGINS,
  MAX_PENDING_LOGINS_PER_IP,
  requestIp,
  sanitizeUserAgent,
  sweepLoginSessions,
} from "./login.js";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await h.createRepo({ name: "npm-hosted", format: "npm", kind: "hosted", visibility: "private" });
  await h.db.insert(user).values([
    { id: "user-admin", name: "Ada Admin", email: "admin@example.com" },
    { id: "user-writer", name: "writer", email: "writer@example.com" },
  ]);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Inserts a bare API key row owned by `userId` and returns its id. */
async function insertKey(userId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await h.db.insert(apikey).values({ id, referenceId: userId, key: `hash-${id}`, createdAt: now, updatedAt: now });
  return id;
}

/** Starts a web login on `npm-hosted` (optionally from `ip`) and returns the session id and the poll secret. */
async function startLogin(ip?: string): Promise<{ id: string; secret: string; loginUrl: string; doneUrl: string }> {
  const headers = ip ? { "x-forwarded-for": ip } : undefined;
  const res = await h.call("POST", "npm-hosted/-/v1/login", { json: { hostname: "laptop" }, headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { loginUrl: string; doneUrl: string };
  const id = body.loginUrl.split("/").pop()!;
  const secret = body.doneUrl.split("/").pop()!;
  return { id, secret, ...body };
}

/** Polls the `doneUrl` of a session by its secret. */
function poll(secret: string): Promise<Response> {
  return h.call("GET", `npm-hosted/-/v1/login/done/${secret}`);
}

describe("npm whoami", () => {
  it("whoami returns the token owner's name", async () => {
    const res = await h.call("GET", "npm-hosted/-/whoami", { token: h.tokens.writer });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "writer" });
    const session = await h.call("GET", "npm-hosted/-/whoami", { token: h.tokens.admin });
    expect(await session.json()).toEqual({ username: "Ada Admin" });
  });

  it("whoami anonymous is 401", async () => {
    const res = await h.call("GET", "npm-hosted/-/whoami");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Weaver"');
  });
});

describe("npm web login", () => {
  it("web login round trip", async () => {
    const { id, secret, loginUrl, doneUrl } = await startLogin();
    expect(loginUrl.startsWith("https://weaver.slne.dev/cli-login/")).toBe(true);
    expect(doneUrl).toBe(`https://weaver.slne.dev/npm/npm-hosted/-/v1/login/done/${secret}`);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const pending = await poll(secret);
    expect(pending.status).toBe(202);
    expect(pending.headers.get("retry-after")).toBe("2");
    expect(await pending.json()).toEqual({});

    await h.db
      .update(npmLoginSession)
      .set({ status: "approved", userId: "user-writer", tokenCiphertext: encryptSecret(h.deps.secretKey, "wv_tok") })
      .where(eq(npmLoginSession.id, id));
    const done = await poll(secret);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ token: "wv_tok" });

    const again = await poll(secret);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "login session not found or expired" });
  });

  it("denied login is 403 and removed", async () => {
    const { id, secret } = await startLogin();
    await h.db.update(npmLoginSession).set({ status: "denied" }).where(eq(npmLoginSession.id, id));
    const res = await poll(secret);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "login was denied" });
    expect(await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id))).toEqual([]);
  });

  it("expired session is 404", async () => {
    const { id, secret } = await startLogin();
    const [row] = await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThan(LOGIN_SESSION_TTL_MS - 5_000);
    expect(row!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(LOGIN_SESSION_TTL_MS);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const res = await poll(secret);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "login session not found or expired" });
  });

  it("records the requesting client's address and user agent", async () => {
    const res = await h.call("POST", "npm-hosted/-/v1/login", {
      json: {},
      headers: { "x-forwarded-for": "10.0.0.1, 203.0.113.5", "user-agent": "npm/10.8.0 node/v22.0.0 linux x64" },
    });
    const id = ((await res.json()) as { loginUrl: string }).loginUrl.split("/").pop()!;
    const [row] = await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.requesterIp).toBe("203.0.113.5");
    expect(row!.requesterUserAgent).toBe("npm/10.8.0 node/v22.0.0 linux x64");
  });

  it("strips control and format characters from the stored user agent", async () => {
    const res = await h.call("POST", "npm-hosted/-/v1/login", {
      json: {},
      headers: { "user-agent": "npm/10\u0007\u00AD node\u0085" },
    });
    const id = ((await res.json()) as { loginUrl: string }).loginUrl.split("/").pop()!;
    const [row] = await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.requesterUserAgent).toBe("npm/10 node");
  });

  it("sanitizeUserAgent removes bidi overrides and isolates", () => {
    expect(sanitizeUserAgent("npm/10\u202Egnp\u2066x\u2069\u200B")).toBe("npm/10gnpx");
    expect(sanitizeUserAgent("\u202E")).toBeNull();
    expect(sanitizeUserAgent(null)).toBeNull();
  });

  it("requestIp takes the rightmost x-forwarded-for entry", () => {
    expect(requestIp(new Headers({ "x-forwarded-for": "10.0.0.1 , 198.51.100.7 " }))).toBe("198.51.100.7");
    expect(requestIp(new Headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.7" }))).toBe("198.51.100.7");
    expect(requestIp(new Headers())).toBeNull();
  });

  it("caps pending logins per client address", async () => {
    for (let i = 0; i < MAX_PENDING_LOGINS_PER_IP; i++) await startLogin("192.0.2.77");
    const res = await h.call("POST", "npm-hosted/-/v1/login", { json: {}, headers: { "x-forwarded-for": "192.0.2.77" } });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too many pending logins; try again later" });
    expect(res.headers.get("retry-after")).toBe("60");
    await startLogin("192.0.2.78");
  });

  it("caps pending logins globally", async () => {
    const [repoRow] = await h.db.select({ id: npmLoginSession.repositoryId }).from(npmLoginSession).limit(1);
    const live = await h.db.$count(npmLoginSession, gt(npmLoginSession.expiresAt, new Date()));
    const fill = Array.from({ length: MAX_PENDING_LOGINS - live }, () => ({
      id: `fill-${randomUUID()}`,
      pollHash: hashPollSecret(randomUUID()),
      repositoryId: repoRow!.id,
      expiresAt: new Date(Date.now() + LOGIN_SESSION_TTL_MS),
    }));
    await h.db.insert(npmLoginSession).values(fill);
    try {
      const res = await h.call("POST", "npm-hosted/-/v1/login", { json: {} });
      expect(res.status).toBe(429);
    } finally {
      await h.db.delete(npmLoginSession).where(like(npmLoginSession.id, "fill-%"));
    }
    expect((await h.call("POST", "npm-hosted/-/v1/login", { json: {} })).status).toBe(200);
  });

  it("starting a login leaves expired sessions to the sweep", async () => {
    const { id } = await startLogin();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await startLogin();
    expect(await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id))).toHaveLength(1);
  });

  it("the sweep deletes expired sessions and keys nobody collected", async () => {
    const now = new Date();
    const keyId = await insertKey("user-writer");
    const keep = await insertKey("user-writer");
    const [repoRow] = await h.db.select({ id: npmLoginSession.repositoryId }).from(npmLoginSession).limit(1);
    const row = (id: string, expiresAt: Date, extra: Partial<typeof npmLoginSession.$inferInsert> = {}) => ({
      id,
      pollHash: hashPollSecret(randomUUID()),
      repositoryId: repoRow!.id,
      expiresAt,
      ...extra,
    });
    const approved = { status: "approved" as const, userId: "user-writer", tokenCiphertext: "x" };
    await h.db.insert(npmLoginSession).values([
      row("sweep-approved", new Date(now.getTime() - 1_000), { ...approved, apiKeyId: keyId }),
      row("sweep-pending", new Date(now.getTime() - 1_000)),
      row("sweep-live", new Date(now.getTime() + 60_000), { ...approved, apiKeyId: keep }),
    ]);
    const result = await sweepLoginSessions(h.db, now);
    expect(result.keys).toBe(1);
    expect(result.sessions).toBeGreaterThanOrEqual(2);
    const left = (await h.db.select({ id: npmLoginSession.id }).from(npmLoginSession)).map((r) => r.id);
    expect(left).toContain("sweep-live");
    expect(left).not.toContain("sweep-approved");
    expect(left).not.toContain("sweep-pending");
    expect(await h.db.select().from(apikey).where(eq(apikey.id, keyId))).toEqual([]);
    expect(await h.db.select().from(apikey).where(eq(apikey.id, keep))).toHaveLength(1);
    const audit = await h.db.select().from(auditEvent).where(and(eq(auditEvent.action, "key.revoke"), eq(auditEvent.target, keyId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe("system");
  });

  it("polling an expired approved session deletes its key", async () => {
    const { id, secret } = await startLogin();
    const keyId = await insertKey("user-writer");
    await h.db
      .update(npmLoginSession)
      .set({ status: "approved", userId: "user-writer", apiKeyId: keyId, tokenCiphertext: encryptSecret(h.deps.secretKey, "wv_tok") })
      .where(eq(npmLoginSession.id, id));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await poll(secret)).status).toBe(404);
    expect(await h.db.select().from(apikey).where(eq(apikey.id, keyId))).toEqual([]);
  });

  it("poll secret is not stored in plain text", async () => {
    const { id, secret } = await startLogin();
    const [row] = await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.pollHash).not.toBe(secret);
    expect(row!.pollHash).toBe(hashPollSecret(secret));
    expect(row!.pollHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.status).toBe("pending");
    expect(row!.tokenCiphertext).toBeNull();
  });

  it("login only accepts POST", async () => {
    const res = await h.call("GET", "npm-hosted/-/v1/login");
    expect(res.status).toBe(405);
  });
});

describe("npm legacy login", () => {
  it("legacy login accepts a token as password", async () => {
    const res = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", {
      json: { _id: "org.couchdb.user:writer", name: "writer", password: h.tokens.writer, type: "user", roles: [] },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: "org.couchdb.user:writer", token: h.tokens.writer });
  });

  it("legacy login rejects a non-token password with 401", async () => {
    const wrong = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", { json: { name: "writer", password: "hunter2" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "use a Weaver access token as the password" });
    const session = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", { json: { name: "writer", password: h.tokens.admin } });
    expect(session.status).toBe(401);
    const missing = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", { json: { name: "writer" } });
    expect(missing.status).toBe(401);
  });

  it("legacy login rejects passwords with spaces or non-ASCII before resolving them", async () => {
    const spy = vi.spyOn(h.deps, "principal");
    try {
      for (const password of ["tok writer", "tök", "tok\twriter", "tok\r\nx-evil: 1"]) {
        const res = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", { json: { name: "writer", password } });
        expect(res.status).toBe(401);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("legacy login answers 400 on bad JSON and 413 on a huge body", async () => {
    const bad = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", {
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid JSON body" });
    const huge = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", {
      json: { name: "writer", password: h.tokens.writer, pad: "x".repeat(70 * 1024) },
    });
    expect(huge.status).toBe(413);
  });
});

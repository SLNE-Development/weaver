import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { GenericEndpointContext } from "better-auth";
import { invite, user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { generateInviteToken, hashInviteToken, serializeInviteCookie } from "./invite";
import { INVITE_REQUIRED_MESSAGE, createUserGate } from "./user-gate";

const SECRET = "gate-secret-gate-secret-gate-secret-01";

let testDb: Awaited<ReturnType<typeof startTestDb>>;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await db.delete(invite);
  await db.delete(user);
});

/** Creates an invite and returns the cookie header a browser would send after `/invite/<token>`. */
async function createInvite(opts: { role?: string; expiresAt?: Date; usedAt?: Date } = {}) {
  const token = generateInviteToken();
  const [row] = await db
    .insert(invite)
    .values({
      tokenHash: hashInviteToken(token),
      role: opts.role ?? "maintainer",
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
      usedAt: opts.usedAt ?? null,
    })
    .returning();
  const setCookie = serializeInviteCookie(token, { secret: SECRET, secure: false });
  return { row: row!, cookie: setCookie.split(";")[0]! };
}

/**
 * Runs one OAuth user creation the way Better Auth does: `validateUserInfo` with the
 * `create-user` action, the `user.create.before` hook, the insert, then the `after` hook.
 */
async function provision(
  gate: ReturnType<typeof createUserGate>,
  opts: { providerId: string; profile: Record<string, unknown>; cookie?: string },
) {
  const ctx = { headers: new Headers(opts.cookie ? { cookie: opts.cookie } : {}) } as unknown as GenericEndpointContext;
  const now = new Date();
  const data = { name: "New User", email: `${randomUUID()}@example.com`, emailVerified: true, createdAt: now, updatedAt: now };
  const verdict = await gate.validateUserInfo(
    { user: data, source: { action: "create-user", method: "oauth", oauth: { providerId: opts.providerId, profile: opts.profile } } },
    ctx,
  );
  if (verdict) return { refused: verdict };
  const hooked = await gate.databaseHooks.user.create.before({ ...data, id: randomUUID() }, ctx);
  const row = { ...data, id: randomUUID(), ...(typeof hooked === "object" ? hooked.data : {}) };
  const [created] = await db.insert(user).values(row).returning();
  await gate.databaseHooks.user.create.after(created!, ctx);
  return { user: created! };
}

describe("user creation gate", () => {
  it("refuses without an invite", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: undefined, secureCookies: false });
    const result = await provision(gate, { providerId: "github", profile: { login: "someone", id: 1 } });
    expect(result.refused).toEqual({ error: "invite_required", errorDescription: INVITE_REQUIRED_MESSAGE });
  });

  it("allows a valid invite, assigns its role and marks it used", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: undefined, secureCookies: false });
    const { row, cookie } = await createInvite({ role: "maintainer" });
    const result = await provision(gate, { providerId: "github", profile: { login: "someone", id: 1 }, cookie });
    expect(result.user?.role).toBe("maintainer");
    const [used] = await db.select().from(invite).where(eq(invite.id, row.id));
    expect(used?.usedAt).toBeInstanceOf(Date);
    expect(used?.usedByUserId).toBe(result.user?.id);
  });

  it("refuses an expired invite", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: undefined, secureCookies: false });
    const { cookie } = await createInvite({ expiresAt: new Date(Date.now() - 1000) });
    const result = await provision(gate, { providerId: "discord", profile: { id: "123" }, cookie });
    expect(result.refused?.error).toBe("invite_required");
  });

  it("refuses a used invite, including a second sign-up with the same link", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: undefined, secureCookies: false });
    const { cookie: usedCookie } = await createInvite({ usedAt: new Date() });
    expect((await provision(gate, { providerId: "discord", profile: { id: "1" }, cookie: usedCookie })).refused?.error).toBe(
      "invite_required",
    );

    const { cookie } = await createInvite();
    expect((await provision(gate, { providerId: "discord", profile: { id: "2" }, cookie })).user).toBeDefined();
    expect((await provision(gate, { providerId: "discord", profile: { id: "3" }, cookie })).refused?.error).toBe(
      "invite_required",
    );
  });

  it("refuses an invite cookie signed with another secret", async () => {
    const gate = createUserGate({ db, secret: "another-secret-another-secret-another", initialAdmin: undefined, secureCookies: false });
    const { cookie } = await createInvite();
    expect((await provision(gate, { providerId: "github", profile: { login: "x" }, cookie })).refused?.error).toBe(
      "invite_required",
    );
  });

  it("lets INITIAL_ADMIN create the first admin, matching the GitHub login case-insensitively", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: "github:octo", secureCookies: false });
    const result = await provision(gate, { providerId: "github", profile: { login: "Octo", id: 42 } });
    expect(result.user?.role).toBe("admin");
  });

  it("matches a Discord INITIAL_ADMIN by numeric user id", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: "discord:80351110224678912", secureCookies: false });
    const wrong = await provision(gate, { providerId: "discord", profile: { id: "80351110224678913", username: "x" } });
    expect(wrong.refused?.error).toBe("invite_required");
    const right = await provision(gate, { providerId: "discord", profile: { id: "80351110224678912", username: "x" } });
    expect(right.user?.role).toBe("admin");
  });

  it("is inert once an admin exists", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: "github:octo", secureCookies: false });
    expect((await provision(gate, { providerId: "github", profile: { login: "Octo" } })).user?.role).toBe("admin");
    const again = await provision(gate, { providerId: "github", profile: { login: "octo" } });
    expect(again.refused?.error).toBe("invite_required");
  });

  it("refuses a provider account that does not match INITIAL_ADMIN", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: "github:other", secureCookies: false });
    expect((await provision(gate, { providerId: "github", profile: { login: "octo" } })).refused?.error).toBe("invite_required");
    // Same login on another provider does not match either.
    const crossProvider = createUserGate({ db, secret: SECRET, initialAdmin: "github:octo", secureCookies: false });
    expect((await provision(crossProvider, { providerId: "discord", profile: { id: "1", username: "octo" } })).refused?.error).toBe(
      "invite_required",
    );
  });

  it("refuses user creation through any non-OAuth method, such as the admin API", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: undefined, secureCookies: false });
    const ctx = { headers: new Headers() } as unknown as GenericEndpointContext;
    const verdict = await gate.validateUserInfo(
      { user: { email: "a@example.com" }, source: { action: "create-user", method: "admin" } },
      ctx,
    );
    expect(verdict?.error).toBe("invite_required");
  });

  it("refuses creation when the before hook runs without a gate decision", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: "github:octo", secureCookies: false });
    const now = new Date();
    const data = { id: "u1", name: "x", email: "x@example.com", emailVerified: true, createdAt: now, updatedAt: now };
    await expect(gate.databaseHooks.user.create.before(data, null)).rejects.toThrow(INVITE_REQUIRED_MESSAGE);
  });

  it("stores only known invite roles (database check constraint)", async () => {
    await expect(createInvite({ role: "owner" })).rejects.toThrow();
  });

  it("treats a comma-separated role list containing admin as an existing admin", async () => {
    const now = new Date();
    await db.insert(user).values({ id: randomUUID(), name: "a", email: "a@example.com", role: "maintainer, admin", createdAt: now, updatedAt: now });
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: "github:octo", secureCookies: false });
    expect((await provision(gate, { providerId: "github", profile: { login: "octo" } })).refused?.error).toBe("invite_required");
  });

  it("does not gate sign-in or account linking of existing users", async () => {
    const gate = createUserGate({ db, secret: SECRET, initialAdmin: undefined, secureCookies: false });
    const ctx = { headers: new Headers() } as unknown as GenericEndpointContext;
    for (const action of ["sign-in", "link-account"] as const) {
      const verdict = await gate.validateUserInfo(
        { user: { email: "a@example.com" }, source: { action, method: "oauth", oauth: { providerId: "github", profile: {} } } },
        ctx,
      );
      expect(verdict).toBeUndefined();
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runWithEndpointContext, runWithTransaction, type AuthEndpointContext } from "@better-auth/core/context";
import { account, auditEvent, invite, user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createAuth, type Auth, type AuthEnv } from "./auth";
import { INVITE_COOKIE, generateInviteToken, hashInviteToken, serializeInviteCookie } from "./invite";
import { INVITE_REQUIRED_MESSAGE } from "./user-gate";

/**
 * The gate exercised through a real Better Auth instance: user creation runs the way the OAuth
 * callback runs it (`internalAdapter.createUser` with an OAuth source, then `createAccount`, in
 * one transaction inside the endpoint context), so the `validateUserInfo` -> hooks wiring, the
 * transaction and the cookie handling are all Better Auth's own.
 */

const env: AuthEnv = {
  BETTER_AUTH_SECRET: "flow-secret-flow-secret-flow-secret-0123",
  BETTER_AUTH_URL: "https://protos.example.com",
  INITIAL_ADMIN: "github:octo",
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  DISCORD_CLIENT_ID: undefined,
  DISCORD_CLIENT_SECRET: undefined,
};

let testDb: Awaited<ReturnType<typeof startTestDb>>;
let db: Db;
let auth: Auth;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  auth = createAuth(db, env);
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  await db.delete(invite);
  await db.delete(user);
  await db.delete(auditEvent);
});

async function audits() {
  return db
    .select({
      actorType: auditEvent.actorType,
      actorId: auditEvent.actorId,
      action: auditEvent.action,
      target: auditEvent.target,
      details: auditEvent.details,
    })
    .from(auditEvent)
    .orderBy(auditEvent.at);
}

/** Runs `fn` inside a Better Auth endpoint context, the way an endpoint such as link-social does. */
async function inEndpoint<T>(fn: (authCtx: Awaited<Auth["$context"]>) => Promise<T>): Promise<T> {
  const authCtx = await auth.$context;
  const endpointCtx = { context: authCtx, headers: new Headers(), setCookie: () => "" } as unknown as AuthEndpointContext;
  return runWithEndpointContext(endpointCtx, () => fn(authCtx));
}

async function createInvite(role = "maintainer") {
  const token = generateInviteToken();
  const [row] = await db
    .insert(invite)
    .values({ tokenHash: hashInviteToken(token), role, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning();
  const cookie = serializeInviteCookie(token, { secret: env.BETTER_AUTH_SECRET, secure: true }).split(";")[0]!;
  return { row: row!, cookie };
}

interface SetCookieCall {
  name: string;
  value: string;
  options: Record<string, unknown> | undefined;
}

/** Creates a user and its GitHub/Discord account the way Better Auth's OAuth callback does. */
async function oauthSignUp(opts: {
  providerId: "github" | "discord";
  profile: Record<string, unknown>;
  cookie?: string;
  failAccountInsert?: boolean;
}) {
  const authCtx = await auth.$context;
  const setCookies: SetCookieCall[] = [];
  const endpointCtx = {
    context: authCtx,
    headers: new Headers(opts.cookie ? { cookie: opts.cookie } : {}),
    setCookie: (name: string, value: string, options?: Record<string, unknown>) => {
      setCookies.push({ name, value, options });
      return name;
    },
  } as unknown as AuthEndpointContext;
  const created = await runWithEndpointContext(endpointCtx, () =>
    runWithTransaction(authCtx.adapter, async () => {
      const createdUser = await authCtx.internalAdapter.createUser(
        { name: "New User", email: `${randomUUID()}@example.com`, emailVerified: true },
        { method: "oauth", oauth: { providerId: opts.providerId, profile: opts.profile } },
      );
      if (opts.failAccountInsert) throw new Error("account insert failed");
      await authCtx.internalAdapter.createAccount({
        userId: createdUser.id,
        providerId: opts.providerId,
        accountId: String(opts.profile.id),
      });
      return createdUser;
    }),
  );
  return { created, setCookies };
}

describe("user creation gate through Better Auth", () => {
  it("refuses the admin plugin's createUser endpoint", async () => {
    await expect(auth.api.createUser({ body: { email: "made@example.com", name: "Made", role: "viewer" } })).rejects.toThrow(
      INVITE_REQUIRED_MESSAGE,
    );
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it("creates the user with the invite's role, consumes the invite and clears the cookie", async () => {
    const { row, cookie } = await createInvite("maintainer");
    const { created, setCookies } = await oauthSignUp({ providerId: "github", profile: { id: 7, login: "someone" }, cookie });

    const [stored] = await db.select().from(user).where(eq(user.id, created.id));
    expect(stored?.role).toBe("maintainer");
    const [used] = await db.select().from(invite).where(eq(invite.id, row.id));
    expect(used?.usedAt).toBeInstanceOf(Date);
    expect(used?.usedByUserId).toBe(created.id);
    expect(await db.select().from(account).where(eq(account.userId, created.id))).toHaveLength(1);
    expect(setCookies).toContainEqual({
      name: INVITE_COOKIE,
      value: "",
      options: expect.objectContaining({ maxAge: 0, httpOnly: true, secure: true, path: "/" }),
    });
  });

  it("refuses without an invite cookie", async () => {
    await createInvite();
    await expect(oauthSignUp({ providerId: "github", profile: { id: 8, login: "someone" } })).rejects.toThrow(
      INVITE_REQUIRED_MESSAGE,
    );
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it("leaves the invite unused when the account insert fails", async () => {
    const { row, cookie } = await createInvite();
    await expect(
      oauthSignUp({ providerId: "github", profile: { id: 9, login: "someone" }, cookie, failAccountInsert: true }),
    ).rejects.toThrow("account insert failed");

    expect(await db.select().from(user)).toHaveLength(0);
    const [unused] = await db.select().from(invite).where(eq(invite.id, row.id));
    expect(unused?.usedAt).toBeNull();

    // The same link still works afterwards.
    const { created } = await oauthSignUp({ providerId: "github", profile: { id: 9, login: "someone" }, cookie });
    expect(created.id).toBeTruthy();
  });

  it("creates the first admin from INITIAL_ADMIN, then refuses the same account without an invite", async () => {
    const { created } = await oauthSignUp({ providerId: "github", profile: { id: 10, login: "Octo" } });
    const [stored] = await db.select().from(user).where(eq(user.id, created.id));
    expect(stored?.role).toBe("admin");

    await expect(oauthSignUp({ providerId: "github", profile: { id: 11, login: "octo" } })).rejects.toThrow(
      INVITE_REQUIRED_MESSAGE,
    );
  });

  it("audits an account created through an invite as user.create", async () => {
    const { row, cookie } = await createInvite("maintainer");
    const { created } = await oauthSignUp({ providerId: "github", profile: { id: 13, login: "someone" }, cookie });
    expect(await audits()).toEqual([
      {
        actorType: "user",
        actorId: created.id,
        action: "user.create",
        target: created.id,
        details: { role: "maintainer", source: "invite", inviteId: row.id, provider: "github" },
      },
    ]);
  });

  it("audits the first admin as user.create with source initial-admin", async () => {
    const { created } = await oauthSignUp({ providerId: "github", profile: { id: 14, login: "octo" } });
    expect(await audits()).toEqual([
      {
        actorType: "user",
        actorId: created.id,
        action: "user.create",
        target: created.id,
        details: { role: "admin", source: "initial-admin", provider: "github" },
      },
    ]);
  });

  it("audits linking and unlinking a provider, but not the account created with the user", async () => {
    const { cookie } = await createInvite("viewer");
    const { created } = await oauthSignUp({ providerId: "github", profile: { id: 15, login: "someone" }, cookie });
    await db.delete(auditEvent);

    const linked = await inEndpoint((authCtx) =>
      authCtx.internalAdapter.linkAccount({ userId: created.id, providerId: "discord", accountId: "4242" }),
    );
    await inEndpoint((authCtx) => authCtx.internalAdapter.deleteAccount(linked.id));

    expect(await audits()).toEqual([
      { actorType: "user", actorId: created.id, action: "account.link", target: created.id, details: { provider: "discord" } },
      { actorType: "user", actorId: created.id, action: "account.unlink", target: created.id, details: { provider: "discord" } },
    ]);
  });

  it("refuses an account that does not match INITIAL_ADMIN", async () => {
    await expect(oauthSignUp({ providerId: "github", profile: { id: 12, login: "other" } })).rejects.toThrow(
      INVITE_REQUIRED_MESSAGE,
    );
  });
});

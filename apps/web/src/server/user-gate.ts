import { and, eq, gt, inArray, isNull, like } from "drizzle-orm";
import type { BetterAuthOptions, GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import { recordAudit } from "@weaver/core";
import { invite, user, type Db, type Tx } from "@weaver/db";
import { INVITE_COOKIE, hashInviteToken, readInviteToken } from "./invite";
import { ROLES, effectiveRole, isRole, parseRoles } from "./roles";

/** Shown when someone without an invite tries to create an account. */
export const INVITE_REQUIRED_MESSAGE = "You need an invite to join this Weaver.";

type Decision = { provider: string } & ({ kind: "initial-admin" } | { kind: "invite"; inviteId: string });

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]>;
type UserCreateHooks = NonNullable<NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["user"]>["create"]>;

/** `INITIAL_ADMIN` split into provider and account key; `null` when unset or malformed. */
export function parseInitialAdmin(value: string | undefined): { provider: "github" | "discord"; key: string } | null {
  const match = value?.match(/^(github|discord):(.+)$/);
  if (!match) return null;
  return { provider: match[1] as "github" | "discord", key: match[2]! };
}

function refusal() {
  return { error: "invite_required", errorDescription: INVITE_REQUIRED_MESSAGE };
}

function refusalError() {
  return new APIError("FORBIDDEN", { code: "invite_required", message: INVITE_REQUIRED_MESSAGE });
}

/** A usable invite: unused, unexpired, and carrying a known role. */
function usable(...conditions: Parameters<typeof and>) {
  return and(...conditions, isNull(invite.usedAt), gt(invite.expiresAt, new Date()), inArray(invite.role, [...ROLES]));
}

export interface UserGateOptions {
  db: Db;
  /** The transaction Better Auth is creating the user in, or `db` outside of one. */
  currentDb?: () => Db | Tx;
  secret: string;
  initialAdmin: string | undefined;
  /** Whether cookies carry `Secure` (decided by `BETTER_AUTH_URL`). */
  secureCookies: boolean;
}

/**
 * The single gate every user creation passes. Better Auth calls `validateUserInfo` with the
 * `create-user` action and the raw provider profile right before it inserts a user; the gate
 * allows the insert only for
 * - the first-admin rule: no admin exists yet and the provider account equals `INITIAL_ADMIN`
 *   (GitHub login compared case-insensitively, Discord numeric user id), or
 * - a valid, unexpired, unused invite with a known role whose token arrived in this request's
 *   signed invite cookie.
 *
 * Its decision is remembered for the request's endpoint context. The `user.create.before` hook
 * then claims the invite atomically, inside Better Auth's user/account transaction (so one link
 * creates at most one user, and a failed insert leaves the invite unused), and sets the role. The
 * `after` hook, which runs once the transaction committed, records which user used the invite and
 * clears the invite cookie, and writes the `user.create` audit entry (role, source, provider). Any creation the gate did not approve, such as the admin plugin's
 * create-user endpoint, is refused. Sign-in and linking of existing users are not gated here.
 */
export function createUserGate(opts: UserGateOptions) {
  const { db, secret, secureCookies } = opts;
  const currentDb = opts.currentDb ?? (() => db);
  const initialAdmin = parseInitialAdmin(opts.initialAdmin);
  const decisions = new WeakMap<object, Decision>();

  async function adminExists(): Promise<boolean> {
    const candidates = await currentDb().select({ role: user.role }).from(user).where(like(user.role, "%admin%"));
    return candidates.some((row) => parseRoles(row.role).includes("admin"));
  }

  function matchesInitialAdmin(providerId: string, profile: Record<string, unknown> | undefined): boolean {
    if (!initialAdmin || !profile || providerId !== initialAdmin.provider) return false;
    if (initialAdmin.provider === "github") {
      return typeof profile.login === "string" && profile.login.toLowerCase() === initialAdmin.key.toLowerCase();
    }
    return String(profile.id ?? "") === initialAdmin.key;
  }

  async function findUsableInvite(ctx: GenericEndpointContext) {
    const cookieHeader = ctx.headers?.get("cookie") ?? ctx.request?.headers.get("cookie");
    const token = readInviteToken(cookieHeader, secret);
    if (!token) return null;
    const [row] = await currentDb()
      .select({ id: invite.id })
      .from(invite)
      .where(usable(eq(invite.tokenHash, hashInviteToken(token))))
      .limit(1);
    return row ?? null;
  }

  const validateUserInfo: ValidateUserInfo = async ({ source }, ctx) => {
    if (source.action !== "create-user") return;
    if (source.method !== "oauth" || !source.oauth || !ctx) return refusal();

    let decision: Decision | null = null;
    const provider = source.oauth.providerId;
    if (matchesInitialAdmin(provider, source.oauth.profile) && !(await adminExists())) {
      decision = { kind: "initial-admin", provider };
    } else {
      const found = await findUsableInvite(ctx);
      if (found) decision = { kind: "invite", inviteId: found.id, provider };
    }
    if (!decision) return refusal();
    decisions.set(ctx, decision);
  };

  const create = {
    before: async (_user, ctx) => {
      const decision = ctx ? decisions.get(ctx) : undefined;
      if (!decision) throw refusalError();
      if (decision.kind === "initial-admin") return { data: { role: "admin" } };

      const [claimed] = await currentDb()
        .update(invite)
        .set({ usedAt: new Date() })
        .where(usable(eq(invite.id, decision.inviteId)))
        .returning({ role: invite.role });
      if (!claimed || !isRole(claimed.role)) throw refusalError();
      return { data: { role: claimed.role } };
    },
    after: async (created, ctx) => {
      const decision = ctx ? decisions.get(ctx) : undefined;
      if (!ctx || !decision) return;
      decisions.delete(ctx);
      const role = effectiveRole(created.role as string | null | undefined);
      await db.transaction((tx) =>
        recordAudit(tx, {
          actor: { kind: "user", userId: created.id, role },
          action: "user.create",
          target: created.id,
          details:
            decision.kind === "invite"
              ? { role, source: "invite", inviteId: decision.inviteId, provider: decision.provider }
              : { role, source: "initial-admin", provider: decision.provider },
        }),
      );
      if (decision.kind === "invite") {
        await db.update(invite).set({ usedByUserId: created.id }).where(eq(invite.id, decision.inviteId));
        ctx.setCookie?.(INVITE_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax", secure: secureCookies });
      }
    },
  } satisfies UserCreateHooks;

  return { validateUserInfo, databaseHooks: { user: { create } } };
}

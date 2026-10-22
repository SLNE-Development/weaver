import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { account, apikey, session, user, verification, type Db } from "@weaver/db";
import { env, type Env } from "../env";
import { accountAuditHooks } from "./account-audit";
import { isSecureUrl } from "./invite";
import { trackTransactions } from "./transactions";
import { createUserGate } from "./user-gate";

/** The part of the environment the auth configuration depends on. */
export type AuthEnv = Pick<
  Env,
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_URL"
  | "INITIAL_ADMIN"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "DISCORD_CLIENT_ID"
  | "DISCORD_CLIENT_SECRET"
>;

type SocialEnv = Pick<AuthEnv, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET" | "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET">;

export type SocialProviderId = "github" | "discord";

/** Providers whose client id and secret are both configured, in display order. */
export function getEnabledSocialProviders(source: SocialEnv = env): SocialProviderId[] {
  const enabled: SocialProviderId[] = [];
  if (source.GITHUB_CLIENT_ID && source.GITHUB_CLIENT_SECRET) enabled.push("github");
  if (source.DISCORD_CLIENT_ID && source.DISCORD_CLIENT_SECRET) enabled.push("discord");
  return enabled;
}

/**
 * Per-provider options. Sign-up stays possible only through the user gate: a sign-in creates a
 * user only when the client asks for it explicitly (`requestSignUp: true`, implicit sign-up is
 * disabled) and the gate then approves it (invite or first admin).
 */
function socialProviders(source: SocialEnv) {
  const providers: {
    github?: { clientId: string; clientSecret: string; disableImplicitSignUp: true };
    discord?: { clientId: string; clientSecret: string; disableImplicitSignUp: true };
  } = {};
  if (source.GITHUB_CLIENT_ID && source.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: source.GITHUB_CLIENT_ID,
      clientSecret: source.GITHUB_CLIENT_SECRET,
      disableImplicitSignUp: true,
    };
  }
  if (source.DISCORD_CLIENT_ID && source.DISCORD_CLIENT_SECRET) {
    providers.discord = {
      clientId: source.DISCORD_CLIENT_ID,
      clientSecret: source.DISCORD_CLIENT_SECRET,
      disableImplicitSignUp: true,
    };
  }
  return providers;
}

/**
 * Better Auth endpoints reachable over HTTP (`/api/auth/*`): exactly what the browser UI calls.
 * Everything else, notably every admin-plugin (`/admin/*`) and api-key (`/api-key/*`) route,
 * is served only to the app's own server code through `auth.api.*`, behind its tRPC / REST
 * permission checks, invariants (last admin, key permissions) and audit log.
 */
const PUBLIC_AUTH_PATHS = new Set([
  "/sign-in/social",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/get-session",
  "/sign-out",
  "/error",
  "/ok",
]);

/** Whether `path` (relative to `/api/auth`) is an endpoint the UI may call over HTTP. */
export function isPublicAuthPath(path: string): boolean {
  if (PUBLIC_AUTH_PATHS.has(path)) return true;
  // OAuth provider callbacks: /callback/github, /callback/discord.
  return /^\/callback\/[a-z0-9-]+$/.test(path);
}

/** Paths of every HTTP endpoint the given plugins add (server-only endpoints have none). */
function endpointPaths(...plugins: { endpoints?: Record<string, { path?: string }> }[]): string[] {
  return plugins.flatMap((plugin) =>
    Object.values(plugin.endpoints ?? {})
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => Boolean(path)),
  );
}

/**
 * Better Auth options for Weaver: OAuth only (GitHub, Discord), no email/password, roles
 * `admin | maintainer | viewer` through the admin plugin, API keys without rate limiting (Gradle
 * builds must not be throttled), user creation behind the invite / first-admin gate, and account
 * linking only explicitly through `linkSocial` while signed in. The admin and api-key plugin
 * routes are disabled over HTTP (`disabledPaths`); the server calls them through `auth.api`.
 */
export function buildAuthOptions(db: Db, source: AuthEnv = env) {
  const adminPlugin = admin({
    roles: { admin: adminAc, maintainer: userAc, viewer: userAc },
    defaultRole: "viewer",
    adminRoles: ["admin"],
  });
  const apiKeyPlugin = apiKey({ rateLimit: { enabled: false }, enableMetadata: true });
  // Better Auth creates a user and its account in one transaction; the gate claims invites in it.
  const tracked = trackTransactions(db);
  const gate = createUserGate({
    db,
    currentDb: tracked.current,
    secret: source.BETTER_AUTH_SECRET,
    initialAdmin: source.INITIAL_ADMIN,
    secureCookies: isSecureUrl(source.BETTER_AUTH_URL),
  });
  return {
    secret: source.BETTER_AUTH_SECRET,
    // BETTER_AUTH_URL is the only source of the public URL: behind the proxy / tunnel requests
    // arrive over plain http, so nothing is derived from the Host or X-Forwarded-* headers.
    baseURL: source.BETTER_AUTH_URL,
    trustedOrigins: [new URL(source.BETTER_AUTH_URL).origin],
    advanced: {
      useSecureCookies: isSecureUrl(source.BETTER_AUTH_URL),
      trustedProxyHeaders: false,
    },
    database: drizzleAdapter(tracked.db, {
      provider: "pg",
      schema: { user, session, account, verification, apikey },
      transaction: true,
    }),
    socialProviders: socialProviders(source),
    user: { validateUserInfo: gate.validateUserInfo },
    databaseHooks: { ...gate.databaseHooks, account: accountAuditHooks(db) },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        trustedProviders: [],
        allowDifferentEmails: true,
        allowUnlinkingAll: false,
      },
    },
    disabledPaths: endpointPaths(adminPlugin, apiKeyPlugin),
    plugins: [adminPlugin, apiKeyPlugin, nextCookies()],
  } satisfies BetterAuthOptions;
}

/** A Better Auth instance bound to `db`. */
export function createAuth(db: Db, source: AuthEnv = env) {
  return betterAuth(buildAuthOptions(db, source));
}

export type Auth = ReturnType<typeof createAuth>;

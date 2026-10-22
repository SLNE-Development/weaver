/** Seeds an e2e stack from a JSON spec: the e2e admin, a session, repositories and API keys. */
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, ne } from "drizzle-orm";
import type { CreateRepoInput, Principal, RepoService, UpstreamInput } from "@weaver/core";
import { repoPermission, repository, session, user, type Db } from "@weaver/db";
import { API_KEY_PREFIX } from "../server/api-keys";
import { signSessionCookie } from "./session-cookie";

/** Email of the only user an e2e database may contain. */
export const E2E_ADMIN_EMAIL = "e2e-admin@weaver.invalid";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** An upstream of a seeded mirror; `usernameEnv`/`secretEnv` name environment variables holding the credentials. */
export interface SeedUpstream extends UpstreamInput {
  usernameEnv?: string;
  secretEnv?: string;
}

/** A repository of a seed spec, created through {@link RepoService.create}. */
export interface SeedRepo extends Omit<CreateRepoInput, "upstreams"> {
  upstreams?: SeedUpstream[];
}

/** What to seed: repositories in creation order and API keys by name with their permissions. */
export interface SeedSpec {
  repos: SeedRepo[];
  tokens: Record<string, Array<{ repository: string; access: "read" | "write" }>>;
}

/** What a seed run produced: the admin's id, a signed session cookie value and the key secrets by name. */
export interface SeedResult {
  adminUserId: string;
  sessionCookie: string;
  tokens: Record<string, string>;
}

/** The part of Better Auth the seed needs: creating API keys. */
export interface SeedAuth {
  api: {
    createApiKey(ctx: {
      body: { userId: string; name: string; prefix: string; expiresIn: number | null };
    }): Promise<{ id: string; key: string }>;
  };
}

/** The upstream `input` with credentials read from `env`; an empty or unset `secretEnv` means no auth. */
function resolveUpstream(input: SeedUpstream, env: NodeJS.ProcessEnv): UpstreamInput {
  const { usernameEnv, secretEnv, ...upstream } = input;
  if (usernameEnv !== undefined) upstream.username = env[usernameEnv] || null;
  if (secretEnv !== undefined) {
    const secret = env[secretEnv];
    if (!secret) return { url: upstream.url, authType: "none", username: null, secret: null };
    upstream.secret = secret;
  }
  return upstream;
}

/**
 * Creates the e2e admin (once), a fresh session, the spec's repositories in order (repositories that
 * already exist with the same format and kind are kept) and one new API key per token with exactly
 * the listed permissions. Rejects a database that has any other user.
 */
export async function applySeedSpec(
  deps: { db: Db; repos: RepoService; auth: SeedAuth; secret: string },
  spec: SeedSpec,
  env: NodeJS.ProcessEnv,
): Promise<SeedResult> {
  const { db, repos, auth, secret } = deps;
  const [other] = await db.select({ id: user.id }).from(user).where(ne(user.email, E2E_ADMIN_EMAIL)).limit(1);
  if (other) throw new Error("database has users other than the e2e admin");

  let [admin] = await db.select({ id: user.id }).from(user).where(eq(user.email, E2E_ADMIN_EMAIL));
  if (!admin) {
    [admin] = await db
      .insert(user)
      .values({ id: randomUUID(), name: "E2E Admin", email: E2E_ADMIN_EMAIL, emailVerified: true, role: "admin" })
      .returning({ id: user.id });
  }
  const adminUserId = admin!.id;
  const actor: Principal = { kind: "user", userId: adminUserId, role: "admin" };

  const token = randomBytes(24).toString("base64url");
  await db.insert(session).values({
    id: randomUUID(),
    token,
    userId: adminUserId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });

  for (const { upstreams, ...input } of spec.repos) {
    const existing = await repos.get(input.name);
    if (existing) {
      if (existing.format !== input.format || existing.kind !== input.kind) {
        throw new Error(`repository ${input.name} exists as ${existing.format} ${existing.kind}`);
      }
      continue;
    }
    await repos.create(actor, {
      ...input,
      ...(upstreams ? { upstreams: upstreams.map((u) => resolveUpstream(u, env)) } : {}),
    });
  }

  const names = [...new Set(Object.values(spec.tokens).flatMap((entries) => entries.map((e) => e.repository)))];
  const ids = new Map(
    names.length === 0
      ? []
      : (
          await db.select({ id: repository.id, name: repository.name }).from(repository).where(inArray(repository.name, names))
        ).map((r) => [r.name, r.id]),
  );
  const unknown = names.filter((name) => !ids.has(name));
  if (unknown.length > 0) throw new Error(`tokens name unknown repositories: ${unknown.join(", ")}`);

  const tokens: Record<string, string> = {};
  for (const [name, entries] of Object.entries(spec.tokens)) {
    const created = await auth.api.createApiKey({
      body: { userId: adminUserId, name: `e2e-${name}`, prefix: API_KEY_PREFIX, expiresIn: null },
    });
    if (entries.length > 0) {
      await db.insert(repoPermission).values(
        entries.map((e) => ({ apiKeyId: created.id, repositoryId: ids.get(e.repository)!, groupPrefix: null, access: e.access })),
      );
    }
    tokens[name] = created.key;
  }

  return { adminUserId, sessionCookie: await signSessionCookie(secret, token), tokens };
}

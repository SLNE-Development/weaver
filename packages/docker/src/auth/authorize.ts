import {
  RegistryError,
  canAccess,
  canReadThroughGroup,
  type FormatDeps,
  type Principal,
  type Repo,
} from "@weaver/core";
import { DockerError } from "../errors.js";
import type { Target } from "../target.js";
import { looksLikeJwt, tokenKey, verifyToken, type DockerAction, type DockerClaims } from "./jwt.js";

/** Who is making a docker request: the principal, and the verified token claims when a JWT was sent. */
export interface Caller {
  principal: Principal;
  /** The claims of the bearer JWT, or null when the caller sent no JWT (anonymous or a raw access token). */
  claims: DockerClaims | null;
}

/** Options of a 401 challenge beyond realm and service. */
export interface ChallengeOptions {
  /** The scope the client should request, e.g. `repository:a/b:pull`. */
  scope?: string;
  /** Why a sent token was not enough. */
  error?: "insufficient_scope" | "invalid_token";
}

/** The registry host, used as the token service name and audience. */
export function serviceHost(publicUrl: string): string {
  return new URL(publicUrl).host;
}

/** The 401 `UNAUTHORIZED` error telling a client where and for which scope to fetch a bearer token. */
export function challenge(publicUrl: string, opts: ChallengeOptions = {}): DockerError {
  let header = `Bearer realm="${publicUrl}/v2/token",service="${serviceHost(publicUrl)}"`;
  if (opts.scope) header += `,scope="${opts.scope}"`;
  if (opts.error) header += `,error="${opts.error}"`;
  return new DockerError(401, "UNAUTHORIZED", "authentication required", undefined, { "www-authenticate": header });
}

/** The scope string a client needs for `action` on `name`; push implies pull, as docker requests it. */
export function scopeFor(name: string, action: DockerAction): string {
  return `repository:${name}:${action === "push" ? "pull,push" : action}`;
}

/** Whether `p` may perform `action` on `repo`: pull needs read (through a group, read of the group); push and delete need write on a hosted repo. */
export function permits(p: Principal, repo: Repo, action: DockerAction): boolean {
  if (action === "pull") return repo.kind === "group" ? canReadThroughGroup(p, repo) : canAccess(p, repo, "", "read");
  return repo.kind === "hosted" && canAccess(p, repo, "", "write");
}

function principalOf(claims: DockerClaims): Principal {
  const { kind, userId, keyId, role } = claims.wv;
  if (kind === "user" && userId && role) return { kind: "user", userId, role };
  if (kind === "apikey" && userId && keyId && role) return { kind: "apikey", keyId, userId, role, permissions: [] };
  return { kind: "anonymous" };
}

/**
 * Resolves the caller from a bearer JWT issued by the token endpoint, or else through `deps.principal`
 * (Basic or Bearer raw access token, session, or anonymous). Throws a 401 challenge with
 * `error="invalid_token"` for an invalid or expired JWT, and a plain challenge for bad credentials.
 */
export async function identify(
  deps: FormatDeps,
  req: Request,
  opts: { now?: Date; scope?: string } = {},
): Promise<Caller> {
  const header = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (bearer && looksLikeJwt(bearer[1]!)) {
    const claims = verifyToken(tokenKey(deps.secretKey), bearer[1]!, serviceHost(deps.publicUrl), opts.now ?? new Date());
    if (!claims) throw challenge(deps.publicUrl, { scope: opts.scope, error: "invalid_token" });
    return { principal: principalOf(claims), claims };
  }
  try {
    return { principal: await deps.principal(req), claims: null };
  } catch (err) {
    if (err instanceof RegistryError && err.code === "unauthorized") {
      throw challenge(deps.publicUrl, { scope: opts.scope });
    }
    throw err;
  }
}

/** The 401 challenge for `scope`, flagged `insufficient_scope` when the caller already sent a JWT. */
export function scopeChallenge(deps: FormatDeps, caller: Caller, scope: string): DockerError {
  return challenge(deps.publicUrl, { scope, error: caller.claims ? "insufficient_scope" : undefined });
}

/**
 * Checks that the caller may perform `action` on the target, from the JWT claims alone when one was
 * sent, otherwise from the principal. A JWT entry counts only when its name matches and it is bound to
 * the target's repository id. A JWT without such an entry gets a 401 `insufficient_scope` challenge (so
 * the client fetches a token for the scope); otherwise anonymous callers get a 401 challenge and
 * authenticated ones `403 DENIED`. Writes to a mirror or group are `405 UNSUPPORTED` (anonymous callers
 * that cannot read the repository are challenged instead, so they do not learn its kind).
 */
export function requireAccess(deps: FormatDeps, caller: Caller, target: Target, action: DockerAction): void {
  const scope = scopeFor(target.name, action);
  const anonymous = caller.principal.kind === "anonymous";
  const entry = caller.claims?.access.find(
    (e) => e.type === "repository" && e.name === target.name && e.repo === target.repo.id,
  );
  const has = (a: DockerAction): boolean =>
    caller.claims ? (entry?.actions.includes(a) ?? false) : permits(caller.principal, target.repo, a);

  if (action !== "pull" && target.repo.kind !== "hosted") {
    if (anonymous && !has("pull")) throw scopeChallenge(deps, caller, scope);
    throw new DockerError(405, "UNSUPPORTED", `${target.repo.name} is a ${target.repo.kind} repository and read-only`, {
      name: target.name,
    });
  }
  if (has(action)) return;
  if (anonymous || (caller.claims && !entry)) throw scopeChallenge(deps, caller, scope);
  throw new DockerError(403, "DENIED", "requested access to the resource is denied", { name: target.name });
}

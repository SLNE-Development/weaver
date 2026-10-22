import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, recordAudit, RegistryError, type FormatDeps, type Repo } from "@weaver/core";
import { apikey, npmLoginSession, user, type Db } from "@weaver/db";
import { and, eq, gt, inArray, lte, type SQL } from "drizzle-orm";
import { readBody } from "./hosted.js";
import { BASIC_CHALLENGE, npmError, npmJson } from "./http.js";

/** How long a browser login session stays valid after `POST /-/v1/login`: 10 minutes. */
export const LOGIN_SESSION_TTL_MS = 600_000;

/** Upper bound of unexpired login sessions across the server; further `POST /-/v1/login` calls get 429. */
export const MAX_PENDING_LOGINS = 1000;

/** Upper bound of pending, unexpired login sessions started from one client address. */
export const MAX_PENDING_LOGINS_PER_IP = 10;

/** Largest legacy login body read (64 KiB); larger bodies get 413. */
const LEGACY_BODY_LIMIT = 64 * 1024;

/** A legacy login password that could be a Weaver token: printable ASCII without spaces. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

/** Longest stored requester user agent; longer values are cut. */
const USER_AGENT_MAX = 512;

const NOT_FOUND = "login session not found or expired";
const LEGACY_REJECTED = "use a Weaver access token as the password";

/** The 401 answer of a legacy login whose password is not a Weaver API key. */
function rejectLegacy(): Response {
  return npmError(401, LEGACY_REJECTED, { "www-authenticate": BASIC_CHALLENGE });
}

/** The 429 answer when too many logins are pending. */
function tooManyLogins(): Response {
  return npmError(429, "too many pending logins; try again later", { "retry-after": "60" });
}

/** The hex SHA-256 of a poll secret, the only form in which it is stored. */
export function hashPollSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A fresh random 32-byte value, base64url-encoded. */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A user-agent header made safe to store and show: control (Cc), format (Cf) and bidi override/isolate characters
 * removed, capped at `USER_AGENT_MAX`; null when nothing is left.
 */
export function sanitizeUserAgent(value: string | null): string | null {
  const clean = (value ?? "").replace(/[\p{Cc}\p{Cf}\u202A-\u202E\u2066-\u2069]/gu, "").slice(0, USER_AGENT_MAX);
  return clean || null;
}

/**
 * The client address of a request: the rightmost `x-forwarded-for` entry (the one appended by the reverse proxy directly in front of Weaver; earlier
 * entries are client-controlled),
 * else `remote` (the socket address, where the runtime exposes one), else null. At most 64 characters.
 */
export function requestIp(headers: Headers, remote: string | null = null): string | null {
  const first = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const ip = first || remote?.trim() || null;
  return ip ? ip.slice(0, 64) : null;
}

/**
 * Deletes the login sessions matching `where` together with the keys of approved sessions nobody collected, each
 * recorded as a system `key.revoke`; returns how many sessions and keys were deleted.
 */
async function deleteSessions(db: Db, where: SQL | undefined): Promise<{ sessions: number; keys: number }> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(npmLoginSession)
      .where(where)
      .returning({ id: npmLoginSession.id, apiKeyId: npmLoginSession.apiKeyId });
    const keyIds = removed.flatMap((r) => (r.apiKeyId ? [r.apiKeyId] : []));
    const keys =
      keyIds.length === 0
        ? []
        : await tx
            .delete(apikey)
            .where(inArray(apikey.id, keyIds))
            .returning({ id: apikey.id, name: apikey.name, userId: apikey.referenceId });
    for (const key of keys) {
      await recordAudit(tx, {
        actor: "system",
        action: "key.revoke",
        target: key.id,
        details: {
          name: key.name,
          userId: key.userId,
          reason: "npm login expired before the client collected the token",
          session: removed.find((r) => r.apiKeyId === key.id)?.id ?? null,
        },
      });
    }
    return { sessions: removed.length, keys: keys.length };
  });
}

/**
 * Deletes every login session that expired by `now`, and the API keys of approved ones whose token the CLI never
 * collected. Run by the maintenance worker (`npm:login-sweep`).
 */
export function sweepLoginSessions(db: Db, now: Date = new Date()): Promise<{ sessions: number; keys: number }> {
  return deleteSessions(db, lte(npmLoginSession.expiresAt, now));
}

/** Answers `GET /-/whoami` with the `user.name` of the token or session owner; anonymous callers get 401. */
export async function handleWhoami(deps: FormatDeps, req: Request): Promise<Response> {
  const principal = await deps.principal(req);
  if (principal.kind === "anonymous") throw new RegistryError("unauthorized", "authentication required");
  const [row] = await deps.db.select({ name: user.name }).from(user).where(eq(user.id, principal.userId)).limit(1);
  if (!row) throw new RegistryError("unauthorized", "authentication required");
  return npmJson({ username: row.name });
}

/**
 * Answers `POST /-/v1/login` (npm web login): refuses with 429 once {@link MAX_PENDING_LOGINS} sessions are live, or
 * {@link MAX_PENDING_LOGINS_PER_IP} are pending from the caller's address (skipped when it is unknown). Otherwise
 * stores a new pending session for `repo` with the poll secret only as its hash and the requester's address and user
 * agent, and returns the browser `loginUrl` and the CLI's polling `doneUrl`. Expired sessions are left to the sweep.
 */
export async function startWebLogin(deps: FormatDeps, repo: Repo, req: Request): Promise<Response> {
  const now = new Date();
  const ip = requestIp(req.headers);
  const live = gt(npmLoginSession.expiresAt, now);
  if ((await deps.db.$count(npmLoginSession, live)) >= MAX_PENDING_LOGINS) return tooManyLogins();
  if (ip !== null) {
    const fromIp = and(live, eq(npmLoginSession.requesterIp, ip), eq(npmLoginSession.status, "pending"));
    if ((await deps.db.$count(npmLoginSession, fromIp)) >= MAX_PENDING_LOGINS_PER_IP) return tooManyLogins();
  }
  const id = randomToken();
  const secret = randomToken();
  await deps.db.insert(npmLoginSession).values({
    id,
    pollHash: hashPollSecret(secret),
    repositoryId: repo.id,
    requesterIp: ip,
    requesterUserAgent: sanitizeUserAgent(req.headers.get("user-agent")),
    expiresAt: new Date(now.getTime() + LOGIN_SESSION_TTL_MS),
  });
  return npmJson({
    loginUrl: `${deps.publicUrl}/cli-login/${id}`,
    doneUrl: `${deps.publicUrl}/npm/${encodeURIComponent(repo.name)}/-/v1/login/done/${secret}`,
  });
}

/**
 * Answers the CLI polling `GET /-/v1/login/done/<secret>`: pending → 202 with `retry-after: 2`; approved → the token,
 * handed out exactly once (the row is deleted in the same statement that reads it); denied → 403 and the row is
 * deleted; missing, expired or for another repository → 404 (an expired row is deleted, with its uncollected key).
 */
export async function pollWebLogin(deps: FormatDeps, repo: Repo, secret: string): Promise<Response> {
  const pollHash = hashPollSecret(secret);
  const [row] = await deps.db.select().from(npmLoginSession).where(eq(npmLoginSession.pollHash, pollHash)).limit(1);
  if (!row || row.repositoryId !== repo.id) return npmError(404, NOT_FOUND);
  if (row.expiresAt.getTime() <= Date.now()) {
    await deleteSessions(deps.db, eq(npmLoginSession.id, row.id));
    return npmError(404, NOT_FOUND);
  }
  if (row.status === "pending") return npmJson({}, { status: 202, headers: { "retry-after": "2" } });
  if (row.status === "denied") {
    await deps.db.delete(npmLoginSession).where(eq(npmLoginSession.id, row.id));
    return npmError(403, "login was denied");
  }
  const [taken] = await deps.db
    .delete(npmLoginSession)
    .where(and(eq(npmLoginSession.id, row.id), eq(npmLoginSession.status, "approved")))
    .returning({ tokenCiphertext: npmLoginSession.tokenCiphertext });
  if (!taken?.tokenCiphertext) return npmError(404, NOT_FOUND);
  return npmJson({ token: decryptSecret(deps.secretKey, taken.tokenCiphertext) });
}

/**
 * Answers the legacy couchdb login `PUT /-/user/org.couchdb.user:<user>` (yarn berry): the `password` must be a Weaver
 * API key, which is returned as the token; any other password, including a browser session, is 401. Bodies over
 * 64 KiB get 413 and invalid JSON 400; a password that isn't printable ASCII without spaces is refused before it is
 * resolved.
 */
export async function legacyLogin(deps: FormatDeps, req: Request, pathUser: string): Promise<Response> {
  const raw = await readBody(req, LEGACY_BODY_LIMIT);
  let parsed: unknown = {};
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return npmError(400, "invalid JSON body");
    }
  }
  const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const password = typeof body["password"] === "string" ? body["password"] : "";
  const name = typeof body["name"] === "string" && body["name"] !== "" ? body["name"] : pathUser.replace(/^org\.couchdb\.user:/, "");
  if (!TOKEN_SHAPE.test(password)) return rejectLegacy();
  let kind: string;
  try {
    const principal = await deps.principal(new Request(req.url, { headers: { authorization: `Bearer ${password}` } }));
    kind = principal.kind;
  } catch (error) {
    if (error instanceof RegistryError) return rejectLegacy();
    throw error;
  }
  if (kind !== "apikey") return rejectLegacy();
  return npmJson({ ok: true, id: `org.couchdb.user:${name}`, token: password }, { status: 201 });
}

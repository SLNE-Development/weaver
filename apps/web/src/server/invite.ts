import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Cookie that carries an invite token through the OAuth round trip. */
export const INVITE_COOKIE = "weaver_invite";

/** How long the invite cookie stays valid after `/invite/<token>` sets it. */
export const INVITE_COOKIE_MAX_AGE_SECONDS = 15 * 60;

/** A fresh, URL-safe invite token (256 bits). Only its hash is ever stored. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The value stored in `invite.token_hash` for `token`: lowercase hex SHA-256. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The absolute one-time link for `token`. `publicUrl` must be `BETTER_AUTH_URL`, never a value
 * derived from the request, which arrives over plain http behind the proxy.
 */
export function buildInviteUrl(publicUrl: string, token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, publicUrl).toString();
}

/** Whether cookies must carry `Secure`: decided by the public URL, not by the request. */
export function isSecureUrl(publicUrl: string): boolean {
  return new URL(publicUrl).protocol === "https:";
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`invite:${payload}`).digest("base64url");
}

/**
 * The signed invite cookie value for `token`, `<token>.<expiresAtMs>.<hmac>`, valid for
 * {@link INVITE_COOKIE_MAX_AGE_SECONDS}. For cookie stores that take name, value and attributes
 * separately (Next.js `cookies().set`); set it with the attributes {@link serializeInviteCookie} uses.
 */
export function inviteCookieValue(token: string, opts: { secret: string; now?: Date }): string {
  const expiresAt = (opts.now ?? new Date()).getTime() + INVITE_COOKIE_MAX_AGE_SECONDS * 1000;
  const payload = `${token}.${expiresAt}`;
  return `${payload}.${sign(payload, opts.secret)}`;
}

/**
 * `Set-Cookie` header value that binds `token` to the browser for the coming OAuth sign-in:
 * `<token>.<expiresAtMs>.<hmac>`, httpOnly, `SameSite=Lax` (the provider's redirect back is a
 * top-level GET), and `Secure` when the app runs on https.
 */
export function serializeInviteCookie(
  token: string,
  opts: { secret: string; secure: boolean; now?: Date },
): string {
  return [
    `${INVITE_COOKIE}=${inviteCookieValue(token, opts)}`,
    "Path=/",
    `Max-Age=${INVITE_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

/** `Set-Cookie` header value that removes the invite cookie. */
export function clearInviteCookie(opts: { secure: boolean }): string {
  return [`${INVITE_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax", ...(opts.secure ? ["Secure"] : [])].join(
    "; ",
  );
}

/**
 * The invite token from a `Cookie` request header, or `null` when the cookie is missing,
 * malformed, expired or carries a signature that does not match `secret`.
 */
export function readInviteToken(
  cookieHeader: string | null | undefined,
  secret: string,
  now: Date = new Date(),
): string | null {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${INVITE_COOKIE}=`))
    ?.slice(INVITE_COOKIE.length + 1);
  if (!raw) return null;
  const parts = decodeURIComponent(raw).split(".");
  if (parts.length !== 3) return null;
  const [token, expiresAt, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(`${token}.${expiresAt}`, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) <= now.getTime()) return null;
  return token || null;
}

import type { Role } from "@weaver/core";
import { env } from "../env";

/** Where a signed-in user lands by default. */
export const DASHBOARD_PATH = "/dashboard";

/** Request header in which the proxy hands the requested path (pathname plus query) to layouts. */
export const PATH_HEADER = "x-weaver-path";

/** The outcome of the app shell's page gate. */
export type AccessDecision = { kind: "allow" } | { kind: "redirect"; to: string };

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The login page, returning to `path` (pathname plus query) after a successful sign-in. */
export function loginPath(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}

/**
 * Decides whether a visitor with `role` (`null` when anonymous) may open the app page at `path`
 * (pathname plus query). Anonymous visitors only get in when anonymous view is on, and then only
 * to the dashboard, the artifact browser and package search; everyone else is sent to the login page. Admin pages
 * are for admins; other users go back to the dashboard.
 */
export function decideAccess(input: { path: string; role: Role | null; anonymousView: boolean }): AccessDecision {
  const pathname = input.path.split(/[?#]/, 1)[0] ?? "/";
  if (input.role === null) {
    const publicPage = isUnder(pathname, DASHBOARD_PATH) || isUnder(pathname, "/browse") || isUnder(pathname, "/search");
    return input.anonymousView && publicPage ? { kind: "allow" } : { kind: "redirect", to: loginPath(input.path) };
  }
  if (isUnder(pathname, "/admin") && input.role !== "admin") return { kind: "redirect", to: DASHBOARD_PATH };
  return { kind: "allow" };
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, maintainer: 1, admin: 2 };

/**
 * Decides whether a visitor with `role` (`null` when anonymous) may open the page at `path`, which
 * needs at least `required`. Anonymous visitors go to the login page (returning to `path`), users
 * below the required role to the dashboard.
 */
export function decideRoleAccess(input: { path: string; role: Role | null; required: Role }): AccessDecision {
  if (input.role === null) return { kind: "redirect", to: loginPath(input.path) };
  return ROLE_RANK[input.role] >= ROLE_RANK[input.required] ? { kind: "allow" } : { kind: "redirect", to: DASHBOARD_PATH };
}

/**
 * The local path a `next` parameter may send the browser to after sign-in. Anything that is not a
 * same-origin absolute path (external URLs, `//host`, `/\host`, paths with control characters,
 * whitespace or backslashes, raw or percent-encoded, and paths whose dot segments normalise to
 * `//host`) or that points back at the login page falls back to the dashboard, so the parameter
 * can't be used as an open redirect. The result is the normalised pathname, query and fragment,
 * resolved against `BETTER_AUTH_URL`. Server-only (reads `env`).
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || UNSAFE_CHARS.test(next)) return DASHBOARD_PATH;
  // Browsers drop tabs and newlines and treat `\` like `/`, also once percent-decoded somewhere
  // along the way; refuse anything whose decoded form contains such characters.
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return DASHBOARD_PATH;
  }
  if (UNSAFE_CHARS.test(decoded) || decoded.startsWith("//")) return DASHBOARD_PATH;
  // Resolve against the public base URL: a target that leaves its origin is not a local path.
  const base = new URL(env.BETTER_AUTH_URL);
  const url = new URL(next, base);
  if (url.origin !== base.origin) return DASHBOARD_PATH;
  // Check the normalised path, not just the input: dot segments (`/.//x`, `/%2e%2e//x`) collapse
  // to `//x` only here, and a path starting with `//` is a protocol-relative URL to the browser.
  let normalized: string;
  try {
    normalized = decodeURIComponent(url.pathname);
  } catch {
    return DASHBOARD_PATH;
  }
  if (normalized.startsWith("//") || UNSAFE_CHARS.test(normalized)) return DASHBOARD_PATH;
  if (isUnder(url.pathname, "/login")) return DASHBOARD_PATH;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Control characters, whitespace and backslashes, none of which belong in a local `next` path. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000- \u007f\\]/;

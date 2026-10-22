import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { env } from "./env";
import { PATH_HEADER } from "./lib/access";

/** Sections that are never visible without signing in, whatever the anonymous-view setting says. */
const SIGNED_IN_ONLY = ["/account", "/keys", "/repositories", "/admin", "/cli-login"];

/**
 * Runs before every page request. It only checks whether a session cookie is present (it never
 * validates it; layouts and data access do that): cookieless requests for signed-in-only sections
 * go to the login page right away, so client-side navigation can't reach them either. It also
 * hands the requested path to the app layout's access gate.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const path = `${pathname}${search}`;
  const signedInOnly = SIGNED_IN_ONLY.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (signedInOnly && !getSessionCookie(request)) {
    // Absolute URLs come from the public base URL, never from the (plain http) request host.
    const login = new URL("/login", env.BETTER_AUTH_URL);
    login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, path);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only: skip the API, the protocol mounts, Next.js internals and root metadata files. Page paths may contain
  // dots (groups, versions), so static files can't be told apart by extension.
  matcher: ["/((?!api/|_next/|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|v2/|v2$|maven/|npm/).*)"],
};

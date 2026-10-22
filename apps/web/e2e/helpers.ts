import type { Page } from "@playwright/test";
import { signSessionCookie } from "../src/test/session-cookie";
import { AUTH_SECRET, BASE_URL, SESSION_COOKIE, sessionToken } from "./fixtures";

/**
 * The Better Auth session cookie value for the session the global setup created for `userId`:
 * `<token>.<HMAC-SHA256>`, URL-encoded, exactly as Better Auth signs it.
 */
export async function sessionCookieValue(userId: string): Promise<string> {
  return signSessionCookie(AUTH_SECRET, sessionToken(userId));
}

/** Signs the page's browser context in as the seeded user `userId`. */
export async function loginAs(page: Page, userId: string): Promise<void> {
  await page.context().addCookies([
    { name: SESSION_COOKIE, value: await sessionCookieValue(userId), url: BASE_URL, httpOnly: true, sameSite: "Lax" },
  ]);
}

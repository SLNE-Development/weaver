// Approves an `npm login --auth-type=web` session in a headless browser, as the person at the keyboard would.
//
//   node scripts/e2e/npm-web-login.mjs <loginUrl> <sessionCookie> <baseUrl>
//
// Signs the browser in with the e2e admin's Better Auth session cookie (scripts/e2e/run.sh seeds it), opens the
// login page npm printed, clicks "Create token" and waits for the confirmation. Exits 0 once the page confirms,
// 1 with the page text when anything fails or takes longer than 30 s. Playwright comes from apps/web.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 30_000;
const [loginUrl, sessionCookie, baseUrl] = process.argv.slice(2);
if (!loginUrl || !sessionCookie || !baseUrl) {
  console.error("usage: npm-web-login.mjs <loginUrl> <sessionCookie> <baseUrl>");
  process.exit(2);
}

const require = createRequire(fileURLToPath(new URL("../../apps/web/package.json", import.meta.url)));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch();
let page;
try {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "better-auth.session_token", value: sessionCookie, url: baseUrl, httpOnly: true, sameSite: "Lax" },
  ]);
  page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  await page.goto(loginUrl);
  await page.getByRole("button", { name: "Create token" }).click();
  await page.getByText("You can close this tab").waitFor();
  console.log("npm web login approved");
} catch (error) {
  const text = page ? await page.locator("body").innerText().catch(() => "(no page text)") : "(no page)";
  console.error(`npm web login failed: ${error instanceof Error ? error.message : String(error)}\n--- page text ---\n${text}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

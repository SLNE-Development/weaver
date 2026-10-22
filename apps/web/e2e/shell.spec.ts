import { expect, test } from "@playwright/test";
import { INVITES, USERS } from "./fixtures";
import { loginAs } from "./helpers";

const sidebar = (page: import("@playwright/test").Page) => page.locator("[data-slot=sidebar]");

test.describe("anonymous visitors", () => {
  test("see the landing page at / and the login page for app pages", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("landing")).toBeVisible();
    await expect(page).toHaveURL("/");

    await page.goto("/dashboard");
    await expect(page).toHaveURL("/login?next=%2Fdashboard");
  });

  test("are sent to the login page for signed-in-only sections", async ({ page }) => {
    await page.goto("/keys");
    await expect(page).toHaveURL("/login?next=%2Fkeys");
  });

  test("see only the configured provider on the login page", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to Weaver" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Discord/ })).toHaveCount(0);
  });

  test("see the invite message after a refused sign-up", async ({ page }) => {
    await page.goto("/login?error=invite_required");
    await expect(page.getByText("You need an invite to join this Weaver.")).toBeVisible();
  });

  test("see the granted role and the providers on a valid invite", async ({ page }) => {
    await page.goto(`/invite/${INVITES.viewer}`);
    await expect(page.getByRole("heading", { name: "You're invited to Weaver" })).toBeVisible();
    await expect(page.getByTestId("invite-role")).toHaveText("viewer");
    await expect(page.getByText("Welcome to the team")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  });

  test("get a clear message for expired and unknown invites", async ({ page }) => {
    await page.goto(`/invite/${INVITES.expired}`);
    await expect(page.getByRole("heading", { name: "Invite expired" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with/ })).toHaveCount(0);

    await page.goto("/invite/not-a-real-token");
    await expect(page.getByRole("heading", { name: "Invite not found" })).toBeVisible();
  });
});

test.describe("signed-in users", () => {
  test("an admin lands on the dashboard and sees the full nav", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/");
    await expect(page).toHaveURL("/dashboard");

    const nav = sidebar(page);
    for (const name of ["Dashboard", "Browse", "Repositories", "API keys", "Users", "Settings", "Audit log"]) {
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("button", { name: "User menu" })).toContainText(USERS.admin.name);

    const firstLink = nav.getByRole("link", { name: "Dashboard", exact: true });
    expect(await firstLink.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  });

  test("the login page never redirects a signed-in user off-site", async ({ page }) => {
    await loginAs(page, USERS.viewer.id);
    for (const next of [
      "%2F%09%2Fevil.example",
      "%2F%5C%2Fevil.example",
      "%2F%2Fevil.example",
      "%2F.%2F%2Fevil.example",
      "%2F%252e%252e%2F%2Fevil.example",
    ]) {
      await page.goto(`/login?next=${next}`);
      await expect(page).toHaveURL("/dashboard");
    }
  });

  test("a viewer doesn't see the admin section", async ({ page }) => {
    await loginAs(page, USERS.viewer.id);
    await page.goto("/dashboard");
    const nav = sidebar(page);
    await expect(nav.getByRole("link", { name: "API keys", exact: true })).toBeVisible();
    for (const name of ["Users", "Settings", "Audit log"]) {
      await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0);
    }
  });

  test("Ctrl+K opens the command dialog and switches the theme", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/dashboard");
    await expect(sidebar(page).getByRole("link", { name: "Dashboard", exact: true })).toBeVisible();

    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("option", { name: "Users" })).toBeVisible();
    await dialog.getByRole("option", { name: "Theme: Dark" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  });

  test("the sidebar search button opens the command dialog and Go to navigates", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/dashboard");
    await sidebar(page).getByRole("button", { name: /Search/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/Search/).fill("account");
    await dialog.getByRole("option", { name: "Account" }).click();
    await expect(page).toHaveURL("/account");
  });

  test("the account page offers Connect for an unlinked provider", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/account");
    const github = page.getByTestId("provider-github");
    await expect(github).toContainText("Not connected");
    await expect(github.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  test("the account page won't disconnect the last sign-in method", async ({ page }) => {
    await loginAs(page, USERS.githubViewer.id);
    await page.goto("/account");
    const github = page.getByTestId("provider-github");
    await expect(github.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  });
});

import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { count, eq, inArray } from "drizzle-orm";
import { component, createDb, protoArtifact as artifact, protoVersion as version, repository, setting } from "@weaver/db";
import { ARTIFACTS, MIRROR_UPSTREAM, STATE_FILE, USERS } from "./fixtures";
import { loginAs } from "./helpers";

const VERSION_PAGE = "/browse/releases/dev.example/demo/1.0.0";
const SNAPSHOT_PAGE = "/browse/snapshots/dev.example/demo/1.1.0-SNAPSHOT";

const sidebar = (page: Page) => page.locator("[data-slot=sidebar]");
const cursorOf = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).cursor);
const statValue = (page: Page, id: string) => page.getByTestId(id).locator("[data-slot=stat-value]");

/** Runs `work` against the shared e2e database. */
async function withDb<T>(work: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const { databaseUrl } = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { databaseUrl: string };
  const db = createDb(databaseUrl);
  try {
    return await work(db);
  } finally {
    await db.$client.end();
  }
}

/** Sets "Allow anonymous view"; `false` removes the row, which is the default. */
async function setAnonymousView(on: boolean): Promise<void> {
  await withDb((db) =>
    on
      ? db.insert(setting).values({ key: "anonymousView", value: true }).onConflictDoUpdate({ target: setting.key, set: { value: true } })
      : db.delete(setting).where(eq(setting.key, "anonymousView")),
  );
}

test.describe("artifact browser", () => {
  test("anonymous visitors are sent to the login page while anonymous view is off", async ({ page }) => {
    await page.goto(VERSION_PAGE);
    await expect(page).toHaveURL(`/login?next=${encodeURIComponent(VERSION_PAGE)}`);
  });

  test("the dashboard shows counts and recent publishes", async ({ page }) => {
    // Other specs add repositories to the shared database, so the expected numbers come from it.
    const expected = await withDb(async (db) => {
      const [repos] = await db.select({ n: count() }).from(repository);
      const [artifacts] = await db.select({ n: count() }).from(artifact);
      const [versions] = await db.select({ n: count() }).from(version);
      return { repos: repos!.n, artifacts: artifacts!.n, versions: versions!.n };
    });

    await loginAs(page, USERS.admin.id);
    await page.goto("/dashboard");
    await expect(statValue(page, "stat-repositories")).toHaveText(String(expected.repos));
    await expect(statValue(page, "stat-artifacts")).toHaveText(String(expected.artifacts));
    await expect(statValue(page, "stat-versions")).toHaveText(String(expected.versions));

    const recent = page.getByTestId("recent-publishes");
    await expect(recent.getByRole("link", { name: "dev.example:orders:1.0.0", exact: true })).toHaveText("dev.example:orders:1.0.0");
    // The snapshot has two builds; the newer one is marked #2.
    const snapshotRows = recent.getByRole("row").filter({ hasText: "dev.example:demo:1.1.0-SNAPSHOT" });
    await expect(snapshotRows).toHaveCount(2);
    await expect(snapshotRows.first()).toContainText("#2");
  });

  test("browse lists repositories, then artifacts, then versions", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/browse");
    await page.getByRole("link", { name: "releases", exact: true }).click();
    await expect(page).toHaveURL("/browse/releases");
    await page.getByRole("link", { name: "demo", exact: true }).click();
    await expect(page).toHaveURL("/browse/releases/dev.example/demo");
    await page.getByRole("link", { name: "1.0.0", exact: true }).click();
    await expect(page).toHaveURL(VERSION_PAGE);
  });

  test("the version page shows files, usage, details and dependents", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);

    const tree = page.getByRole("navigation", { name: "Files" });
    await expect(tree.getByRole("link", { name: "money.proto" })).toBeVisible();
    await tree.getByRole("link", { name: "money.proto" }).click();
    await expect(page.getByTestId("proto-viewer")).toContainText("message Money");

    await page.getByRole("tab", { name: "Usage" }).click();
    await expect(page.getByRole("tabpanel")).toContainText('weaver("dev.example:demo:1.0.0")');

    await page.getByRole("tab", { name: /Dependents/ }).click();
    await expect(page.getByRole("tabpanel").getByRole("link", { name: "dev.example:orders:1.0.0" })).toBeVisible();

    await page.getByRole("tab", { name: "Details" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("sha256");

    expect(await cursorOf(sidebar(page).getByRole("link").first())).toBe("pointer");
    expect(await cursorOf(page.getByRole("button", { name: "Delete version" }))).toBe("pointer");
  });

  test("the archive link downloads the version", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    const href = await page.getByRole("link", { name: "Archive" }).getAttribute("href");
    expect(href).toBe("/api/v1/repos/releases/artifacts/dev.example/demo/1.0.0/archive");
    await page.getByRole("tab", { name: "Details" }).click();
    const sha = (await page.getByRole("tabpanel").locator("code").nth(1).textContent())!.trim();

    const response = await page.request.get(href!);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-weaver-sha256"]).toBe(sha);
  });

  test("Copy on the viewer fetches the file", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await loginAs(page, USERS.admin.id);
    await page.goto(`${VERSION_PAGE}?file=${encodeURIComponent("dev/example/money/v1/money.proto")}`);
    await page.getByRole("button", { name: "Copy dev/example/money/v1/money.proto" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("message Money {");
  });

  test("deleting a version with dependents lists them and lets admins force it", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    await page.getByRole("button", { name: "Delete version" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog.getByText("dev.example:orders:1.0.0")).toBeVisible();
    const force = dialog.getByRole("button", { name: "Delete anyway" });
    await expect(force).toBeDisabled();
    await dialog.getByLabel(/Type/).fill("dev.example:demo:1.0.0");
    await expect(force).toBeEnabled();
    // Leave the fixture in place for the other tests.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("deleting an artifact's last version returns to the repository", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/browse/releases/dev.example/scratch/0.1.0");
    await page.getByRole("button", { name: "Delete version" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page).toHaveURL("/browse/releases");
    await expect(page.getByRole("link", { name: "scratch", exact: true })).toHaveCount(0);

    await page.goto("/browse/releases/dev.example/scratch/0.1.0");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("snapshot versions list their builds", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(SNAPSHOT_PAGE);
    await page.getByRole("tab", { name: /Builds/ }).click();
    await expect(page.getByRole("tabpanel").getByRole("row")).toHaveCount(3);
  });

  test("viewers can't delete versions", async ({ page }) => {
    await loginAs(page, USERS.viewer.id);
    await page.goto(VERSION_PAGE);
    await expect(page.getByRole("heading", { name: /demo/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete version" })).toHaveCount(0);
  });

  test("public pages get canonical URLs and share cards, private ones the generic card and noindex", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    await expect(page).toHaveTitle("dev.example:demo:1.0.0 · Weaver");
    const ogImage = page.locator('meta[property="og:image"]');
    await expect(ogImage).toHaveAttribute("content", /\/og\/artifact\/releases\/dev\.example\/demo\/1\.0\.0$/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${VERSION_PAGE}$`));
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    const card = await page.request.get((await ogImage.getAttribute("content"))!);
    expect(card.status()).toBe(200);
    expect(card.headers()["content-type"]).toContain("image/png");

    for (const path of [SNAPSHOT_PAGE, "/browse/snapshots", "/browse/snapshots/dev.example/demo"]) {
      await page.goto(path);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/opengraph-image$/);
    }

    await page.goto("/browse/releases");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/browse\/releases$/);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  });

  test("with anonymous view on, visitors see public repositories only", async ({ page }) => {
    await setAnonymousView(true);
    try {
      await page.goto("/browse");
      await expect(page.getByRole("link", { name: "releases", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "snapshots", exact: true })).toHaveCount(0);

      await page.goto(VERSION_PAGE);
      await expect(page.getByTestId("proto-viewer")).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete version" })).toHaveCount(0);

      for (const path of ["/browse/snapshots", SNAPSHOT_PAGE]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
      }

      await page.keyboard.press("Control+K");
      const dialog = page.getByRole("dialog");
      await dialog.getByPlaceholder(/Search/).fill("demo");
      const options = dialog.getByRole("option", { name: /dev\.example:demo/ });
      await expect(options).toHaveCount(1);
      await expect(options).toContainText("releases");
    } finally {
      await setAnonymousView(false);
    }
  });

  test("Ctrl+K finds artifacts and switches the theme", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    await expect(page.getByRole("heading", { name: /demo/ })).toBeVisible();

    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/Search/).fill("demo");
    const option = dialog.getByRole("option", { name: /dev\.example:demo/ }).first();
    await expect(option).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/browse\/(releases|snapshots)\/dev\.example\/demo$/);

    await page.keyboard.press("Control+K");
    await dialog.getByPlaceholder(/Search/).fill("theme dark");
    await expect(dialog.getByRole("option", { name: "Theme: Dark" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  });

  test("proto mirror without caching shows the upstream note", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(`/browse/${ARTIFACTS.mirror}`);
    const note = page.getByText("This mirror does not cache; its content lives upstream at");
    await expect(note).toBeVisible();
    await expect(note).toContainText(MIRROR_UPSTREAM);
    await expect(page.getByText("weaver.json")).toBeVisible();

    // The upstream URL is mirror config, which only admins see.
    await loginAs(page, USERS.viewer.id);
    await page.goto(`/browse/${ARTIFACTS.mirror}`);
    await expect(page.getByText("This mirror does not cache")).toBeVisible();
    await expect(page.getByText(MIRROR_UPSTREAM)).toHaveCount(0);
  });

  test("proto group page links each member", async ({ page }) => {
    await loginAs(page, USERS.viewer.id);
    await page.goto(`/browse/${ARTIFACTS.group}`);
    const members = page.getByTestId("group-members");
    await expect(members.getByRole("link")).toHaveCount(2);
    await members.getByRole("link", { name: ARTIFACTS.releases, exact: true }).click();
    await expect(page).toHaveURL(`/browse/${ARTIFACTS.releases}`);
    await page.goto(`/browse/${ARTIFACTS.group}`);
    await page.getByTestId("group-members").getByRole("link", { name: ARTIFACTS.mirror, exact: true }).click();
    await expect(page).toHaveURL(`/browse/${ARTIFACTS.mirror}`);
  });

  test("version pages register Copy coordinate in the command dialog", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    await expect(page.getByRole("heading", { name: /demo/ })).toBeVisible();
    await page.keyboard.press("Control+K");
    await page.getByRole("dialog").getByRole("option", { name: "Copy coordinate" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("dev.example:demo:1.0.0");
  });
});

/** The repositories and packages the package search tests seed; removed again afterwards. */
const SEARCH_REPOS = [
  { name: "search-maven", format: "maven", namespace: "org.example", package: "commons-lib", version: "1.0" },
  { name: "search-npm", format: "npm", namespace: "", package: "left-lib", version: "2.0.0" },
  { name: "search-docker", format: "docker", namespace: "", package: "team/lib-app", version: "1.0" },
] as const;

test.describe("package search", () => {
  test.beforeAll(async () => {
    await withDb(async (db) => {
      const rows = await db
        .insert(repository)
        .values(SEARCH_REPOS.map((r) => ({ name: r.name, format: r.format, kind: "hosted" as const, visibility: "private" as const })))
        .returning({ id: repository.id, name: repository.name });
      const idOf = new Map(rows.map((r) => [r.name, r.id]));
      await db
        .insert(component)
        .values(SEARCH_REPOS.map((r) => ({ repositoryId: idOf.get(r.name)!, namespace: r.namespace, name: r.package, version: r.version })));
    });
  });

  test.afterAll(async () => {
    await withDb((db) => db.delete(repository).where(inArray(repository.name, SEARCH_REPOS.map((r) => r.name))));
  });

  test("Ctrl+K opens the search page and the format chips filter it", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/dashboard");
    await expect(page.getByRole("searchbox", { name: "Search packages" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+K");
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/Search/).fill("lib");
    await dialog.getByRole("option", { name: "See all results" }).click();
    await expect(page).toHaveURL("/search?q=lib");
    await expect(page.getByRole("searchbox", { name: "Search packages" })).toHaveValue("lib");

    const results = page.getByRole("list", { name: "Search results" });
    await expect(results.getByRole("link", { name: /org\.example:commons-lib/ })).toBeVisible();
    await expect(results.getByRole("link", { name: /left-lib/ })).toBeVisible();
    await expect(results.locator("li[data-format=maven]")).toHaveCount(1);
    await expect(results.locator("li[data-format=npm]")).toHaveCount(1);

    await page.getByRole("radio", { name: "Docker" }).click();
    await expect(page).toHaveURL("/search?q=lib&format=docker");
    await expect(results.getByRole("link", { name: /team\/lib-app/ })).toBeVisible();
    await expect(results.locator("li:not([data-format=docker])")).toHaveCount(0);

    await page.goto("/search?q=zzz-nothing");
    await expect(page.getByText('No packages match "zzz-nothing"')).toBeVisible();
  });

  test("Ctrl+K lists packages under Packages and Enter opens the package page", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/dashboard");
    await page.keyboard.press("ControlOrMeta+K");
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/Search/).fill("left-lib");
    const group = dialog.getByRole("group", { name: "Packages" });
    const option = group.getByRole("option", { name: /left-lib/ });
    await expect(option).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/browse/search-npm/-/npm/left-lib");
  });
});

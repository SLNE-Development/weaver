import { expect, test, type Locator, type Page } from "@playwright/test";
import { USERS } from "./fixtures";
import { loginAs } from "./helpers";

/**
 * Repository, cleanup policy and API key management. Every test creates what it needs under a
 * name unique to the run, so tests don't depend on each other and survive retries on the shared
 * e2e database.
 */

/** A repository name unique to this test run, e.g. `keys-lq3x9a-k2`. */
function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Calls a tRPC mutation as the page's signed-in user (superjson wire format). */
async function trpcMutation<T>(page: Page, path: string, input: unknown): Promise<T> {
  const response = await page.request.post(`/api/trpc/${path}`, { data: { json: input } });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: { json: T } } }).result.data.json;
}

async function createRepository(page: Page, name: string): Promise<void> {
  await trpcMutation(page, "repositories.create", { name, format: "proto", kind: "hosted", visibility: "private" });
}

/** Picks `option` in the Radix select whose trigger has the accessible name `trigger`, inside `scope`. */
async function choose(page: Page, scope: Locator, trigger: string, option: string) {
  await scope.getByRole("combobox", { name: trigger }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("an admin creates a proto repository in the dialog and lands on its settings", async ({ page }) => {
  const name = uniqueName("ui");
  await loginAs(page, USERS.admin.id);
  await page.goto("/repositories");
  await page.getByRole("button", { name: "New repository" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New repository" });

  // Client-side validation of the name.
  await dialog.getByLabel("Name", { exact: true }).fill("Team Private");
  await dialog.getByRole("button", { name: "Create repository" }).click();
  await expect(dialog.getByText("Use lowercase letters, digits and dashes")).toBeVisible();

  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await choose(page, dialog, "Format", "Proto");
  await expect(dialog.getByRole("radio", { name: "Hosted" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create repository" }).click();

  await expect(page).toHaveURL(`/repositories/${name}/settings`);
  await expect(page.getByText("Lower wins.")).toBeVisible();
  // Only proto settings apply to a proto repository: no mirror or group sections.
  await expect(page.getByRole("region", { name: "Mirror" })).toHaveCount(0);

  const general = page.getByRole("region", { name: "General" });
  await general.getByLabel("Description").fill("Protos only the team can see");
  await general.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();

  await page.goto("/repositories");
  const row = page.getByTestId(`repository-${name}`);
  await expect(row).toContainText("private");
  await expect(row).toContainText("Proto");
  await expect(row).toContainText("Hosted");
  await expect(row).toContainText("Protos only the team can see");
});

test("an admin creates an npm mirror with one upstream and turns caching on", async ({ page }) => {
  const name = uniqueName("npm");
  await loginAs(page, USERS.admin.id);
  await page.goto("/repositories?create=1");
  const dialog = page.getByRole("dialog", { name: "New repository" });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await choose(page, dialog, "Format", "npm");
  await dialog.getByRole("radio", { name: "Mirror" }).click();
  await dialog.getByRole("button", { name: "Create repository" }).click();
  await expect(dialog.getByText("Enter an http or https URL")).toBeVisible();
  await dialog.getByLabel("Upstream URL").fill("https://registry.npmjs.org");
  await dialog.getByRole("button", { name: "Create repository" }).click();

  await expect(page).toHaveURL(`/repositories/${name}/settings`);
  const mirror = page.getByRole("region", { name: "Mirror" });
  await expect(mirror.getByLabel("Upstream 1 URL")).toHaveValue("https://registry.npmjs.org");
  await expect(mirror.getByTestId("cache-status")).toHaveText("Caching off");
  await expect(mirror.getByLabel("Metadata TTL (seconds)")).toHaveCount(0);
  // Hosted proto settings don't apply to a mirror.
  await expect(page.getByText("Lower wins.")).toHaveCount(0);

  await mirror.getByRole("switch", { name: "Cache upstream content" }).click();
  await expect(mirror.getByTestId("cache-status")).toHaveText("Caching on");
  await expect(mirror.getByLabel("Metadata TTL (seconds)")).toHaveValue("1800");
  await mirror.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: "Mirror" }).getByTestId("cache-status")).toHaveText("Caching on");

  // A stored token is only kept while the upstream stays the same.
  await choose(page, mirror, "Upstream 1 auth", "Bearer token");
  await mirror.getByLabel("Token").fill("npm_secret_token");
  await mirror.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved").first()).toBeVisible();
  await page.reload();
  const hint = mirror.getByText("Leave empty to keep the stored secret");
  await expect(hint).toBeVisible();
  await expect(mirror.getByLabel("Token")).toHaveAttribute("placeholder", "stored");
  await mirror.getByLabel("Upstream 1 URL").fill("https://registry.example.com/npm");
  await expect(hint).toBeHidden();
  await expect(mirror.getByLabel("Token")).toHaveAttribute("placeholder", "");
  await mirror.getByRole("button", { name: "Save changes" }).click();
  await expect(mirror.getByText("Bearer auth needs a token")).toBeVisible();
  await page.goto("/repositories");
  await expect(page.getByTestId(`repository-${name}`)).toContainText("Mirror");
});

test("an admin creates an npm group from hosted members and reorders them", async ({ page }) => {
  const [first, second, group] = [uniqueName("npm-a"), uniqueName("npm-b"), uniqueName("npm-all")];
  await loginAs(page, USERS.admin.id);
  for (const name of [first, second]) await trpcMutation(page, "repositories.create", { name, format: "npm", kind: "hosted" });

  await page.goto("/repositories?create=1");
  const dialog = page.getByRole("dialog", { name: "New repository" });
  await dialog.getByLabel("Name", { exact: true }).fill(group);
  await choose(page, dialog, "Format", "npm");
  await dialog.getByRole("radio", { name: "Group" }).click();
  await dialog.getByRole("checkbox", { name: first }).check();
  await dialog.getByRole("checkbox", { name: second }).check();
  await dialog.getByRole("button", { name: "Create repository" }).click();

  await expect(page).toHaveURL(`/repositories/${group}/settings`);
  const members = page.getByRole("region", { name: "Members" });
  await expect(members.getByTestId("member-row")).toHaveText([new RegExp(first), new RegExp(second)]);
  await members.getByRole("button", { name: `Move ${second} up` }).click();
  await members.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Members" }).getByTestId("member-row")).toHaveText([new RegExp(second), new RegExp(first)]);
});

test("repository settings save and keep unsaved edits while policies change", async ({ page }) => {
  const name = uniqueName("settings");
  await loginAs(page, USERS.admin.id);
  await createRepository(page, name);
  await page.goto(`/repositories/${name}/settings`);

  const proto = page.getByRole("region", { name: "Proto options" });
  await proto.getByLabel("Resolution priority").fill("10");
  await proto.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Resolution priority")).toHaveValue("10");

  // An unsaved edit survives a policy change, which refetches the repository.
  await page.getByLabel("Description").fill("Draft description");
  await page.getByRole("button", { name: "Add policy" }).click();
  const dialog = page.getByRole("dialog", { name: "Add cleanup policy" });
  await dialog.getByRole("button", { name: "Add policy" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("1 cleanup policies")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("Draft description");
});

test("a cleanup policy can be added, edited, toggled, previewed and run", async ({ page }) => {
  const name = uniqueName("policies");
  await loginAs(page, USERS.admin.id);
  await createRepository(page, name);
  await page.goto(`/repositories/${name}/settings`);

  await page.getByRole("button", { name: "Add policy" }).click();
  const add = page.getByRole("dialog", { name: "Add cleanup policy" });
  await add.getByRole("radio", { name: "Delete not downloaded" }).click();
  await add.getByLabel("Days").fill("90");
  await add.getByLabel("Group prefix").fill("com..bad");
  await add.getByRole("button", { name: "Add policy" }).click();
  await expect(add.getByText("Not a valid group")).toBeVisible();
  await add.getByLabel("Group prefix").fill("com.acme");
  await add.getByRole("checkbox", { name: "Include releases" }).check();
  await expect(add.getByText("Releases will be deleted")).toBeVisible();
  await add.getByRole("button", { name: "Add policy" }).click();
  await expect(add).toBeHidden();
  await expect(page.getByRole("cell", { name: /Delete snapshots and releases not downloaded for 90 days/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "com.acme.*" })).toBeVisible();

  // Edit: switch the rule and its value; the dialog opens with the stored values.
  await page.getByRole("button", { name: "Edit policy" }).click();
  const edit = page.getByRole("dialog", { name: "Edit cleanup policy" });
  await expect(edit.getByLabel("Days")).toHaveValue("90");
  await expect(edit.getByLabel("Group prefix")).toHaveValue("com.acme");
  await edit.getByRole("radio", { name: "Keep last N snapshot builds" }).click();
  await edit.getByLabel("Builds to keep").fill("3");
  await edit.getByRole("button", { name: "Save policy" }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("cell", { name: /Keep the last 3 builds of each snapshot/ })).toBeVisible();

  // Toggle: disabling the only policy disables Preview and Run now; enabling brings them back.
  const toggle = page.getByRole("switch", { name: "Disable policy" });
  await toggle.click();
  await expect(page.getByText("Policy disabled")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enable policy" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Preview" })).toBeDisabled();
  await page.getByRole("switch", { name: "Enable policy" }).click();
  await expect(page.getByRole("switch", { name: "Disable policy" })).toBeChecked();

  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("preview-empty")).toHaveText("Nothing to clean up right now.");
  await page.keyboard.press("Escape");

  // The e2e server has no VALKEY_URL, so Run now explains why it can't start.
  await page.getByRole("button", { name: "Run now" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Run cleanup" }).click();
  await expect(page.getByTestId("run-status")).toContainText("VALKEY_URL is unset");
  await expect(page.getByRole("button", { name: "Run now" })).toBeEnabled();
});

test("a docker hosted repository offers only the docker cleanup kinds", async ({ page }) => {
  const name = uniqueName("images");
  await loginAs(page, USERS.admin.id);
  await trpcMutation(page, "repositories.create", { name, format: "docker", kind: "hosted" });
  await page.goto(`/repositories/${name}/settings`);

  await page.getByRole("button", { name: "Add policy" }).click();
  const add = page.getByRole("dialog", { name: "Add cleanup policy" });
  await expect(add.getByRole("radio")).toHaveCount(3);
  await expect(add.getByRole("radio", { name: "Delete untagged manifests" })).toBeVisible();
  await expect(add.getByRole("radio", { name: "Keep last N tags" })).toBeVisible();
  await expect(add.getByRole("radio", { name: "Delete tags not pulled" })).toBeVisible();
  await expect(add.getByLabel("Image prefix")).toBeVisible();

  // The tag pattern belongs to "Keep last N tags" only; "Include releases" never applies to docker.
  await expect(add.getByLabel("Tag pattern")).toHaveCount(0);
  await add.getByRole("radio", { name: "Delete tags not pulled" }).click();
  await expect(add.getByLabel("Tag pattern")).toHaveCount(0);
  await expect(add.getByRole("checkbox", { name: "Include releases" })).toHaveCount(0);
  await add.getByRole("radio", { name: "Keep last N tags" }).click();
  await expect(add.getByLabel("Tag pattern")).toBeVisible();
  await expect(add.getByRole("checkbox", { name: "Include releases" })).toHaveCount(0);

  await add.getByLabel("Tags to keep").fill("5");
  await add.getByRole("button", { name: "Add policy" }).click();
  await expect(add.getByText("Enter a tag pattern")).toBeVisible();
  await add.getByLabel("Tag pattern").fill("v*");
  await add.getByRole("button", { name: "Add policy" }).click();
  await expect(add).toBeHidden();
  await expect(page.getByRole("cell", { name: /Keep the last 5 tags matching v\*/ })).toBeVisible();
});

test("a mirror repository has no cleanup policies", async ({ page }) => {
  const name = uniqueName("mirror");
  await loginAs(page, USERS.admin.id);
  await trpcMutation(page, "repositories.create", {
    name,
    format: "npm",
    kind: "mirror",
    upstreams: [{ url: "https://registry.npmjs.org", authType: "none" }],
  });
  await page.goto(`/repositories/${name}/settings`);
  await expect(page.getByRole("region", { name: "Mirror" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cleanup policies" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add policy" })).toHaveCount(0);
  await expect(page.getByText("Mirror caches are cleaned up by the eviction settings above.")).toBeVisible();
});

test("an admin creates a key whose secret is shown exactly once", async ({ page }) => {
  const repo = uniqueName("keys");
  const keyName = uniqueName("ci").slice(0, 32);
  await loginAs(page, USERS.admin.id);
  await createRepository(page, repo);
  await page.goto("/keys");
  await page.getByRole("button", { name: "Create key" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByLabel("Name").fill(keyName);
  const row = dialog.getByTestId("permission-row").first();
  await choose(page, row, "Repository", repo);
  await choose(page, row, "Access", "write");
  await dialog.getByRole("button", { name: "Create key" }).click();

  const secret = page.getByTestId("api-key-secret");
  await expect(secret).toHaveText(/^pl_/);
  const value = (await secret.textContent())!;
  await expect(page.getByText("You won't see this key again")).toBeVisible();
  // Neither Escape nor a click outside closes the dialog while the secret is on screen.
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(secret).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  const listed = page.getByTestId("api-key-row").filter({ hasText: keyName });
  await expect(listed).toContainText(`write ${repo}`);
  await expect(page.getByText(value)).toHaveCount(0);

  // Reopening the dialog starts from an empty form, not from the previous secret.
  await page.getByRole("button", { name: "Create key" }).first().click();
  await expect(page.getByRole("dialog", { name: "Create API key" }).getByLabel("Name")).toHaveValue("");
  await expect(page.getByTestId("api-key-secret")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.getByTestId("api-key-row").filter({ hasText: keyName })).toBeVisible();
  expect(await page.content()).not.toContain(value);
});

test("a long repository name stays inside its permission picker", async ({ page }) => {
  // 63 characters, the longest name a repository may have.
  const repo = uniqueName("a-very-long-repository-name-for-the-picker").padEnd(63, "x").slice(0, 63);
  await loginAs(page, USERS.admin.id);
  await createRepository(page, repo);
  await page.goto("/keys");
  await page.getByRole("button", { name: "Create key" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  const row = dialog.getByTestId("permission-row").first();
  await choose(page, row, "Repository", repo);

  const trigger = row.getByRole("combobox", { name: "Repository" });
  const prefix = row.getByLabel("Group prefix");
  const [triggerBox, prefixBox] = [(await trigger.boundingBox())!, (await prefix.boundingBox())!];
  expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(prefixBox.x);
  // The name is cut off inside the trigger instead of painting past its edge.
  const overflow = await trigger.evaluate((el) => {
    const right = el.getBoundingClientRect().right;
    return [...el.querySelectorAll("*")].some((child) => child.getBoundingClientRect().right > right + 0.5);
  });
  expect(overflow).toBe(false);
  await dialog.screenshot({ path: ".e2e/results/long-repo-picker.png" });
});

test("an admin revokes a key after confirming", async ({ page }) => {
  const repo = uniqueName("revoke");
  const keyName = uniqueName("old").slice(0, 32);
  await loginAs(page, USERS.admin.id);
  await createRepository(page, repo);
  await trpcMutation(page, "keys.create", { name: keyName, permissions: [{ repository: repo, access: "read" }] });

  await page.goto("/keys");
  const row = page.getByTestId("api-key-row").filter({ hasText: keyName });
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke key" }).click();
  await expect(row).toHaveCount(0);
});

test("a viewer gets read-only keys and no repository administration", async ({ browser }) => {
  const repo = uniqueName("viewer");
  const adminPage = await browser.newPage();
  await loginAs(adminPage, USERS.admin.id);
  await createRepository(adminPage, repo);
  await adminPage.close();

  const page = await browser.newPage();
  await loginAs(page, USERS.viewer.id);
  await page.goto("/keys");
  await page.getByRole("button", { name: "Create key" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByRole("combobox", { name: "Access" }).click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText("read");
  await page.keyboard.press("Escape");

  await page.goto("/repositories");
  await expect(page.getByTestId(`repository-${repo}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "New repository" })).toHaveCount(0);
  await page.goto("/repositories/new");
  await expect(page).toHaveURL("/dashboard");
  await page.goto(`/repositories/${repo}/settings`);
  await expect(page).toHaveURL("/dashboard");
  await page.close();
});

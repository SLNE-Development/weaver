import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runRepoCleanup, type CleanupDeps, type Repo } from "@weaver/core";
import { asset, cleanupPolicy, component } from "@weaver/db";
import { npmCleanup } from "./cleanup.js";
import { createHarness, type Harness } from "./test/harness.js";
import { makeTarball, publishBody } from "./test/fixtures.js";

const DAY = 86_400_000;
const REGISTRY = { npm: npmCleanup };

interface Doc {
  versions: Record<string, unknown>;
  "dist-tags": Record<string, string>;
  time: Record<string, string>;
}

let h: Harness;
let repo: Repo;
let deps: CleanupDeps;

/** `/` in a scoped name is percent-encoded in npm URLs. */
const urlOf = (pkg: string) => `npm-hosted/${pkg.replace("/", "%2f")}`;

/** Publishes `pkg@version` as the writer; `tag` defaults to latest. */
async function publish(pkg: string, version: string, tag?: string) {
  const tgz = await makeTarball(pkg, version);
  const res = await h.call("PUT", urlOf(pkg), { token: h.tokens.writer, json: publishBody(pkg, version, tgz, { tag }) });
  expect(res.status).toBe(201);
}

const packument = async (pkg: string) => (await h.call("GET", urlOf(pkg))).json() as Promise<Doc>;
const tarballStatus = async (pkg: string, version: string) =>
  (await h.call("GET", `${urlOf(pkg)}/-/${pkg.split("/").at(-1)}-${version}.tgz`, { token: h.tokens.writer })).status;

/** Stores an enabled policy on the repository. */
async function policy(kind: "keep_last_versions" | "delete_not_downloaded", value: number, groupPrefix: string | null = null) {
  await h.db.insert(cleanupPolicy).values({ repositoryId: repo.id, kind, value, groupPrefix });
}

const run = (now = new Date(), dryRun = false) => runRepoCleanup(deps, REGISTRY, "npm-hosted", now, { dryRun });

beforeAll(async () => {
  h = await createHarness();
  repo = await h.createRepo({ name: "npm-hosted", format: "npm", kind: "hosted", visibility: "public" });
  deps = { db: h.db, stores: h.deps.stores, assets: h.deps.assets, repos: h.deps.repos };
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

beforeEach(async () => {
  await h.db.execute(sql`TRUNCATE npm_package, asset, component, usage_event, cleanup_policy CASCADE`);
});

describe("npm cleanup", () => {
  it("publish registers a component per version with the scope as namespace (without the @, as publish stores it)", async () => {
    await publish("@acme/ui", "1.0.0");
    await publish("plain", "1.0.0");
    const rows = await h.db.select().from(component).orderBy(component.namespace);
    expect(rows.map((r) => [r.namespace, r.name, r.version])).toEqual([
      ["", "plain", "1.0.0"],
      ["acme", "ui", "1.0.0"],
    ]);
  });

  it("keep_last_versions 2 keeps the two newest by publish time", async () => {
    for (const v of ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]) await publish("@acme/ui", v);
    await policy("keep_last_versions", 2);
    const deleted = await run();
    expect(deleted.map((c) => c.key)).toEqual(["npm:@acme/ui@1.0.0", "npm:@acme/ui@2.0.0"]);
    const doc = await packument("@acme/ui");
    expect(Object.keys(doc.versions).sort()).toEqual(["3.0.0", "4.0.0"]);
    expect(doc["dist-tags"]).toEqual({ latest: "4.0.0" });
    expect(doc.time["1.0.0"]).toBeDefined();
    expect(await tarballStatus("@acme/ui", "1.0.0")).toBe(404);
    expect(await tarballStatus("@acme/ui", "4.0.0")).toBe(200);
    expect(await h.db.select().from(component)).toHaveLength(2);
    expect(await h.db.select().from(asset)).toHaveLength(2);
  });

  it("never deletes a dist-tagged version", async () => {
    await publish("@acme/ui", "1.0.0");
    for (const v of ["2.0.0", "3.0.0", "4.0.0"]) await publish("@acme/ui", v, "next");
    await policy("keep_last_versions", 1);
    await run();
    const doc = await packument("@acme/ui");
    expect(Object.keys(doc.versions).sort()).toEqual(["1.0.0", "4.0.0"]);
    expect(doc["dist-tags"]).toEqual({ latest: "1.0.0", next: "4.0.0" });
  });

  it("delete_not_downloaded 30 removes versions not downloaded for 30 days", async () => {
    await publish("@acme/ui", "1.0.0");
    for (const v of ["2.0.0", "3.0.0"]) await publish("@acme/ui", v, "next");
    await publish("@acme/ui", "4.0.0", "next");
    const now = new Date(Date.now() + 60 * DAY);
    await h.db.update(component).set({ lastDownloadedAt: new Date(now.getTime() - 2 * DAY) }).where(eq(component.version, "3.0.0"));
    await policy("delete_not_downloaded", 30);
    const deleted = await run(now);
    // 1.0.0 is latest and 4.0.0 is next: tagged; 3.0.0 was downloaded recently.
    expect(deleted.map((c) => c.key)).toEqual(["npm:@acme/ui@2.0.0"]);
    expect(await tarballStatus("@acme/ui", "2.0.0")).toBe(404);
    expect(await tarballStatus("@acme/ui", "3.0.0")).toBe(200);
  });

  it("scoped package with groupPrefix \"@acme/\" is in scope, \"other\" is not", async () => {
    for (const v of ["1.0.0", "2.0.0"]) await publish("@acme/ui", v);
    await policy("keep_last_versions", 1, "other");
    expect(await run()).toEqual([]);
    await h.db.delete(cleanupPolicy);
    await policy("keep_last_versions", 1, "@acme/");
    expect((await run()).map((c) => c.key)).toEqual(["npm:@acme/ui@1.0.0"]);
  });

  it("groupPrefix matches the full package name, so a name prefix is in scope", async () => {
    for (const v of ["1.0.0", "2.0.0"]) {
      await publish("react-dom", v);
      await publish("@acme/ui-kit", v);
      await publish("other", v);
    }
    await policy("keep_last_versions", 1, "react-");
    expect((await run()).map((c) => c.key)).toEqual(["npm:react-dom@1.0.0"]);
    await h.db.delete(cleanupPolicy);
    await policy("keep_last_versions", 1, "@acme/ui-");
    expect((await run()).map((c) => c.key)).toEqual(["npm:@acme/ui-kit@1.0.0"]);
  });

  it("always keeps the newest version, even without dist-tags", async () => {
    await publish("@acme/ui", "1.0.0");
    await publish("@acme/ui", "2.0.0");
    await h.db.execute(sql`UPDATE npm_package SET document = jsonb_set(document, '{dist-tags}', '{}'::jsonb)`);
    await policy("delete_not_downloaded", 30);
    const deleted = await run(new Date(Date.now() + 90 * DAY));
    expect(deleted.map((c) => c.key)).toEqual(["npm:@acme/ui@1.0.0"]);
    expect(Object.keys((await packument("@acme/ui")).versions)).toEqual(["2.0.0"]);
  });

  it("dryRun deletes nothing", async () => {
    for (const v of ["1.0.0", "2.0.0", "3.0.0"]) await publish("@acme/ui", v);
    await policy("keep_last_versions", 1);
    expect(await run(new Date(), true)).toHaveLength(2);
    expect(Object.keys((await packument("@acme/ui")).versions)).toHaveLength(3);
    expect(await tarballStatus("@acme/ui", "1.0.0")).toBe(200);
  });
});

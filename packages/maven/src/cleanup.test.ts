import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRepoCleanup, type CleanupDeps, type CleanupPolicyRow, type Repo } from "@weaver/core";
import { asset, auditEvent, component } from "@weaver/db";
import { mavenCleanup } from "./cleanup.js";
import { startMavenFixture, type MavenFixture } from "./testing/fixture.js";

const DAY = 86_400_000;

/** The `yyyyMMdd.HHmmss` UTC timestamp Maven puts in snapshot file names. */
const mavenTimestamp = (at: Date) => at.toISOString().replace(/[-:]/g, "").replace("T", ".").slice(0, 15);

/** The `<timestamp>-<n>` of build `n`, deployed `n` seconds after 2026-10-01 12:00 UTC unless `at` is given. */
const stamp = (n: number, at = new Date(Date.UTC(2026, 9, 1, 12, 0, n))) => `${mavenTimestamp(at)}-${n}`;

describe("maven cleanup", () => {
  let fx: MavenFixture;
  let token: string;
  let deps: CleanupDeps;
  let counter = 0;

  beforeAll(async () => {
    fx = await startMavenFixture();
    deps = { db: fx.deps.db, stores: fx.deps.stores, assets: fx.deps.assets, repos: fx.deps.repos };
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  /** A fresh hosted maven repository with a writer token. */
  async function hostedRepo(): Promise<Repo> {
    const repo = await fx.createRepo({ name: `cleanup-${++counter}`, format: "maven", kind: "hosted" });
    token = await fx.token([{ repo: repo.name, access: "write" }]);
    return repo;
  }

  const put = async (repo: Repo, path: string, body = `bytes of ${path}`) => {
    const res = await fx.request("PUT", `${repo.name}/${path}`, { token, body });
    expect(res.status, path).toBe(201);
  };
  const get = (repo: Repo, path: string) => fx.request("GET", `${repo.name}/${path}`, { token });

  /** Publishes a release `g:a:v` as jar + pom + jar.sha1. */
  async function publishRelease(repo: Repo, groupId: string, artifactId: string, version: string) {
    const dir = `${groupId.replaceAll(".", "/")}/${artifactId}/${version}`;
    await put(repo, `${dir}/${artifactId}-${version}.jar`);
    await put(repo, `${dir}/${artifactId}-${version}.jar.sha1`, "0123");
    await put(repo, `${dir}/${artifactId}-${version}.pom`);
  }

  /**
   * Publishes build `n` of `g:a:<base>-SNAPSHOT` as timestamped jar + jar.sha1 + pom, plus a sources
   * jar and a signed jar (`.asc`, `.asc.sha1`) when asked; `at` is the deploy time in the file names.
   */
  async function publishSnapshotBuild(
    repo: Repo,
    groupId: string,
    artifactId: string,
    base: string,
    n: number,
    opts: { sources?: boolean; signed?: boolean; at?: Date } = {},
  ) {
    const dir = `${groupId.replaceAll(".", "/")}/${artifactId}/${base}-SNAPSHOT`;
    const file = `${artifactId}-${base}-${stamp(n, opts.at)}`;
    await put(repo, `${dir}/${file}.jar`);
    await put(repo, `${dir}/${file}.jar.sha1`, "0123");
    await put(repo, `${dir}/${file}.pom`);
    if (opts.sources) await put(repo, `${dir}/${file}-sources.jar`);
    if (opts.signed) {
      await put(repo, `${dir}/${file}.jar.asc`, "-----BEGIN PGP SIGNATURE-----");
      await put(repo, `${dir}/${file}.jar.asc.sha1`, "4567");
    }
  }

  /** A cleanup policy row for `repo` (not stored; the format cleanup takes rows). */
  const policy = (repo: Repo, values: Partial<CleanupPolicyRow> & Pick<CleanupPolicyRow, "kind" | "value">): CleanupPolicyRow => ({
    id: randomUUID(),
    repositoryId: repo.id,
    includeReleases: false,
    groupPrefix: null,
    pattern: null,
    enabled: true,
    createdAt: new Date(),
    ...values,
  });

  const componentsOf = async (repo: Repo) =>
    (await fx.deps.db.select().from(component).where(eq(component.repositoryId, repo.id))).map(
      (c) => `${c.namespace}:${c.name}:${c.version}`,
    );
  const pathsOf = async (repo: Repo) => (await fx.deps.assets.list(repo.id, "")).map((a) => a.path);

  /** Moves the publish and download times of `g:a:v` back to `publishedDaysAgo` (and `downloadedDaysAgo`) before `now`. */
  async function age(repo: Repo, coordinate: string, now: Date, publishedDaysAgo: number, downloadedDaysAgo: number | null = null) {
    const [namespace, name, version] = coordinate.split(":") as [string, string, string];
    const published = new Date(now.getTime() - publishedDaysAgo * DAY);
    const [row] = await fx.deps.db
      .update(component)
      .set({
        createdAt: published,
        lastDownloadedAt: downloadedDaysAgo === null ? null : new Date(now.getTime() - downloadedDaysAgo * DAY),
      })
      .where(
        and(eq(component.repositoryId, repo.id), eq(component.namespace, namespace), eq(component.name, name), eq(component.version, version)),
      )
      .returning({ id: component.id });
    await fx.deps.db.update(asset).set({ createdAt: published, updatedAt: published }).where(eq(asset.componentId, row!.id));
  }

  const later = (days: number) => new Date(Date.now() + days * DAY);

  it("publish registers one component per groupId, artifactId and version", async () => {
    const repo = await hostedRepo();
    await publishRelease(repo, "org.example", "lib", "1.0");
    await publishRelease(repo, "org.example", "lib", "1.1");
    await publishSnapshotBuild(repo, "org.example", "lib", "2.0", 1);
    await publishSnapshotBuild(repo, "org.example", "lib", "2.0", 2);
    await publishRelease(repo, "org.example", "other", "1.0");

    expect((await componentsOf(repo)).sort()).toEqual([
      "org.example:lib:1.0",
      "org.example:lib:1.1",
      "org.example:lib:2.0-SNAPSHOT",
      "org.example:other:1.0",
    ]);
    // Every published file, checksums included, belongs to its version's component.
    const files = await fx.deps.db.select().from(asset).where(eq(asset.repositoryId, repo.id));
    expect(files).toHaveLength(15);
    expect(files.every((f) => f.componentId !== null)).toBe(true);
  });

  it("keep_last_snapshot_builds 2 deletes all files of older builds and their checksums", async () => {
    const repo = await hostedRepo();
    for (let n = 1; n <= 4; n++) await publishSnapshotBuild(repo, "org.example", "lib", "1.0", n, { sources: n <= 3 });
    await publishRelease(repo, "org.example", "lib", "0.9");
    const dir = "org/example/lib/1.0-SNAPSHOT";

    const deleted = await mavenCleanup.run(deps, repo, [policy(repo, { kind: "keep_last_snapshot_builds", value: 2 })], new Date(), {
      dryRun: false,
    });
    expect(deleted).toEqual([
      {
        repository: repo.name,
        key: "maven:org.example:lib:1.0-SNAPSHOT#1",
        label: "org.example:lib:1.0-SNAPSHOT build 1",
        reason: "keep last 2 snapshot builds",
      },
      {
        repository: repo.name,
        key: "maven:org.example:lib:1.0-SNAPSHOT#2",
        label: "org.example:lib:1.0-SNAPSHOT build 2",
        reason: "keep last 2 snapshot builds",
      },
    ]);

    const remaining = (await pathsOf(repo)).filter((p) => p.startsWith(`${dir}/`));
    expect(remaining.sort()).toEqual(
      [
        `lib-1.0-${stamp(3)}-sources.jar`,
        `lib-1.0-${stamp(3)}.jar`,
        `lib-1.0-${stamp(3)}.jar.sha1`,
        `lib-1.0-${stamp(3)}.pom`,
        `lib-1.0-${stamp(4)}.jar`,
        `lib-1.0-${stamp(4)}.jar.sha1`,
        `lib-1.0-${stamp(4)}.pom`,
      ].map((f) => `${dir}/${f}`),
    );
    expect((await get(repo, `${dir}/lib-1.0-${stamp(1)}.jar`)).status).toBe(404);
    expect((await get(repo, `${dir}/lib-1.0-${stamp(3)}.jar`)).status).toBe(200);

    const metadata = await get(repo, `${dir}/maven-metadata.xml`);
    expect(metadata.status).toBe(200);
    const xml = await metadata.text();
    expect(xml).toContain("<buildNumber>4</buildNumber>");
    const values = [...xml.matchAll(/<value>([^<]+)<\/value>/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([`1.0-${stamp(3)}`, `1.0-${stamp(4)}`, `1.0-${stamp(4)}`]);
    expect(await componentsOf(repo)).toContain("org.example:lib:1.0-SNAPSHOT");

    const audits = await fx.deps.db.select().from(auditEvent).where(eq(auditEvent.action, "cleanup.delete"));
    expect(audits.map((a) => a.target)).toEqual(
      expect.arrayContaining([`${repo.name}/org.example:lib:1.0-SNAPSHOT#1`, `${repo.name}/org.example:lib:1.0-SNAPSHOT#2`]),
    );
  });

  it("delete_stale_snapshots 30 deletes a snapshot version not published to for 30 days and keeps releases", async () => {
    const repo = await hostedRepo();
    const now = later(0);
    await publishSnapshotBuild(repo, "org.example", "lib", "1.0", 1, { at: new Date(now.getTime() - 32 * DAY) });
    await publishSnapshotBuild(repo, "org.example", "lib", "1.0", 2, { at: new Date(now.getTime() - 31 * DAY) });
    await publishSnapshotBuild(repo, "org.example", "lib", "2.0", 1, { at: new Date(now.getTime() - 10 * DAY) });
    await publishRelease(repo, "org.example", "lib", "0.9");
    await age(repo, "org.example:lib:1.0-SNAPSHOT", now, 31);
    await age(repo, "org.example:lib:2.0-SNAPSHOT", now, 10);
    await age(repo, "org.example:lib:0.9", now, 400);

    const deleted = await mavenCleanup.run(deps, repo, [policy(repo, { kind: "delete_stale_snapshots", value: 30 })], now, {
      dryRun: false,
    });
    expect(deleted).toEqual([
      {
        repository: repo.name,
        key: "maven:org.example:lib:1.0-SNAPSHOT#all",
        label: "org.example:lib:1.0-SNAPSHOT",
        reason: "snapshot not published for 30 days",
      },
    ]);
    expect((await componentsOf(repo)).sort()).toEqual(["org.example:lib:0.9", "org.example:lib:2.0-SNAPSHOT"]);
    expect((await pathsOf(repo)).some((p) => p.includes("/1.0-SNAPSHOT/"))).toBe(false);

    const xml = await (await get(repo, "org/example/lib/maven-metadata.xml")).text();
    expect(xml).not.toContain("1.0-SNAPSHOT");
    expect(xml).toContain("<version>0.9</version>");
    expect(xml).toContain("<version>2.0-SNAPSHOT</version>");
    expect((await get(repo, "org/example/lib/1.0-SNAPSHOT/maven-metadata.xml")).status).toBe(404);
  });

  it("a timestamped snapshot is aged by its newest build stamp, not by when its rows were written", async () => {
    const repo = await hostedRepo();
    const now = later(0);
    // Uploaded just now, but stamped 40 days ago (e.g. copied in from another repository).
    await publishSnapshotBuild(repo, "org.example", "lib", "1.0", 1, { at: new Date(now.getTime() - 40 * DAY) });
    // Rows aged 40 days, but the newest build is stamped yesterday.
    await publishSnapshotBuild(repo, "org.example", "lib", "2.0", 1, { at: new Date(now.getTime() - 41 * DAY) });
    await publishSnapshotBuild(repo, "org.example", "lib", "2.0", 2, { at: new Date(now.getTime() - DAY) });
    await age(repo, "org.example:lib:2.0-SNAPSHOT", now, 40);

    const planned = await mavenCleanup.run(deps, repo, [policy(repo, { kind: "delete_stale_snapshots", value: 30 })], now, {
      dryRun: true,
    });
    expect(planned.map((c) => c.key)).toEqual(["maven:org.example:lib:1.0-SNAPSHOT#all"]);
  });

  it("a fixed-name snapshot re-deployed in place survives delete_stale_snapshots", async () => {
    const repo = await hostedRepo();
    const dir = "org/example/lib/1.0-SNAPSHOT";
    await put(repo, `${dir}/lib-1.0-SNAPSHOT.jar`, "first");
    await put(repo, `${dir}/lib-1.0-SNAPSHOT.pom`, "first");
    const now = later(0);
    await age(repo, "org.example:lib:1.0-SNAPSHOT", now, 40);
    const stale = [policy(repo, { kind: "delete_stale_snapshots", value: 30 })];
    // Not deployed for 40 days: planned.
    expect((await mavenCleanup.run(deps, repo, stale, now, { dryRun: true })).map((c) => c.key)).toEqual([
      "maven:org.example:lib:1.0-SNAPSHOT#all",
    ]);

    // Re-deployed in place today: the upsert keeps createdAt, so the deploy time comes from updatedAt.
    await put(repo, `${dir}/lib-1.0-SNAPSHOT.jar`, "second");
    expect(await mavenCleanup.run(deps, repo, stale, now, { dryRun: false })).toEqual([]);
    expect(await pathsOf(repo)).toEqual([`${dir}/lib-1.0-SNAPSHOT.jar`, `${dir}/lib-1.0-SNAPSHOT.pom`]);
    expect(await (await get(repo, `${dir}/lib-1.0-SNAPSHOT.jar`)).text()).toBe("second");
  });

  it("signatures and their checksums go with their build", async () => {
    const repo = await hostedRepo();
    for (let n = 1; n <= 2; n++) await publishSnapshotBuild(repo, "org.example", "lib", "1.0", n, { signed: true });
    const dir = "org/example/lib/1.0-SNAPSHOT";

    const deleted = await mavenCleanup.run(deps, repo, [policy(repo, { kind: "keep_last_snapshot_builds", value: 1 })], new Date(), {
      dryRun: false,
    });
    expect(deleted.map((c) => c.key)).toEqual(["maven:org.example:lib:1.0-SNAPSHOT#1"]);
    expect((await pathsOf(repo)).sort()).toEqual(
      [`lib-1.0-${stamp(2)}.jar`, `lib-1.0-${stamp(2)}.jar.asc`, `lib-1.0-${stamp(2)}.jar.asc.sha1`, `lib-1.0-${stamp(2)}.jar.sha1`, `lib-1.0-${stamp(2)}.pom`].map(
        (f) => `${dir}/${f}`,
      ),
    );
  });

  it("delete_not_downloaded 30 spares releases unless includeReleases, and keeps what was downloaded recently", async () => {
    const repo = await hostedRepo();
    await publishRelease(repo, "org.example", "lib", "1.0");
    await publishRelease(repo, "org.example", "lib", "1.1");
    await publishSnapshotBuild(repo, "org.example", "lib", "2.0", 1);
    await publishSnapshotBuild(repo, "org.example", "lib", "3.0", 1);
    const now = later(0);
    await age(repo, "org.example:lib:1.0", now, 100);
    await age(repo, "org.example:lib:1.1", now, 100, 5);
    await age(repo, "org.example:lib:2.0-SNAPSHOT", now, 100, 45);
    await age(repo, "org.example:lib:3.0-SNAPSHOT", now, 100, 5);

    const snapshotsOnly = await mavenCleanup.run(deps, repo, [policy(repo, { kind: "delete_not_downloaded", value: 30 })], now, {
      dryRun: false,
    });
    expect(snapshotsOnly.map((c) => c.key)).toEqual(["maven:org.example:lib:2.0-SNAPSHOT#all"]);
    expect(snapshotsOnly[0]!.reason).toBe("not downloaded for 30 days");
    expect((await componentsOf(repo)).sort()).toEqual(["org.example:lib:1.0", "org.example:lib:1.1", "org.example:lib:3.0-SNAPSHOT"]);

    const withReleases = await mavenCleanup.run(
      deps,
      repo,
      [policy(repo, { kind: "delete_not_downloaded", value: 30, includeReleases: true })],
      now,
      { dryRun: false },
    );
    expect(withReleases.map((c) => c.key)).toEqual(["maven:org.example:lib:1.0#all"]);
    expect((await componentsOf(repo)).sort()).toEqual(["org.example:lib:1.1", "org.example:lib:3.0-SNAPSHOT"]);
    expect((await get(repo, "org/example/lib/1.0/lib-1.0.jar")).status).toBe(404);
    expect((await get(repo, "org/example/lib/1.1/lib-1.1.jar")).status).toBe(200);
  });

  it("groupPrefix limits the scope", async () => {
    const repo = await hostedRepo();
    await publishRelease(repo, "org.example.lib", "core", "1.0");
    await publishRelease(repo, "com.other", "core", "1.0");
    const now = later(0);
    await age(repo, "org.example.lib:core:1.0", now, 100);
    await age(repo, "com.other:core:1.0", now, 100);

    const deleted = await mavenCleanup.run(
      deps,
      repo,
      [policy(repo, { kind: "delete_not_downloaded", value: 30, includeReleases: true, groupPrefix: "org.example" })],
      now,
      { dryRun: false },
    );
    expect(deleted.map((c) => c.key)).toEqual(["maven:org.example.lib:core:1.0#all"]);
    expect(await componentsOf(repo)).toEqual(["com.other:core:1.0"]);
  });

  it("dryRun returns candidates and deletes nothing", async () => {
    const repo = await hostedRepo();
    for (let n = 1; n <= 3; n++) await publishSnapshotBuild(repo, "org.example", "lib", "1.0", n);
    const before = await pathsOf(repo);
    const auditsBefore = (await fx.deps.db.select().from(auditEvent)).length;

    const planned = await mavenCleanup.run(deps, repo, [policy(repo, { kind: "keep_last_snapshot_builds", value: 1 })], new Date(), {
      dryRun: true,
    });
    expect(planned.map((c) => c.key)).toEqual(["maven:org.example:lib:1.0-SNAPSHOT#1", "maven:org.example:lib:1.0-SNAPSHOT#2"]);
    expect(await pathsOf(repo)).toEqual(before);
    expect((await fx.deps.db.select().from(auditEvent)).length).toBe(auditsBefore);
  });

  it("deleting the last version removes artifact metadata", async () => {
    const repo = await hostedRepo();
    await publishRelease(repo, "org.example", "gone", "1.0");
    expect((await get(repo, "org/example/gone/maven-metadata.xml")).status).toBe(200);
    const now = later(0);
    await age(repo, "org.example:gone:1.0", now, 100);

    await mavenCleanup.run(deps, repo, [policy(repo, { kind: "delete_not_downloaded", value: 30, includeReleases: true })], now, {
      dryRun: false,
    });
    expect(await componentsOf(repo)).toEqual([]);
    expect(await pathsOf(repo)).toEqual([]);
    expect((await get(repo, "org/example/gone/maven-metadata.xml")).status).toBe(404);
    expect((await get(repo, "org/example/gone/maven-metadata.xml.sha1")).status).toBe(404);
  });

  it("never touches a mirror cache through the runner", async () => {
    const mirror = await fx.createRepo({
      name: `cleanup-mirror-${++counter}`,
      format: "maven",
      kind: "mirror",
      upstreams: [{ url: "https://repo.example.org/maven2/", authType: "none" }],
    });
    const cached = await fx.deps.assets.put({
      repo: mirror,
      path: "org/example/lib/1.0/lib-1.0.jar",
      body: Readable.from([Buffer.from("cached")]),
      origin: "cache",
      component: { namespace: "org.example", name: "lib", version: "1.0" },
    });
    await fx.deps.db.update(asset).set({ createdAt: new Date(0) }).where(eq(asset.id, cached.id));
    expect(await runRepoCleanup(deps, { maven: mavenCleanup }, mirror.name, later(1000), { dryRun: false })).toEqual([]);
    // Even when called on a mirror directly, only hosted content is ever planned.
    const everything = policy(mirror, { kind: "delete_not_downloaded", value: 1, includeReleases: true });
    expect(await mavenCleanup.run(deps, mirror, [everything], later(1000), { dryRun: false })).toEqual([]);
    expect(await fx.deps.assets.find(mirror.id, cached.path)).not.toBeNull();
  });
});

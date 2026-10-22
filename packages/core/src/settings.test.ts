import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditEvent } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import type { Principal } from "./permissions.js";
import type { StoreId } from "./storage/index.js";
import { getSettings, updateSettings } from "./settings.js";

const LOCAL = { primaryStore: "local" as StoreId, configuredStores: ["local"] as StoreId[] };
const ONLY_LOCAL = { configuredStores: ["local"] as StoreId[], primaryStore: "local" as StoreId };
const BOTH = { configuredStores: ["local", "s3"] as StoreId[], primaryStore: "local" as StoreId };

const admin: Principal = { kind: "user", userId: "user-admin", role: "admin" };
const maintainer: Principal = { kind: "user", userId: "user-maintainer", role: "maintainer" };

describe("settings", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE setting, audit_event`);
  });

  it("defaults to anonymous view off on an empty database", async () => {
    expect(await getSettings(testDb.db, LOCAL)).toEqual({ anonymousView: false, defaultCacheStore: "local" });
  });

  it("persists an update, returns the new settings and audits the change", async () => {
    expect(await updateSettings(testDb.db, { anonymousView: true }, admin, ONLY_LOCAL)).toEqual({ anonymousView: true, defaultCacheStore: "local" });
    expect(await getSettings(testDb.db, LOCAL)).toEqual({ anonymousView: true, defaultCacheStore: "local" });

    expect(await updateSettings(testDb.db, { anonymousView: false }, admin, ONLY_LOCAL)).toEqual({ anonymousView: false, defaultCacheStore: "local" });
    expect(await getSettings(testDb.db, LOCAL)).toEqual({ anonymousView: false, defaultCacheStore: "local" });

    const audits = await testDb.db
      .select({ actorType: auditEvent.actorType, actorId: auditEvent.actorId, action: auditEvent.action, details: auditEvent.details })
      .from(auditEvent)
      .orderBy(auditEvent.at);
    expect(audits).toEqual([
      { actorType: "user", actorId: "user-admin", action: "settings.update", details: { anonymousView: true } },
      { actorType: "user", actorId: "user-admin", action: "settings.update", details: { anonymousView: false } },
    ]);
  });

  it("leaves settings untouched for an empty patch", async () => {
    await updateSettings(testDb.db, { anonymousView: true }, admin, ONLY_LOCAL);
    expect(await updateSettings(testDb.db, {}, admin, ONLY_LOCAL)).toEqual({ anonymousView: true, defaultCacheStore: "local" });
  });

  it("refuses updates from non-admins", async () => {
    await expect(updateSettings(testDb.db, { anonymousView: true }, maintainer, ONLY_LOCAL)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await getSettings(testDb.db, LOCAL)).toEqual({ anonymousView: false, defaultCacheStore: "local" });
  });

  it("defaults the cache store to the primary store", async () => {
    expect((await getSettings(testDb.db, { primaryStore: "s3", configuredStores: ["s3"] })).defaultCacheStore).toBe("s3");
    expect((await getSettings(testDb.db, LOCAL)).defaultCacheStore).toBe("local");
  });

  it("rejects a cache store that is not configured", async () => {
    await expect(updateSettings(testDb.db, { defaultCacheStore: "s3" }, admin, ONLY_LOCAL)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect((await getSettings(testDb.db, LOCAL)).defaultCacheStore).toBe("local");
  });

  it("round-trips a configured cache store and audits it", async () => {
    expect(await updateSettings(testDb.db, { defaultCacheStore: "s3" }, admin, BOTH)).toEqual({
      anonymousView: false,
      defaultCacheStore: "s3",
    });
    expect((await getSettings(testDb.db, BOTH)).defaultCacheStore).toBe("s3");
    const [audit] = await testDb.db.select({ details: auditEvent.details }).from(auditEvent);
    expect(audit?.details).toEqual({ defaultCacheStore: "s3" });
  });

  it("falls back to the primary store when the stored store is no longer configured", async () => {
    await updateSettings(testDb.db, { defaultCacheStore: "s3" }, admin, BOTH);
    expect((await getSettings(testDb.db, LOCAL)).defaultCacheStore).toBe("local");
    expect((await getSettings(testDb.db, BOTH)).defaultCacheStore).toBe("s3");
  });

  it("falls back to the primary store when the stored value is not a store id", async () => {
    await testDb.db.execute(sql`INSERT INTO setting (key, value) VALUES ('defaultCacheStore', '"nope"'::jsonb)`);
    expect((await getSettings(testDb.db, LOCAL)).defaultCacheStore).toBe("local");
  });
});

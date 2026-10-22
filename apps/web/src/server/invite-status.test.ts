import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { invite, user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { generateInviteToken, hashInviteToken } from "./invite";
import { getInviteStatus } from "./invite-status";

let testDb: Awaited<ReturnType<typeof startTestDb>>;
let db: Db;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
});

afterAll(async () => {
  await testDb?.stop();
});

const DAY = 24 * 60 * 60 * 1000;

async function createInvite(values: Partial<typeof invite.$inferInsert> = {}) {
  const token = generateInviteToken();
  await db.insert(invite).values({
    tokenHash: hashInviteToken(token),
    role: "maintainer",
    expiresAt: new Date(Date.now() + DAY),
    ...values,
  });
  return token;
}

describe("getInviteStatus", () => {
  it("describes a usable invite with its role, note and expiry", async () => {
    const expiresAt = new Date(Date.now() + 3 * DAY);
    const token = await createInvite({ note: "Welcome, Ada", expiresAt });
    expect(await getInviteStatus(db, token)).toEqual({ kind: "valid", role: "maintainer", note: "Welcome, Ada", expiresAt });
  });

  it("reports unknown tokens", async () => {
    expect(await getInviteStatus(db, generateInviteToken())).toEqual({ kind: "unknown" });
    expect(await getInviteStatus(db, "")).toEqual({ kind: "unknown" });
  });

  it("reports used invites, even when they have expired since", async () => {
    const now = new Date();
    const [member] = await db
      .insert(user)
      .values({ id: randomUUID(), name: "m", email: `${randomUUID()}@example.com`, createdAt: now, updatedAt: now })
      .returning();
    const token = await createInvite({ usedAt: now, usedByUserId: member!.id, expiresAt: new Date(Date.now() - DAY) });
    expect(await getInviteStatus(db, token)).toEqual({ kind: "used" });
  });

  it("reports expired invites", async () => {
    const token = await createInvite({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getInviteStatus(db, token)).toEqual({ kind: "expired" });
  });
});

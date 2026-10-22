import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { account, createDb, invite, session, user } from "@weaver/db";
import { BASE_URL, INVITES, SESSION_COOKIE, STATE_FILE, USERS, sessionToken } from "./fixtures";
import { sessionCookieValue } from "./helpers";
import { seedArtifacts } from "./seed-artifacts";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Seeds the e2e database that `serve.ts` started: the fixture users, a Better Auth session for
 * each (real OAuth can't run in tests; `loginAs` sends the matching cookie), a GitHub account for
 * `githubViewer`, the fixture invites and the browse fixtures (`seed-artifacts.ts`). Settings stay
 * at their defaults (anonymous view off).
 */
export default async function globalSetup(): Promise<void> {
  const { databaseUrl } = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { databaseUrl: string };
  const db = createDb(databaseUrl);
  try {
    // `serve.ts` starts a fresh database on every run, so there is nothing to clean up first.
    const now = new Date();

    await db.insert(user).values(
      Object.values(USERS).map((u) => ({ ...u, emailVerified: true, createdAt: now, updatedAt: now })),
    );
    await db.insert(session).values(
      Object.values(USERS).map((u) => ({
        id: `session-${u.id}`,
        token: sessionToken(u.id),
        userId: u.id,
        expiresAt: new Date(now.getTime() + 7 * DAY),
        createdAt: now,
        updatedAt: now,
      })),
    );
    await db.insert(account).values({
      id: "account-e2e-github-viewer",
      accountId: "1000001",
      providerId: "github",
      userId: USERS.githubViewer.id,
      createdAt: now,
      updatedAt: now,
    });

    const hash = (token: string) => createHash("sha256").update(token).digest("hex");
    await db.insert(invite).values([
      { tokenHash: hash(INVITES.viewer), role: "viewer", note: "Welcome to the team", expiresAt: new Date(now.getTime() + 7 * DAY) },
      { tokenHash: hash(INVITES.expired), role: "maintainer", expiresAt: new Date(now.getTime() - DAY) },
    ]);
    await seedArtifacts(db);
  } finally {
    await db.$client.end();
  }
  await warmUp();
}

/** Pages compiled up front, so `next dev`'s first-visit compilation doesn't eat into test timeouts. */
const WARM_UP_PATHS = [
  "/",
  "/login",
  "/dashboard",
  "/account",
  `/invite/${INVITES.viewer}`,
  "/browse",
  "/browse/releases",
  "/browse/releases/dev.example/demo",
  "/browse/releases/dev.example/demo/1.0.0",
];

async function warmUp(): Promise<void> {
  const cookie = `${SESSION_COOKIE}=${await sessionCookieValue(USERS.admin.id)}`;
  for (const path of WARM_UP_PATHS) {
    const response = await fetch(`${BASE_URL}${path}`, { headers: { cookie }, redirect: "manual" });
    await response.arrayBuffer();
  }
}

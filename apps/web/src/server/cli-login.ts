import { TRPCError } from "@trpc/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { encryptSecret, maxKeyAccess, recordAudit, type Format, type Kind, type Principal, type Role } from "@weaver/core";
import { apikey, npmLoginSession, repository, type Db } from "@weaver/db";
import type { KeyFormValues } from "@/lib/api-keys";
import { issueApiKey, type IssueKeyInput } from "./api-keys";
import type { Auth } from "./auth";

/**
 * What the browser login page shows for a session id: a pending session with the repository the CLI
 * targeted, the address and user agent of the CLI that started it, when it started and when it
 * expires; or `gone` (missing, expired or already answered).
 */
export type CliLoginView =
  | {
      state: "pending";
      repository: { name: string; format: Format; kind: Kind };
      requester: { ip: string | null; userAgent: string | null };
      createdAt: Date;
      expiresAt: Date;
    }
  | { state: "gone" };

/** Whether the CLI that started a login and the browser approving it share a client address. */
export type ClientMatch = "same" | "different" | "unknown";

const GONE = "This login link has expired. Run npm login again.";

/** Compares the requesting CLI's address with the approving browser's; `unknown` when either is missing. */
export function compareClients(requesterIp: string | null, approverIp: string | null): ClientMatch {
  if (requesterIp === null || approverIp === null) return "unknown";
  return requesterIp === approverIp ? "same" : "different";
}

/** Loads the login session `id` for the browser page; see {@link CliLoginView}. */
export async function loadCliLogin(db: Db, id: string): Promise<CliLoginView> {
  const [row] = await db
    .select({
      status: npmLoginSession.status,
      requesterIp: npmLoginSession.requesterIp,
      requesterUserAgent: npmLoginSession.requesterUserAgent,
      createdAt: npmLoginSession.createdAt,
      expiresAt: npmLoginSession.expiresAt,
      name: repository.name,
      format: repository.format,
      kind: repository.kind,
    })
    .from(npmLoginSession)
    .innerJoin(repository, eq(repository.id, npmLoginSession.repositoryId))
    .where(eq(npmLoginSession.id, id))
    .limit(1);
  if (!row || row.status !== "pending" || row.expiresAt.getTime() <= Date.now()) return { state: "gone" };
  return {
    state: "pending",
    repository: { name: row.name, format: row.format, kind: row.kind },
    requester: { ip: row.requesterIp, userAgent: row.requesterUserAgent },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** The approving browser, and a test hook that runs after the key is issued and before the session is approved. */
export interface ApproverContext {
  /** Client address of the approving browser, when known. */
  ip: string | null;
  /** Test hook: runs between issuing the key and approving the session, to simulate a racing answer. */
  beforeApprove?: () => Promise<void>;
}

/**
 * Approves the login session `id`: issues an API key for `principal` with `input` (validated exactly
 * like the keys dialog) and stores it encrypted with `secretKey`, plus its id, for the CLI to collect
 * once, recording an `npm.login.approve` audit entry with the requester and approver addresses. The
 * session is re-checked as pending and unexpired in the same statement that approves it; when that
 * matches no row (expired, denied, approved meanwhile) the new key is deleted again with a
 * `key.revoke` audit entry and the call fails with `NOT_FOUND`.
 */
export async function approveCliLogin(
  deps: { db: Db; auth: Auth; secretKey: Buffer },
  principal: Extract<Principal, { kind: "user" }>,
  id: string,
  input: IssueKeyInput,
  approver: ApproverContext = { ip: null },
): Promise<void> {
  const { db, secretKey } = deps;
  // Fail fast without creating a key that would be deleted right away.
  if ((await loadCliLogin(db, id)).state !== "pending") throw new TRPCError({ code: "NOT_FOUND", message: GONE });
  const created = await issueApiKey(deps, principal, input);
  let approved = false;
  try {
    await approver.beforeApprove?.();
    approved = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(npmLoginSession)
        .set({
          status: "approved",
          userId: principal.userId,
          apiKeyId: created.id,
          tokenCiphertext: encryptSecret(secretKey, created.key),
        })
        .where(and(eq(npmLoginSession.id, id), eq(npmLoginSession.status, "pending"), gt(npmLoginSession.expiresAt, sql`now()`)))
        .returning({
          repositoryId: npmLoginSession.repositoryId,
          requesterIp: npmLoginSession.requesterIp,
          requesterUserAgent: npmLoginSession.requesterUserAgent,
        });
      if (!row) return false;
      const [repo] = await tx.select({ name: repository.name }).from(repository).where(eq(repository.id, row.repositoryId));
      await recordAudit(tx, {
        actor: principal,
        action: "npm.login.approve",
        target: id,
        details: {
          session: id,
          repository: repo?.name ?? null,
          keyId: created.id,
          requesterIp: row.requesterIp,
          requesterUserAgent: row.requesterUserAgent,
          approverIp: approver.ip,
        },
      });
      return true;
    });
  } finally {
    if (!approved) {
      await db.transaction(async (tx) => {
        await tx.delete(apikey).where(eq(apikey.id, created.id));
        await recordAudit(tx, {
          actor: principal,
          action: "key.revoke",
          target: created.id,
          details: { name: input.name, userId: principal.userId, reason: "npm login was answered or expired meanwhile", session: id },
        });
      });
    }
  }
  if (!approved) throw new TRPCError({ code: "NOT_FOUND", message: GONE });
}

/** Denies the login session `id` if it is still pending and unexpired; the CLI's next poll gets 403. */
export async function denyCliLogin(db: Db, id: string): Promise<void> {
  await db
    .update(npmLoginSession)
    .set({ status: "denied" })
    .where(and(eq(npmLoginSession.id, id), eq(npmLoginSession.status, "pending"), gt(npmLoginSession.expiresAt, sql`now()`)));
}

/** `yyyy-mm-dd` of `date` in UTC. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Pre-filled form: name "npm login <yyyy-mm-dd>", expiry "90", one row for the target repo with write
 * when the role allows, the repository is not a group (read-only) and the login came from the
 * approving browser's own address (`clients` is `same`); read otherwise.
 */
export function defaultCliLoginForm(
  repo: string,
  role: Role,
  today: Date,
  kind: Kind = "hosted",
  clients: ClientMatch = "same",
): KeyFormValues {
  const access = maxKeyAccess(role) === "write" && kind !== "group" && clients === "same" ? "write" : "read";
  return { name: `npm login ${isoDay(today)}`, expiry: "90", permissions: [{ repository: repo, groupPrefix: "", access }] };
}

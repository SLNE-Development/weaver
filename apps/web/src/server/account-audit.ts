import { count, eq } from "drizzle-orm";
import type { BetterAuthOptions } from "better-auth";
import { recordAudit } from "@weaver/core";
import { account, user, type Db } from "@weaver/db";
import { effectiveRole } from "./roles";

type AccountHooks = NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["account"]>;

/** Records an audit entry for a provider account change, acted by the account's owner. */
async function auditAccount(db: Db, action: "account.link" | "account.unlink", row: { userId: string; providerId: string }) {
  const [owner] = await db.select({ role: user.role }).from(user).where(eq(user.id, row.userId));
  if (!owner) return;
  await db.transaction((tx) =>
    recordAudit(tx, {
      actor: { kind: "user", userId: row.userId, role: effectiveRole(owner.role) },
      action,
      target: row.userId,
      details: { provider: row.providerId },
    }),
  );
}

/**
 * Better Auth account hooks that audit connecting (`account.link`) and disconnecting
 * (`account.unlink`) a sign-in provider on the Account page. Both run after Better Auth committed
 * the change. The account created together with a new user is not a link (that is audited as
 * `user.create`): a link is any account a user gets while already holding another one.
 */
export function accountAuditHooks(db: Db): AccountHooks {
  return {
    create: {
      after: async (created) => {
        const [row] = await db.select({ n: count() }).from(account).where(eq(account.userId, created.userId));
        if ((row?.n ?? 0) > 1) await auditAccount(db, "account.link", created);
      },
    },
    delete: {
      after: async (deleted) => {
        await auditAccount(db, "account.unlink", deleted);
      },
    },
  };
}

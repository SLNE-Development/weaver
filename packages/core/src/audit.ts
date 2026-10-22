import { auditEvent, type Tx } from "@weaver/db";
import type { Principal } from "./permissions.js";

/** One audit log entry; `actor` is the acting principal, or `"system"` for scheduled jobs. */
export interface AuditEntry {
  actor: Principal | "system";
  action: string;
  target: string;
  details?: unknown;
  forced?: boolean;
}

function actorOf(actor: Principal | "system"): {
  actorType: "user" | "apikey" | "anonymous" | "system";
  actorId: string | null;
} {
  if (actor === "system") return { actorType: "system", actorId: null };
  switch (actor.kind) {
    case "anonymous":
      return { actorType: "anonymous", actorId: null };
    case "user":
      return { actorType: "user", actorId: actor.userId };
    case "apikey":
      return { actorType: "apikey", actorId: actor.keyId };
  }
}

/** Writes an audit event inside the caller's transaction, so it commits or rolls back with the change. */
export async function recordAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.insert(auditEvent).values({
    ...actorOf(e.actor),
    action: e.action,
    target: e.target,
    details: e.details ?? null,
    forced: e.forced ?? false,
  });
}

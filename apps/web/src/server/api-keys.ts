import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { maxKeyAccess, recordAudit, type Access, type Format, type Kind, type Principal } from "@weaver/core";
import { apikey, repoPermission, repository, type Db } from "@weaver/db";
import type { Auth } from "./auth";
import { groupPrefix, repositoryName } from "./trpc/helpers";

/** Prefix of every API key secret Weaver issues, so leaked keys are recognisable. */
export const API_KEY_PREFIX = "pl_";

/** What a new API key is called, how long it lives and what it may access. */
export interface IssueKeyInput {
  name: string;
  /** Days until the key expires; omitted for a key that never expires. */
  expiresInDays?: number;
  permissions: Array<{ repository: string; groupPrefix: string | null; access: Access }>;
}

/** Validates (and normalises) untrusted input into an {@link IssueKeyInput}: name 1–32 chars, expiry 1–365 days, 1–100 entries. */
export const issueKeyInput = z.object({
  name: z.string().trim().min(1).max(32),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  permissions: z
    .array(z.object({ repository: repositoryName, groupPrefix, access: z.enum(["read", "write"]) }))
    .min(1)
    .max(100),
});

/**
 * Why a key entry could never grant anything, or null when it can: groups are read-only, and group
 * prefixes narrow only proto hosted and proto mirror repositories (their artifacts have groups).
 */
function uselessEntry(
  repo: { name: string; format: Format; kind: Kind },
  entry: { groupPrefix: string | null; access: Access },
): string | null {
  if (entry.access === "write" && repo.kind === "group") {
    return `${repo.name} is a group, and groups are read-only; grant write on its members instead`;
  }
  if (entry.groupPrefix !== null && (repo.format !== "proto" || repo.kind === "group")) {
    return `A group prefix only applies to proto hosted and proto mirror repositories; remove it for ${repo.name}`;
  }
  return null;
}

/**
 * Creates an API key owned by `principal` with one `repoPermission` row per entry and records the
 * `key.create` audit entry; returns `{ id, key }`, the only time the secret is available. Viewers may
 * only grant `read` (`FORBIDDEN` otherwise); unknown repositories and entries that can never grant
 * anything (write on a group, a group prefix outside proto hosted/mirror) are `BAD_REQUEST`. When the
 * permission rows can't be written, the key is deleted again.
 */
export async function issueApiKey(
  deps: { db: Db; auth: Auth },
  principal: Extract<Principal, { kind: "user" }>,
  input: IssueKeyInput,
): Promise<{ id: string; key: string }> {
  const { db, auth } = deps;
  if (maxKeyAccess(principal.role) === "read" && input.permissions.some((p) => p.access === "write")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Viewers can only create read-only keys" });
  }
  const names = [...new Set(input.permissions.map((p) => p.repository))];
  const byName = new Map(
    (
      await db
        .select({ id: repository.id, name: repository.name, format: repository.format, kind: repository.kind })
        .from(repository)
        .where(inArray(repository.name, names))
    ).map((r) => [r.name, r]),
  );
  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown repositories: ${unknown.join(", ")}` });
  }
  for (const entry of input.permissions) {
    const problem = uselessEntry(byName.get(entry.repository)!, entry);
    if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
  }

  const created = await auth.api.createApiKey({
    body: {
      userId: principal.userId,
      name: input.name,
      prefix: API_KEY_PREFIX,
      expiresIn: input.expiresInDays ? input.expiresInDays * 86_400 : null,
    },
  });
  try {
    await db.transaction(async (tx) => {
      await tx.insert(repoPermission).values(
        input.permissions.map(({ repository: name, groupPrefix: prefix, access }) => ({
          apiKeyId: created.id,
          repositoryId: byName.get(name)!.id,
          groupPrefix: prefix,
          access,
        })),
      );
      await recordAudit(tx, {
        actor: principal,
        action: "key.create",
        target: created.id,
        details: { name: input.name, expiresInDays: input.expiresInDays ?? null, permissions: input.permissions },
      });
    });
  } catch (error) {
    // A key without its permission rows must not survive.
    await db.delete(apikey).where(eq(apikey.id, created.id));
    throw error;
  }
  return { id: created.id, key: created.key };
}

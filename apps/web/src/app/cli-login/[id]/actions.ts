"use server";

import { headers } from "next/headers";
import { TRPCError } from "@trpc/server";
import { requestIp } from "@weaver/npm";
import { keyFormSchema, toCreateKeyInput, type KeyFormValues } from "@/lib/api-keys";
import { issueKeyInput } from "@/server/api-keys";
import { approveCliLogin, denyCliLogin } from "@/server/cli-login";
import { getServerContext } from "@/server/context";
import { getAppSession } from "@/server/session";

/** The outcome of a login page action: done, or a message to show next to the form. */
export type CliLoginActionResult = { ok: true } | { ok: false; error: string };

const SIGNED_OUT: CliLoginActionResult = { ok: false, error: "Your session has ended. Sign in again to authorize npm login." };

/** Whether `id` can be a login session id at all (random 32 bytes, base64url). */
function plausibleId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 100;
}

/**
 * Approves the npm login session `id` with a new key built from the submitted form `values`, owned by
 * the signed-in user (the session cookie; server actions only accept same-origin POSTs), recording the
 * browser's client address as the approver's. Rejects when
 * nobody is signed in, the form is invalid, the user's role doesn't allow the access asked for, or the
 * session is no longer pending.
 */
export async function approveCliLoginAction(id: string, values: KeyFormValues): Promise<CliLoginActionResult> {
  const { principal } = await getAppSession();
  if (principal.kind !== "user") return SIGNED_OUT;
  if (!plausibleId(id)) return { ok: false, error: "This login link has expired. Run npm login again." };
  const form = keyFormSchema.safeParse(values);
  if (!form.success) return { ok: false, error: form.error.issues[0]?.message ?? "Check the form" };
  const input = issueKeyInput.safeParse(toCreateKeyInput(form.data));
  if (!input.success) return { ok: false, error: input.error.issues[0]?.message ?? "Check the form" };
  const { db, auth, secretKey } = getServerContext();
  try {
    await approveCliLogin({ db, auth, secretKey }, principal, id, input.data, { ip: requestIp(await headers()) });
    return { ok: true };
  } catch (error) {
    if (error instanceof TRPCError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Denies the npm login session `id` for the signed-in user; the waiting CLI is told the login was denied. */
export async function denyCliLoginAction(id: string): Promise<CliLoginActionResult> {
  const { principal } = await getAppSession();
  if (principal.kind !== "user") return SIGNED_OUT;
  if (plausibleId(id)) await denyCliLogin(getServerContext().db, id);
  return { ok: true };
}

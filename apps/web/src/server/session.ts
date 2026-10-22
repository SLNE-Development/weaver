import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { decideAccess, decideRoleAccess, loginPath } from "../lib/access";
import { getSettings, type Principal, type StoreSet, type Role, type ServerSettings } from "@weaver/core";
import type { Db } from "@weaver/db";
import type { Auth } from "./auth";
import { getServerContext } from "./context";
import { loadActiveRole } from "./principal";

/** The signed-in user as the app shell shows it. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
}

/** Who is looking at a page, and the server settings that shape what they may see. */
export interface AppSession {
  /** A user principal, or anonymous (also for banned users and invalid sessions). */
  principal: Extract<Principal, { kind: "user" | "anonymous" }>;
  user: SessionUser | null;
  settings: ServerSettings;
}

/**
 * Resolves the Better Auth session carried by `requestHeaders`. The role is read from the user
 * row as stored now, so a demotion applies on the next page load; a banned user counts as
 * anonymous.
 */
export async function resolveAppSession(
  requestHeaders: Headers,
  deps: { db: Db; auth: Auth; stores: StoreSet } = getServerContext(),
): Promise<AppSession> {
  const [session, settings] = await Promise.all([
    deps.auth.api.getSession({ headers: requestHeaders }),
    getSettings(deps.db, { primaryStore: deps.stores.primary.id, configuredStores: deps.stores.configured() }),
  ]);
  const role = session ? await loadActiveRole(deps.db, session.user.id) : null;
  if (!session || !role) return { principal: { kind: "anonymous" }, user: null, settings };
  const { id, name, email, image } = session.user;
  return {
    principal: { kind: "user", userId: id, role },
    user: { id, name, email, image: image ?? null, role },
    settings,
  };
}

/** The current request's {@link AppSession}, resolved once per request for layouts and pages. */
export const getAppSession = cache(async (): Promise<AppSession> => resolveAppSession(await headers()));

/**
 * Applies the app shell's access gate ({@link decideAccess}) to the page at `path` and redirects
 * when it refuses; returns the session otherwise. Pages call it at the top, because the layout's
 * gate doesn't run again on client-side navigation.
 */
export async function requirePageAccess(path: string): Promise<AppSession> {
  const session = await getAppSession();
  const decision = decideAccess({ path, role: session.user?.role ?? null, anonymousView: session.settings.anonymousView });
  if (decision.kind === "redirect") redirect(decision.to);
  return session;
}

/**
 * Requires a signed-in user with at least `required` for the page at `path`: anonymous visitors
 * are redirected to the login page (returning to `path`), lower roles to the dashboard. Returns the
 * session with its user.
 */
export async function requireRole(
  required: Role,
  path: string,
): Promise<AppSession & { user: SessionUser; principal: { kind: "user" } }> {
  const session = await getAppSession();
  const decision = decideRoleAccess({ path, role: session.user?.role ?? null, required });
  if (decision.kind === "redirect" || !session.user || session.principal.kind !== "user") {
    redirect(decision.kind === "redirect" ? decision.to : loginPath(path));
  }
  return session as AppSession & { user: SessionUser; principal: { kind: "user" } };
}

import { and, eq } from "drizzle-orm";
import { RegistryError, type FormatDeps, type Repo } from "@weaver/core";
import { dockerManifest } from "@weaver/db";
import type { Caller } from "./auth/authorize.js";
import { DockerError } from "./errors.js";
import { serveHostedBlob, type HostedReadCtx } from "./hosted/blobs.js";
import { serveManifest } from "./hosted/manifests.js";
import { serveReferrers } from "./hosted/referrers.js";
import { serveTags } from "./hosted/tags.js";
import type { HubAuth } from "./mirror/hub-auth.js";
import { mirrorBlob, mirrorManifest, mirrorReferrers, mirrorTags } from "./mirror/mirror.js";
import type { Target } from "./target.js";

/** A read a group serves from its members. */
export type GroupOp = "manifest" | "blob" | "tags" | "referrers";

/** What a group read works with: dependencies, the authorized caller, the group target and the upstream token cache. */
export interface GroupCtx {
  deps: FormatDeps;
  caller: Caller;
  target: Target;
  hub: HubAuth;
}

/** The `404` codes a hosted read throws for a missing item, which a group treats as "try the next member". */
const MISSING = new Set(["MANIFEST_UNKNOWN", "BLOB_UNKNOWN", "NAME_UNKNOWN"]);

/**
 * Whether a mirror member's error only says its upstream could not serve the request: the engine's
 * `upstream_unavailable`, or the mirror's `502 UNAVAILABLE` and `429 TOOMANYREQUESTS`.
 */
function isUpstreamFailure(error: unknown): boolean {
  if (error instanceof RegistryError) return error.code === "upstream_unavailable";
  return error instanceof DockerError && (error.code === "UNAVAILABLE" || error.code === "TOOMANYREQUESTS");
}

/** Whether repo/image holds at least one manifest. */
async function hasManifests(deps: FormatDeps, repo: Repo, image: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: dockerManifest.id })
    .from(dockerManifest)
    .where(and(eq(dockerManifest.repositoryId, repo.id), eq(dockerManifest.image, image)))
    .limit(1);
  return row !== undefined;
}

/** Runs a hosted read, answering null instead of throwing a not-found error. */
async function orNull(read: () => Promise<Response>): Promise<Response | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof DockerError && err.status === 404 && MISSING.has(err.code)) return null;
    throw err;
  }
}

/** One member's answer to `op`; null when it does not have the item (hosted tags and referrers: when the image has no manifests). */
async function fromMember(ctx: GroupCtx, member: Repo, op: GroupOp, req: Request, arg: string): Promise<Response | null> {
  const target: Target = { repo: member, image: ctx.target.image, name: ctx.target.name };
  if (member.kind === "mirror") {
    const mctx = { ...ctx, target };
    switch (op) {
      case "manifest":
        return mirrorManifest(mctx, req, arg);
      case "blob":
        return mirrorBlob(mctx, req, arg);
      case "tags":
        return mirrorTags(mctx, req);
      case "referrers":
        return mirrorReferrers(mctx, req, arg);
    }
  }
  if (member.kind !== "hosted") return null;
  const hctx: HostedReadCtx = { deps: ctx.deps, caller: ctx.caller, target };
  switch (op) {
    case "manifest":
      return orNull(() => serveManifest(hctx, req, arg));
    case "blob":
      return orNull(() => serveHostedBlob(hctx, req, arg));
    case "tags":
      return (await hasManifests(ctx.deps, member, target.image)) ? orNull(() => serveTags(hctx, req)) : null;
    case "referrers":
      return (await hasManifests(ctx.deps, member, target.image)) ? serveReferrers(hctx, req, arg) : null;
  }
}

/**
 * Tries members in order; the first non-null answer wins. Hosted members answer null when the item is missing.
 * Members are read with a member-scoped target (same image and client name) and without checking member
 * permissions: read of the group covers them. A mirror member whose upstream fails (unavailable, rate
 * limited) is skipped; when no later member has the item either, the first such failure is thrown instead
 * of answering null. Any other error, and every error of a hosted member, is thrown at once, so a later
 * member (such as a public mirror) never answers in place of an earlier one that could not be read.
 */
export async function fromGroup(ctx: GroupCtx, op: GroupOp, req: Request, arg: string): Promise<Response | null> {
  let failure: { error: unknown } | null = null;
  for (const member of await ctx.deps.repos.members(ctx.target.repo.id)) {
    try {
      const served = await fromMember(ctx, member, op, req, arg);
      if (served) return served;
    } catch (error) {
      if (member.kind !== "mirror" || !isUpstreamFailure(error)) throw error;
      console.warn(`weaver:docker group ${ctx.target.repo.name}: member ${member.name} failed`, error);
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
  return null;
}

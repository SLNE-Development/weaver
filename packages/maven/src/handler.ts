import {
  RegistryError,
  canAccess,
  canReadThroughGroup,
  type FormatFactory,
  type Principal,
  type Repo,
} from "@weaver/core";
import type { MavenContext } from "./context.js";
import { readGroup } from "./group.js";
import { readHosted, writeHosted } from "./hosted.js";
import { listDirectory } from "./listing.js";
import { readMirror } from "./mirror.js";
import { methodNotAllowed, textResponse, unauthorized } from "./http.js";
import { parseMavenPath } from "./path.js";

/** The 404 answer for everything that does not exist. */
function notFound(): Response {
  return textResponse(404, "Not Found");
}

/** Whether the principal may read the repository, directly or through a group. */
function mayRead(principal: Principal, repo: Repo): boolean {
  if (repo.visibility === "public") return true;
  if (repo.kind === "group") return canReadThroughGroup(principal, repo);
  return canAccess(principal, repo, "", "read");
}

/** The denial for a failed access check: a Basic challenge for anonymous callers, 403 otherwise. */
function denied(principal: Principal): Response {
  return principal.kind === "anonymous" ? unauthorized() : textResponse(403, "Forbidden");
}

/** Creates the Maven protocol handler mounted at `/maven/`. */
export const createMavenHandler: FormatFactory = (deps) => async (req, rest) => {
  try {
    const { repo: name, target } = parseMavenPath(rest);
    const repo = await deps.repos.get(name);
    if (!repo || repo.format !== "maven") return notFound();
    if (target === null) {
      return new Response(null, { status: 308, headers: { location: `${deps.publicUrl}/maven/${encodeURIComponent(repo.name)}/` } });
    }

    const method = req.method.toUpperCase();
    const writable = repo.kind === "hosted";
    if (method === "PUT" && !writable) return methodNotAllowed("GET, HEAD");
    if (method !== "GET" && method !== "HEAD" && method !== "PUT") {
      return methodNotAllowed(writable ? "GET, HEAD, PUT" : "GET, HEAD");
    }

    const principal = await deps.principal(req);
    if (method === "PUT") {
      if (!canAccess(principal, repo, "", "write")) return denied(principal);
      return await writeHosted({ deps, principal, method }, repo, target, req);
    }

    if (!mayRead(principal, repo)) return denied(principal);
    const ctx: MavenContext = { deps, principal, method };
    if (target.type === "directory") return await listDirectory(ctx, repo, target.path);
    if (repo.kind === "hosted") return (await readHosted(ctx, repo, target)) ?? notFound();
    if (repo.kind === "mirror") return (await readMirror(ctx, repo, target)) ?? notFound();
    return (await readGroup(ctx, repo, target)) ?? notFound();
  } catch (err) {
    if (err instanceof RegistryError) return err.status === 401 ? unauthorized() : textResponse(err.status, err.message);
    console.error("weaver: maven request failed", err);
    return textResponse(500, "Internal Server Error");
  }
};

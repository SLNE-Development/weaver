import { canAccess, canReadThroughGroup, RegistryError, type FormatFactory, type Principal, type Repo } from "@weaver/core";
import { npmError, npmJson, toNpmResponse } from "./http.js";
import {
  confirmTarballRemoved,
  listDistTags,
  putPackument,
  removeDistTag,
  servePackument,
  serveTarball,
  serveVersion,
  setDistTag,
  unpublishPackage,
  type HostedContext,
} from "./hosted.js";
import { serveGroup } from "./group.js";
import { serveMirror } from "./mirror.js";
import { handleWhoami, legacyLogin, pollWebLogin, startWebLogin } from "./login.js";
import { handleSearch } from "./search.js";
import { handleSecurity } from "./security.js";
import { parseNpmPath, type NpmRoute } from "./route.js";
import { createNpmStore } from "./store.js";

/** Route kinds that address one package; writes to them are refused on mirrors and groups. */
const PACKAGE_KINDS = new Set<NpmRoute["kind"]>(["packument", "version", "tarball", "distTags"]);

/** The 405 answer listing the methods a route accepts. */
function methodNotAllowed(allow: string): Response {
  return npmError(405, "method not allowed", { allow });
}

/** Throws 401 for anonymous and 403 for authenticated principals lacking `access` on the repository. */
function authorize(principal: Principal, repo: Repo, access: "read" | "write"): void {
  const ok =
    access === "write"
      ? canAccess(principal, repo, "", "write")
      : repo.kind === "group"
        ? canReadThroughGroup(principal, repo)
        : canAccess(principal, repo, "", "read");
  if (ok) return;
  if (principal.kind === "anonymous") throw new RegistryError("unauthorized", "authentication required");
  throw new RegistryError("forbidden", `no ${access} access to repository ${repo.name}`);
}

/** Serves one package route of a hosted repository. */
async function serveHosted(ctx: HostedContext, route: NpmRoute, req: Request, method: string): Promise<Response> {
  const read = method === "GET" || method === "HEAD";
  switch (route.kind) {
    case "packument":
      if (read && route.rev === null) return servePackument(ctx, route.name, req);
      if (method === "PUT") return putPackument(ctx, route.name, route.rev, req);
      if (method === "DELETE" && route.rev !== null) return unpublishPackage(ctx, route.name, route.rev);
      return methodNotAllowed(route.rev === null ? "GET, HEAD, PUT" : "PUT, DELETE");
    case "version":
      return read ? serveVersion(ctx, route.name, route.spec, req) : methodNotAllowed("GET, HEAD");
    case "tarball":
      if (read && route.rev === null) return serveTarball(ctx, route.name, route.file, method === "HEAD" ? "HEAD" : "GET");
      if (method === "DELETE" && route.rev !== null) return confirmTarballRemoved(ctx, route.name, route.file);
      return methodNotAllowed(route.rev === null ? "GET, HEAD" : "DELETE");
    case "distTags":
      if (route.tag === null) return read ? listDistTags(ctx, route.name) : methodNotAllowed("GET, HEAD");
      if (method === "PUT") return setDistTag(ctx, route.name, route.tag, req);
      if (method === "DELETE") return removeDistTag(ctx, route.name, route.tag);
      return methodNotAllowed("PUT, DELETE");
    default:
      return npmError(404, "not found");
  }
}

/**
 * Creates the handler of the `/npm` mount: parses the path, loads the repository (format `npm`, else 404), refuses
 * package writes to mirrors and groups with 405 before authentication, authorizes, then dispatches by repository and
 * route kind (hosted, mirror or group). Search (`GET`) and audit (`POST`) need read access on every kind. `whoami`,
 * web login (`/-/v1/login`, its `done` poll) and the legacy couchdb login work on every kind without repository access.
 */
export const createNpmHandler: FormatFactory = (deps) => {
  const store = createNpmStore(deps.db);
  return async (req, rest) => {
    try {
      const parsed = parseNpmPath(rest);
      if (!parsed) return npmError(404, "not found");
      const repo = await deps.repos.get(parsed.repo);
      if (!repo || repo.format !== "npm") return npmError(404, "not found");
      const { route } = parsed;
      const method = req.method.toUpperCase();
      const read = method === "GET" || method === "HEAD";

      if (route.kind === "ping") return read ? npmJson({}) : methodNotAllowed("GET, HEAD");
      if (route.kind === "unsupported") return npmError(404, "not supported by Weaver");
      if (route.kind === "whoami") return read ? await handleWhoami(deps, req) : methodNotAllowed("GET, HEAD");
      if (route.kind === "login") return method === "POST" ? await startWebLogin(deps, repo, req) : methodNotAllowed("POST");
      if (route.kind === "loginDone") return read ? await pollWebLogin(deps, repo, route.secret) : methodNotAllowed("GET, HEAD");
      if (route.kind === "couchUser") return method === "PUT" ? await legacyLogin(deps, req, route.user) : methodNotAllowed("PUT");
      if (route.kind === "search") {
        if (!read) return methodNotAllowed("GET, HEAD");
        authorize(await deps.principal(req), repo, "read");
        const res = await handleSearch(deps, repo, new URL(req.url));
        return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
      }
      if (route.kind === "security") {
        if (method !== "POST") return methodNotAllowed("POST");
        authorize(await deps.principal(req), repo, "read");
        return await handleSecurity(deps, repo, req, route.path);
      }
      if (!PACKAGE_KINDS.has(route.kind)) return npmError(404, "not found");
      if (!read && repo.kind !== "hosted") return methodNotAllowed("GET, HEAD");

      const principal = await deps.principal(req);
      authorize(principal, repo, read ? "read" : "write");
      if (repo.kind === "mirror") return await serveMirror(deps, repo, principal, route, req);
      if (repo.kind === "group") return await serveGroup(deps, repo, principal, route, req);
      return await serveHosted({ deps, store, repo, principal }, route, req, method);
    } catch (error) {
      return toNpmResponse(error);
    }
  };
};

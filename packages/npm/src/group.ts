import { RegistryError, type FormatDeps, type Principal, type Repo } from "@weaver/core";
import { npmError, npmJson } from "./http.js";
import { serveTarball } from "./hosted.js";
import { mirrorPackument, mirrorTarball, streamMirrorTarball } from "./mirror.js";
import type { PackageName } from "./names.js";
import {
  ABBREVIATED_TYPE,
  abbreviate,
  mergePackuments,
  rewriteTarballs,
  wantsAbbreviated,
  type AbbreviatedPackument,
  type Packument,
  type VersionManifest,
} from "./packument.js";
import type { NpmRoute } from "./route.js";
import { createNpmStore } from "./store.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-property assignment that is safe for untrusted keys such as `__proto__`. */
function setOwn<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Whether an error is an unreachable or refusing upstream. */
function isUnavailable(err: unknown): err is RegistryError {
  return err instanceof RegistryError && err.code === "upstream_unavailable";
}

/** The members of a group that serve content (hosted and mirror repositories), in order. */
async function servingMembers(deps: FormatDeps, group: Repo): Promise<Repo[]> {
  return (await deps.repos.members(group.id)).filter((m) => m.kind === "hosted" || m.kind === "mirror");
}

/** One member's packument (full or abbreviated), or null when the member does not have the package. */
async function memberPackument(
  deps: FormatDeps,
  group: Repo,
  member: Repo,
  name: PackageName,
  abbreviated: boolean,
): Promise<Packument | AbbreviatedPackument | null> {
  if (member.kind === "mirror") return (await mirrorPackument(deps, member, name, abbreviated, group.name))?.document ?? null;
  const found = await createNpmStore(deps.db).get(member.id, name.full);
  if (!found) return null;
  return abbreviated ? abbreviate(found.document) : found.document;
}

/**
 * Calls `read` for each serving member in order until `done` says to stop. A member failing with
 * `upstream_unavailable` is skipped and logged. Returns whether any member failed.
 */
async function eachMember<T>(
  deps: FormatDeps,
  group: Repo,
  read: (member: Repo) => Promise<T>,
  done: (member: Repo, value: T) => boolean,
): Promise<{ failed: boolean }> {
  let failed = false;
  for (const member of await servingMembers(deps, group)) {
    let value: T;
    try {
      value = await read(member);
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      failed = true;
      console.warn(`weaver: npm group ${group.name} skipped member ${member.name}: ${err.message}`);
      continue;
    }
    if (done(member, value)) break;
  }
  return { failed };
}

/** An abbreviated packument in the shape {@link mergePackuments} merges, its `modified` kept as `time.modified`. */
function asMergeable(doc: AbbreviatedPackument): Packument {
  return {
    _id: doc.name,
    name: doc.name,
    "dist-tags": isRecord(doc["dist-tags"]) ? doc["dist-tags"] : {},
    versions: (isRecord(doc.versions) ? doc.versions : {}) as Record<string, VersionManifest>,
    time: typeof doc.modified === "string" ? { modified: doc.modified } : {},
  };
}

/**
 * The packument of `name` merged across the group's members in order, with every tarball URL under
 * `${publicUrl}/npm/${group.name}`; null when no member has the package.
 *
 * The earlier member wins for each version and dist-tag (full: also time entries; `time.modified` and the
 * abbreviated `modified` are the latest of all). Members are read without checking the caller's member permissions.
 * A member whose upstream is unavailable is skipped (logged) while another member supplies the package; when none
 * does and any member failed, this throws `upstream_unavailable` (502), since the package may exist there.
 */
export async function groupPackument(
  deps: FormatDeps,
  group: Repo,
  name: PackageName,
  abbreviated: boolean,
): Promise<Packument | AbbreviatedPackument | null> {
  const docs: Array<Packument | AbbreviatedPackument> = [];
  const { failed } = await eachMember(
    deps,
    group,
    (member) => memberPackument(deps, group, member, name, abbreviated),
    (_member, doc) => {
      if (doc !== null) docs.push(doc);
      return false;
    },
  );
  if (docs.length === 0) {
    if (failed) throw new RegistryError("upstream_unavailable", `no member of ${group.name} could answer for ${name.full}`);
    return null;
  }
  const base = `${deps.publicUrl}/npm/${group.name}`;
  if (!abbreviated) return rewriteTarballs(mergePackuments(docs as Packument[]), base);
  const merged = mergePackuments((docs as AbbreviatedPackument[]).map(asMergeable));
  const out: AbbreviatedPackument = { name: merged.name, modified: merged.time["modified"] ?? "", "dist-tags": merged["dist-tags"], versions: merged.versions };
  return rewriteTarballs(out, base);
}

/**
 * Serves the tarball from the first member (in order) that has it, moving on when a member has none: hosted members
 * are checked with one asset lookup, mirror members by asking for the tarball itself, so no member's packument is
 * fetched. With the earlier member winning the merge, this is the member whose manifest won for the version in the
 * usual case. null when no member has it. Members whose upstream is unavailable are skipped (logged); when no member
 * has the tarball and any failed, this throws `upstream_unavailable`. A GET records the download on the serving
 * member as `principal`.
 */
export async function groupTarball(
  deps: FormatDeps,
  group: Repo,
  name: PackageName,
  file: string,
  method: "GET" | "HEAD",
  principal: Principal,
): Promise<Response | null> {
  let served: Response | null = null;
  const { failed } = await eachMember(
    deps,
    group,
    async (member): Promise<Response | null> => {
      if (member.kind === "mirror") {
        const res = await mirrorTarball(deps, member, name, file, method);
        return res && streamMirrorTarball(deps, member, principal, name, file, method, res);
      }
      const row = await deps.assets.find(member.id, `${name.full}/-/${file}`);
      if (!row || row.origin !== "hosted") return null;
      return serveTarball({ deps, store: createNpmStore(deps.db), repo: member, principal }, name, file, method);
    },
    (_member, res) => {
      served = res;
      return res !== null;
    },
  );
  const res = served as Response | null;
  if (res === null && failed) throw new RegistryError("upstream_unavailable", `no member of ${group.name} could answer for ${name.full}`);
  return res;
}

/** Answers HEAD with the headers of `res` and no body. */
function forMethod(method: string, res: Response): Response {
  return method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}

/**
 * Serves the read routes of a group repository: merged packuments (abbreviated by Accept), single versions and
 * dist-tags from the merged packument, and tarballs from the member whose manifest won. Other routes answer 404;
 * writes are refused before this is reached.
 */
export async function serveGroup(deps: FormatDeps, group: Repo, principal: Principal, route: NpmRoute, req: Request): Promise<Response> {
  const method = req.method.toUpperCase() === "HEAD" ? "HEAD" : "GET";
  switch (route.kind) {
    case "packument": {
      if (route.rev !== null) return npmError(404, "not found");
      const abbreviated = wantsAbbreviated(req.headers.get("accept"));
      const doc = await groupPackument(deps, group, route.name, abbreviated);
      if (!doc) return npmError(404, "not found");
      const headers = { "content-type": abbreviated ? ABBREVIATED_TYPE : "application/json", vary: "Accept" };
      return forMethod(method, npmJson(doc, { headers }));
    }
    case "version": {
      const doc = await groupPackument(deps, group, route.name, false);
      if (!doc) return npmError(404, "not found");
      const tags = doc["dist-tags"];
      const version = Object.hasOwn(tags, route.spec) ? tags[route.spec]! : route.spec;
      if (!Object.hasOwn(doc.versions, version)) return npmError(404, `version not found: ${route.spec}`);
      return forMethod(method, npmJson(doc.versions[version]));
    }
    case "distTags": {
      if (route.tag !== null) return npmError(404, "not found");
      const doc = await groupPackument(deps, group, route.name, true);
      if (!doc) return npmError(404, "not found");
      const tags: Record<string, string> = {};
      for (const [tag, value] of Object.entries(doc["dist-tags"])) if (typeof value === "string") setOwn(tags, tag, value);
      return forMethod(method, npmJson(tags));
    }
    case "tarball": {
      if (route.rev !== null) return npmError(404, "not found");
      const res = await groupTarball(deps, group, route.name, route.file, method, principal);
      return res ?? npmError(404, "not found");
    }
    default:
      return npmError(404, "not found");
  }
}

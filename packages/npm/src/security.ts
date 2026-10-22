import { deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";
import type { FormatDeps, Repo } from "@weaver/core";
import { npmError, npmJson } from "./http.js";
import { readBody } from "./hosted.js";
import { allowedBy, hasRules } from "./search.js";
import { createNpmStore } from "./store.js";
import { forwardUpstream } from "./upstream.js";

/** The `audits` / `audits/quick` answer for a dependency tree without advisories. */
export const NO_ADVISORIES_QUICK: unknown = {
  actions: [],
  advisories: {},
  muted: [],
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    dependencies: 0,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 0,
  },
};

/** The security endpoints below `-/npm/v1/security/` that Weaver answers. */
const SECURITY_PATHS = new Set(["advisories/bulk", "audits", "audits/quick"]);

/** Largest audit request body read into memory to filter and forward it (and retry it on the next upstream): 16 MiB. */
export const MAX_AUDIT_BYTES = 16 * 1024 * 1024;

/** Request body codings a bulk audit can be decoded from and re-encoded to. */
type Coding = "identity" | "gzip" | "deflate";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The answer of a repository that knows no advisories: `{}` for the bulk endpoint, {@link NO_ADVISORIES_QUICK} for audits. */
async function noAdvisories(req: Request, path: string): Promise<Response> {
  if (!req.bodyUsed) await req.body?.cancel().catch(() => undefined);
  return npmJson(path === "advisories/bulk" ? {} : NO_ADVISORIES_QUICK);
}

/** The single content coding of a request body, or null when it is one this module cannot decode. */
function codingOf(req: Request): Coding | null {
  const value = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (value === "" || value === "identity") return "identity";
  if (value === "gzip" || value === "x-gzip") return "gzip";
  if (value === "deflate") return "deflate";
  return null;
}

/**
 * Forwards an audit request to a mirror's upstreams with `body` and the client's allow-listed headers (its
 * `content-type`/`content-encoding` included, never its credentials), passing the answer through; the hosted answer
 * when the mirror is offline or every upstream answered 404. An unreachable upstream fails with
 * `upstream_unavailable` (502), so a broken upstream never reads as "no advisories".
 */
async function forwardAudit(deps: FormatDeps, mirror: Repo, req: Request, path: string, body: Uint8Array): Promise<Response> {
  const res = await forwardUpstream(deps, mirror, `-/npm/v1/security/${path}`, { method: "POST", headers: req.headers, body });
  if (res === null) return noAdvisories(req, path);
  const out = new Headers(res.headers);
  if (!out.has("content-type")) out.set("content-type", "application/json");
  return new Response(res.body, { status: res.status, headers: out });
}

/**
 * Forwards a bulk advisory request (`{ "<name>": ["<version>", …] }`) without the names the upstream must not learn:
 * names the mirror's rules exclude and names in `privateNames`. The body is decoded (identity, gzip or deflate; any
 * other coding is a 415), filtered and re-encoded the way it arrived; when nothing is dropped the original bytes are
 * sent, and when nothing is left the answer is `{}` without asking upstream. An unreadable body is a 400.
 */
async function forwardBulk(
  deps: FormatDeps,
  mirror: Repo,
  req: Request,
  privateNames: (names: string[]) => Promise<Set<string>>,
): Promise<Response> {
  const raw = await readBody(req, MAX_AUDIT_BYTES);
  const coding = codingOf(req);
  if (coding === null) return npmError(415, "unsupported content-encoding");
  let parsed: unknown;
  try {
    // Decoding stops at the cap, so a small compressed body cannot expand into gigabytes.
    const limit = { maxOutputLength: MAX_AUDIT_BYTES };
    const text = coding === "gzip" ? gunzipSync(raw, limit) : coding === "deflate" ? inflateSync(raw, limit) : raw;
    parsed = JSON.parse(text.toString("utf8"));
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: unknown } | null)?.code === "ERR_BUFFER_TOO_LARGE") {
      return npmError(413, "request body too large");
    }
    return npmError(400, "invalid audit body");
  }
  if (!isRecord(parsed)) return npmError(400, "invalid audit body");
  const names = Object.keys(parsed);
  const hidden = await privateNames(names);
  const kept: Record<string, unknown> = {};
  let dropped = false;
  for (const name of names) {
    if (hidden.has(name) || !allowedBy(mirror, name)) {
      dropped = true;
      continue;
    }
    Object.defineProperty(kept, name, { value: parsed[name], enumerable: true, writable: true, configurable: true });
  }
  if (!dropped) return forwardAudit(deps, mirror, req, "advisories/bulk", raw);
  if (Object.keys(kept).length === 0) return npmJson({});
  const json = Buffer.from(JSON.stringify(kept));
  const body = coding === "gzip" ? gzipSync(json) : coding === "deflate" ? deflateSync(json) : json;
  return forwardAudit(deps, mirror, req, "advisories/bulk", body);
}

/** The 502 for a full or quick audit whose dependency tree could carry names the upstream must not learn. */
async function unfilterable(req: Request, path: string, where: string): Promise<Response> {
  await req.body?.cancel().catch(() => undefined);
  return npmError(502, `${path} is not forwarded from ${where}; npm audit uses advisories/bulk`);
}

/**
 * `POST -/npm/v1/security/{advisories/bulk,audits,audits/quick}`: hosted repositories know no advisories (`{}` for
 * bulk, {@link NO_ADVISORIES_QUICK} for audits). Mirrors forward the request upstream; a bulk request to a mirror
 * with rules leaves out the names its rules exclude. Groups forward to their first mirror member, or give the hosted
 * answer without one: a bulk request leaves out names any hosted member serves and names the mirror's rules
 * exclude. The full and quick audits, whose dependency trees are not filtered, answer 502 without forwarding through
 * a mirror with allow or deny rules and through a group with hosted members or such a mirror member, so npm reports
 * the audit as failed instead of sending private names upstream or reporting it clean.
 * Other paths answer 404, other methods 405. The caller has checked read access.
 */
export async function handleSecurity(deps: FormatDeps, repo: Repo, req: Request, path: string): Promise<Response> {
  if (!SECURITY_PATHS.has(path)) return npmError(404, "not found");
  if (req.method.toUpperCase() !== "POST") return npmError(405, "method not allowed", { allow: "POST" });
  const bulk = path === "advisories/bulk";
  if (repo.kind === "mirror") {
    if (hasRules(repo)) {
      if (bulk) return forwardBulk(deps, repo, req, () => Promise.resolve(new Set()));
      return unfilterable(req, path, `mirror ${repo.name}, which has allow or deny rules`);
    }
    return forwardAudit(deps, repo, req, path, await readBody(req, MAX_AUDIT_BYTES));
  }
  if (repo.kind === "group") {
    const members = await deps.repos.members(repo.id);
    const mirror = members.find((m) => m.kind === "mirror");
    const hostedIds = members.filter((m) => m.kind === "hosted").map((m) => m.id);
    if (mirror) {
      if (bulk) return forwardBulk(deps, mirror, req, (names) => createNpmStore(deps.db).existing(hostedIds, names));
      if (hostedIds.length > 0) return unfilterable(req, path, `group ${repo.name}, which has hosted members`);
      if (hasRules(mirror)) return unfilterable(req, path, `group ${repo.name}, whose mirror member has allow or deny rules`);
      return forwardAudit(deps, mirror, req, path, await readBody(req, MAX_AUDIT_BYTES));
    }
  }
  return noAdvisories(req, path);
}

import { discardBody, matchesRules, RegistryError, type FormatDeps, type MirrorConfig, type Repo } from "@weaver/core";
import { npmJson } from "./http.js";
import type { Packument } from "./packument.js";
import { createNpmStore } from "./store.js";
import { forwardUpstream } from "./upstream.js";

/** The answer of `GET -/v1/search`, as registry.npmjs.org sends it. */
export interface SearchResult {
  objects: Array<{
    package: {
      name: string;
      version: string;
      description?: string;
      keywords?: string[];
      date: string;
      links: Record<string, string>;
      /** Always present (npm search fails without it); `username` is the packument maintainer's `name`. */
      maintainers: Array<{ username: string; email?: string }>;
    };
    score: { final: number; detail: { quality: number; popularity: number; maintenance: number } };
    searchScore: number;
  }>;
  total: number;
  time: string;
}

/** One entry of {@link SearchResult.objects}. */
type SearchObject = SearchResult["objects"][number];

/** Results per page when the client names no `size`. */
const DEFAULT_SIZE = 20;
/** Largest page a client can ask for. */
const MAX_SIZE = 250;
/** Largest upstream search answer read into memory to merge it into a group's results: 16 MiB. */
const MAX_UPSTREAM_SEARCH_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer query parameter, or `fallback` when it is missing or not one. */
function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || !/^\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}

/** The `text`, `size` (default 20, 1..250) and `from` (default 0) of a search request. */
function searchParams(url: URL): { text: string; size: number; from: number } {
  const size = Math.min(MAX_SIZE, Math.max(1, intParam(url, "size", DEFAULT_SIZE)));
  return { text: url.searchParams.get("text") ?? "", size, from: intParam(url, "from", 0) };
}

/** The links a packument names: its homepage, repository and bug tracker URLs, where present. */
function linksOf(doc: Packument): Record<string, string> {
  const links: Record<string, string> = {};
  const latest = doc.versions?.[doc["dist-tags"]?.["latest"] ?? ""];
  const source = { ...latest, ...doc } as Record<string, unknown>;
  if (typeof source["homepage"] === "string") links["homepage"] = source["homepage"];
  const repository = source["repository"];
  const repoUrl = typeof repository === "string" ? repository : isRecord(repository) ? repository["url"] : undefined;
  if (typeof repoUrl === "string") links["repository"] = repoUrl;
  const bugs = source["bugs"];
  const bugsUrl = typeof bugs === "string" ? bugs : isRecord(bugs) ? bugs["url"] : undefined;
  if (typeof bugsUrl === "string") links["bugs"] = bugsUrl;
  return links;
}

/** The packument's `maintainers` (`{ name, email }`) in search form (`{ username, email }`); empty when it has none. */
function maintainersOf(doc: Packument): SearchObject["package"]["maintainers"] {
  const listed = (doc as Record<string, unknown>)["maintainers"];
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((m) => {
    if (!isRecord(m) || typeof m["name"] !== "string") return [];
    return [typeof m["email"] === "string" ? { username: m["name"], email: m["email"] } : { username: m["name"] }];
  });
}

/** A hosted packument as a search entry: its `latest` version (else the last listed), score and search score `1`. */
function hostedObject(doc: Packument): SearchObject {
  const versions = Object.keys(doc.versions ?? {});
  const tagged = doc["dist-tags"]?.["latest"];
  const version = typeof tagged === "string" ? tagged : (versions[versions.length - 1] ?? "");
  const time = doc.time ?? {};
  const date = time[version] ?? time["modified"] ?? new Date(0).toISOString();
  const pkg: SearchObject["package"] = { name: doc.name, version, date, links: linksOf(doc), maintainers: maintainersOf(doc) };
  if (typeof doc.description === "string") pkg.description = doc.description;
  const keywords = doc["keywords"];
  if (Array.isArray(keywords)) pkg.keywords = keywords.filter((k): k is string => typeof k === "string");
  return { package: pkg, score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } }, searchScore: 1 };
}

/** Searches hosted repositories; an empty list of repositories finds nothing. */
async function searchHosted(deps: FormatDeps, repoIds: string[], url: URL): Promise<{ total: number; objects: SearchObject[] }> {
  const { text, size, from } = searchParams(url);
  const found = await createNpmStore(deps.db).search(repoIds, text, size, from);
  return { total: found.total, objects: found.documents.map(hostedObject) };
}

/** Whether a mirror's allow/deny rules exclude anything (an empty allow list and no deny allows every name). */
export function hasRules(mirror: Repo): boolean {
  const { rules } = mirror.config as MirrorConfig;
  return rules.allow.length > 0 || rules.deny.length > 0;
}

/** Whether a package name passes the mirror's allow/deny rules. */
export function allowedBy(mirror: Repo, name: string): boolean {
  return matchesRules((mirror.config as MirrorConfig).rules, name);
}

/** Forwards a search to a mirror's upstreams with the query `search`; null when offline or every upstream 404s. */
function forwardSearch(deps: FormatDeps, mirror: Repo, search: string): Promise<Response | null> {
  return forwardUpstream(deps, mirror, "-/v1/search", { method: "GET", headers: new Headers({ accept: "application/json" }), search });
}

/** Reads an upstream search answer as JSON (16 MiB cap); null when it is too large, unreadable or not a search answer. */
async function readUpstreamResult(res: Response): Promise<{ total: number; objects: SearchObject[] } | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_UPSTREAM_SEARCH_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed["objects"])) return null;
    const objects = parsed["objects"].filter(
      (o): o is SearchObject => isRecord(o) && isRecord(o["package"]) && typeof o["package"]["name"] === "string",
    );
    const total = typeof parsed["total"] === "number" && Number.isFinite(parsed["total"]) ? parsed["total"] : objects.length;
    return { total, objects };
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
}

/** A search answer stamped with the current time. */
function result(total: number, objects: SearchObject[]): Response {
  const body: SearchResult = { objects, total, time: new Date().toUTCString() };
  return npmJson(body);
}

/** The objects of an upstream answer that pass the mirror's rules, and `total` lowered by the ones dropped. */
function applyRules(mirror: Repo, found: { total: number; objects: SearchObject[] }): { total: number; objects: SearchObject[] } {
  const objects = found.objects.filter((o) => allowedBy(mirror, o.package.name));
  return { total: Math.max(0, found.total - (found.objects.length - objects.length)), objects };
}

/**
 * The upstream search of a group's mirror member with the page `size`/`from`, its answer filtered by the mirror's
 * rules; null when the mirror is offline, answers 404 or anything but a readable 200, or is unavailable (logged).
 */
async function upstreamPage(
  deps: FormatDeps,
  group: Repo,
  mirror: Repo,
  url: URL,
  size: number,
  from: number,
): Promise<{ total: number; objects: SearchObject[] } | null> {
  const query = new URLSearchParams(url.search);
  query.delete("size");
  query.delete("from");
  query.set("size", String(size));
  query.set("from", String(from));
  try {
    const res = await forwardSearch(deps, mirror, query.toString());
    if (res === null) return null;
    if (res.status !== 200) {
      await discardBody(res);
      return null;
    }
    const found = await readUpstreamResult(res);
    return found && applyRules(mirror, found);
  } catch (err) {
    if (!(err instanceof RegistryError && err.code === "upstream_unavailable")) throw err;
    console.warn(`weaver: npm group ${group.name} search skipped member ${mirror.name}: ${err.message}`);
    return null;
  }
}

/**
 * Searches a group as one list: the hosted members' packages first (each name once, from the earliest member), then
 * the first mirror member's upstream results. A page `[from, from + size)` takes the hosted slice, then asks the
 * upstream for the rest of the page at `from - hostedTotal` (at least 0); the upstream is asked for one result even
 * when hosted results fill the page, so `total` covers it. Upstream results that a hosted member has by name, or that
 * the mirror's rules exclude, are dropped and not counted. The page is cut to `size`. An unavailable upstream is
 * skipped (logged).
 */
async function searchGroup(deps: FormatDeps, group: Repo, url: URL): Promise<Response> {
  const { size, from } = searchParams(url);
  const members = await deps.repos.members(group.id);
  const hostedIds = members.filter((m) => m.kind === "hosted").map((m) => m.id);
  const hosted = await searchHosted(deps, hostedIds, url);
  const mirror = members.find((m) => m.kind === "mirror");
  const upstream = mirror
    ? await upstreamPage(deps, group, mirror, url, Math.max(1, size - hosted.objects.length), Math.max(0, from - hosted.total))
    : null;
  let total = hosted.total;
  const objects = [...hosted.objects];
  if (upstream) {
    const names = upstream.objects.map((o) => o.package.name);
    const taken = await createNpmStore(deps.db).existing(hostedIds, names);
    for (const o of hosted.objects) taken.add(o.package.name);
    const kept: SearchObject[] = [];
    for (const o of upstream.objects) {
      if (taken.has(o.package.name)) continue;
      taken.add(o.package.name);
      kept.push(o);
    }
    total += Math.max(0, upstream.total - (upstream.objects.length - kept.length));
    objects.push(...kept);
  }
  return result(total, objects.slice(0, size));
}

/**
 * `GET -/v1/search?text=&size=&from=`: hosted repositories search their packages by name, description and keyword
 * (exact name first; size default 20, max 250); mirrors forward the query string upstream and pass the answer
 * through (an offline mirror or an upstream 404 finds nothing); a mirror with allow/deny rules reads the answer
 * (16 MiB cap, else 502) and drops the names its rules exclude; groups combine both, see {@link searchGroup}.
 */
export async function handleSearch(deps: FormatDeps, repo: Repo, url: URL): Promise<Response> {
  if (repo.kind === "hosted") {
    const found = await searchHosted(deps, [repo.id], url);
    return result(found.total, found.objects);
  }
  if (repo.kind === "group") return searchGroup(deps, repo, url);
  const res = await forwardSearch(deps, repo, url.search);
  if (res === null) return result(0, []);
  if (hasRules(repo) && res.status === 200) {
    const found = await readUpstreamResult(res);
    if (!found) throw new RegistryError("upstream_unavailable", `the upstream of ${repo.name} sent an unusable search answer`);
    const filtered = applyRules(repo, found);
    return result(filtered.total, filtered.objects);
  }
  const headers = new Headers(res.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(res.body, { status: res.status, headers });
}

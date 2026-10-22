import { and, eq, exists, inArray, like, notInArray, or, sql, type SQL } from "drizzle-orm";
import { asset, component, groupMember, type Db } from "@weaver/db";
import { RegistryError } from "../errors.js";
import { canAccess, canReadThroughGroup, type Principal } from "../permissions.js";
import type { Format, Kind } from "../repos/config.js";
import type { Repo, RepoService } from "../repos/service.js";
import { componentLabel } from "./labels.js";
import { parseSearchQuery, type ParsedSearch } from "./query.js";

/** Most hits one search page returns. */
export const SEARCH_LIMIT_MAX = 50;
/** Most components one search matches before grouping them into packages. */
export const SEARCH_MATCH_MAX = 5000;
/** Largest offset a search accepts. */
export const SEARCH_OFFSET_MAX = 1000;

/** One package found by {@link searchComponents}: a repository's namespace and name with all its versions. */
export interface SearchHit {
  /** The repository holding the package (a hosted or mirror repository, never a group). */
  repository: string;
  /** The group name when the caller reads the package only through this group. */
  via: string | null;
  format: Format;
  /** The kind of `repository`. */
  kind: Kind;
  namespace: string;
  name: string;
  /** The name the format knows the package by, see {@link componentLabel}. */
  label: string;
  /** The version of the most recently created component. */
  latestVersion: string;
  versionCount: number;
  /** Lifetime downloads over all versions. */
  downloads: number;
  updatedAt: Date;
}

/** What {@link searchComponents} searches for. */
export interface SearchOptions {
  text: string;
  format?: Format;
  /** 1..{@link SEARCH_LIMIT_MAX}. */
  limit: number;
  /** 0..{@link SEARCH_OFFSET_MAX}. */
  offset: number;
}

/** The components a search may return, by repository id. */
export interface SearchScope {
  /** Repositories whose every namespace the caller may read. */
  full: string[];
  /** Proto repositories the caller may read only below these group prefixes (API key entries). */
  prefixed: { repositoryId: string; prefixes: string[] }[];
  /** Mirror repositories among them: their components only count with at least one asset. */
  mirrors: string[];
  /** Repository names by id, for ordering ties. */
  names: Record<string, string>;
}

/** A readable repository with the groups it is a member of, ordered by name. */
interface Candidate {
  repo: Repo;
  groups: Repo[];
}

/** Escapes `%`, `_` and `\` for a `LIKE` pattern with the default `\` escape. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/** A term as `search_text` holds it: npm scopes are stored without their `@`. */
function storedTerm(term: string): string {
  return term.startsWith("@") ? term.slice(1) : term;
}

/** `text` normalised with every word's leading `@` dropped, to compare against `search_text`. */
function storedText(normalized: string): string {
  return normalized
    .split(" ")
    .map((word) => storedTerm(word))
    .join(" ");
}

/** The permission scope a check on `namespace` of a `format` repository uses: the group for proto, `""` otherwise. */
function scopeOf(format: Format, namespace: string): string {
  return format === "proto" ? namespace : "";
}

/**
 * Who a package is read as: null when the caller reads `repo` itself, the first group (by name)
 * the caller reads it through, or undefined when it is not readable at all.
 */
function attribution(p: Principal, candidate: Candidate, namespace: string): string | null | undefined {
  const scope = scopeOf(candidate.repo.format, namespace);
  if (canAccess(p, candidate.repo, scope, "read")) return null;
  // Read on a group grants what it serves; a proto key's group prefix on the group still narrows it.
  const readsThrough = (g: Repo) => (candidate.repo.format === "proto" ? canAccess(p, g, scope, "read") : canReadThroughGroup(p, g));
  return candidate.groups.find(readsThrough)?.name;
}

/**
 * The hosted and mirror repositories (of `format`, when given) the principal may read something
 * of, directly or through a group, with the scope a search over them may return. Repositories
 * the caller cannot read never appear, so nothing about them reaches the query or the result.
 */
export async function searchScope(
  deps: { db: Db; repos: RepoService },
  p: Principal,
  format?: Format,
): Promise<{ scope: SearchScope; candidates: Map<string, Candidate> }> {
  const all = await deps.repos.list();
  const byId = new Map(all.map((r) => [r.id, r]));
  const links = await deps.db.select({ groupId: groupMember.groupId, memberId: groupMember.memberId }).from(groupMember);
  const groupsOf = new Map<string, Repo[]>();
  for (const link of links) {
    const group = byId.get(link.groupId);
    if (!group) continue;
    groupsOf.set(link.memberId, [...(groupsOf.get(link.memberId) ?? []), group]);
  }

  const scope: SearchScope = { full: [], prefixed: [], mirrors: [], names: {} };
  const candidates = new Map<string, Candidate>();
  for (const repo of all) {
    if (repo.kind === "group" || (format !== undefined && repo.format !== format)) continue;
    const groups = (groupsOf.get(repo.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const sources = [repo, ...groups];
    if (canAccess(p, repo, "", "read") || groups.some((g) => canReadThroughGroup(p, g))) {
      scope.full.push(repo.id);
    } else if (repo.format === "proto" && p.kind === "apikey") {
      // A key entry with a group prefix reads only below that prefix, on the repository or a group of it.
      const ids = new Set(sources.map((r) => r.id));
      const prefixes = p.permissions.filter((e) => ids.has(e.repositoryId) && e.groupPrefix !== null).map((e) => e.groupPrefix!);
      if (prefixes.length === 0) continue;
      scope.prefixed.push({ repositoryId: repo.id, prefixes: [...new Set(prefixes)] });
    } else {
      continue;
    }
    candidates.set(repo.id, { repo, groups });
    scope.names[repo.id] = repo.name;
    if (repo.kind === "mirror") scope.mirrors.push(repo.id);
  }
  return { scope, candidates };
}

/** Matches components whose `search_text` contains every one of `terms`. */
function containsAll(terms: string[]): SQL | undefined {
  const patterns = terms.map(storedTerm).filter((t) => t !== "");
  if (patterns.length === 0) return undefined;
  return and(...patterns.map((t) => like(component.searchText, `%${escapeLike(t)}%`)));
}

/**
 * Restricts components to the repositories and group prefixes of `scope`. The repository id is
 * compared as text, so the planner drives the search from the trigram index instead of reading
 * whole repositories through the coordinate index and filtering them.
 */
function inScope(scope: SearchScope): SQL | undefined {
  const repositoryId = sql`${component.repositoryId}::text`;
  return or(
    scope.full.length > 0 ? inArray(repositoryId, scope.full) : undefined,
    ...scope.prefixed.map((entry) =>
      and(
        eq(repositoryId, entry.repositoryId),
        or(...entry.prefixes.flatMap((px) => [eq(component.namespace, px), like(component.namespace, `${escapeLike(px)}.%`)])),
      ),
    ),
  );
}

/** One package row of {@link buildSearchQuery}, as the driver returns it. */
type PackageRow = {
  repositoryId: string;
  namespace: string;
  name: string;
  latestVersion: string;
  versionCount: number | string;
  downloads: number | string;
  updatedAt: Date | string;
};

/**
 * The search query over `component`: the matching components of `scope` (a materialised CTE, so
 * the match is planned on its own and runs from the trigram index), then one row per package
 * (repository, namespace, name), ranked by exact `search_text` match, then prefix match, then
 * trigram similarity, then lifetime downloads, then label and repository name; `limit + 1` rows
 * from `offset`. Mirror components only count with at least one asset. At most `matchMax`
 * (default {@link SEARCH_MATCH_MAX}) components are matched, so a broad query never scans or
 * groups more than that.
 */
export function buildSearchQuery(
  db: Db,
  parsed: ParsedSearch,
  scope: SearchScope,
  page: { limit: number; offset: number; matchMax?: number },
): SQL {
  const texts = [parsed.normalized, ...(parsed.altTerms ? [parsed.altTerms.join(" ")] : [])].map(storedText);
  const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
  const prefixes = texts.map((t) => `${escapeLike(t)}%`);
  const similarity = sql.join(texts.map((t) => sql`similarity(search_text, ${t})`), sql`, `);
  // Ties between repositories go by repository name.
  const byName = [...scope.full, ...scope.prefixed.map((e) => e.repositoryId)].sort((a, b) =>
    (scope.names[a] ?? "").localeCompare(scope.names[b] ?? ""),
  );
  const matches = or(containsAll(parsed.terms), parsed.altTerms ? containsAll(parsed.altTerms) : undefined);
  const stored =
    scope.mirrors.length === 0
      ? undefined
      : or(
          notInArray(component.repositoryId, scope.mirrors),
          exists(db.select({ one: sql`1` }).from(asset).where(eq(asset.componentId, component.id))),
        );
  return sql`
    with matched as materialized (
      select ${component.repositoryId} as repository_id, ${component.namespace} as namespace, ${component.name} as name,
        ${component.version} as version, ${component.searchText} as search_text, ${component.downloadCount} as download_count,
        ${component.createdAt} as created_at, ${component.updatedAt} as updated_at
      from ${component}
      where ${and(inScope(scope), matches, stored)}
      limit ${page.matchMax ?? SEARCH_MATCH_MAX}
    )
    select repository_id::text as "repositoryId", namespace, name,
      (array_agg(version order by created_at desc, version desc))[1] as "latestVersion",
      count(*) as "versionCount", coalesce(sum(download_count), 0) as downloads, max(updated_at) as "updatedAt"
    from matched
    group by search_text, repository_id, namespace, name
    order by search_text in (${list(texts)}) desc,
      search_text like any (array[${list(prefixes)}]) desc,
      greatest(${similarity}) desc,
      coalesce(sum(download_count), 0) desc,
      search_text asc,
      array_position(array[${list(byName)}]::text[], repository_id::text) asc
    limit ${page.limit + 1} offset ${page.offset}`;
}

/**
 * Searches the packages the principal may read (directly, or through a group it may read) for
 * `opts.text`, ranked as {@link buildSearchQuery} describes. A proto key limited to group prefixes
 * sees only those groups. `hasMore` tells whether another page follows. Throws `invalid_request`
 * for a query under two characters or options out of range.
 */
export async function searchComponents(
  deps: { db: Db; repos: RepoService },
  p: Principal,
  opts: SearchOptions,
): Promise<{ hits: SearchHit[]; hasMore: boolean }> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > SEARCH_LIMIT_MAX) {
    throw new RegistryError("invalid_request", `limit must be between 1 and ${SEARCH_LIMIT_MAX}`);
  }
  if (!Number.isInteger(opts.offset) || opts.offset < 0 || opts.offset > SEARCH_OFFSET_MAX) {
    throw new RegistryError("invalid_request", `offset must be between 0 and ${SEARCH_OFFSET_MAX}`);
  }
  const parsed = parseSearchQuery(opts.text);
  const { scope, candidates } = await searchScope(deps, p, opts.format);
  if (scope.full.length === 0 && scope.prefixed.length === 0) return { hits: [], hasMore: false };

  const rows = (await deps.db.execute<PackageRow>(buildSearchQuery(deps.db, parsed, scope, opts))).rows;
  const hits: SearchHit[] = [];
  for (const row of rows.slice(0, opts.limit)) {
    const candidate = candidates.get(row.repositoryId);
    // The query is already scoped; this re-check keeps an unreadable row out whatever happens.
    const via = candidate && attribution(p, candidate, row.namespace);
    if (!candidate || via === undefined) continue;
    const { repo } = candidate;
    hits.push({
      repository: repo.name,
      via,
      format: repo.format,
      kind: repo.kind,
      namespace: row.namespace,
      name: row.name,
      label: componentLabel(repo.format, row.namespace, row.name),
      latestVersion: row.latestVersion,
      versionCount: Number(row.versionCount),
      downloads: Number(row.downloads),
      updatedAt: new Date(row.updatedAt),
    });
  }
  return { hits, hasMore: rows.length > opts.limit };
}

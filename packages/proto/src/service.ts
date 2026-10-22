import {
  canAccess,
  compareVersions,
  formatCoordinate,
  RegistryError,
  resolveGraph,
  type BuildSelector,
  type Coordinate,
  type FormatDeps,
  type Lookup,
  type Principal,
  type Registry,
  type Repo,
  type RepoService,
  type Resolution,
  type ResolvedNode,
  type ResolveOptions,
  type VersionInfo,
  type VersionSummary,
} from "@weaver/core";
import { streamOf } from "./bytes.js";
import type { ProtoMirrorSource } from "./mirror-source.js";

/** What a proto archive read returns, for any repository kind. */
export interface ProtoArchive {
  /** The archive bytes; null for HEAD. The caller must read or cancel it. */
  body: ReadableStream<Uint8Array> | null;
  size: number | null;
  sha256: string | null;
  filename: string;
  /** How a mirror served the archive relative to its cache; null for a hosted repository. */
  cache: "hit" | "miss" | "bypass" | "stale" | null;
  /** The served version's `component` row (hosted GETs), so the download counts on it. */
  componentId?: string | null;
}

/**
 * Proto reads of any repository kind as a principal sees them. Hosted repositories are read from
 * the registry, mirrors from their upstreams, and groups from their members in order. Everything
 * served through a mirror or group names the repository the client addressed. `hops` is the
 * incoming `x-weaver-hops` count, passed on to mirror upstreams.
 */
export interface ProtoService {
  /** Resolves roots across `repositories` (client order); every node's `repository` is the listed entry. */
  resolve(p: Principal, repositories: string[], roots: Coordinate[], options: ResolveOptions, hops: number): Promise<Resolution>;
  /** The versions of an artifact, newest first; for a group the union across its members. */
  listVersions(p: Principal, repository: string, group: string, name: string, hops: number): Promise<VersionSummary[]>;
  /** Metadata of the newest build of `c`, or of build `select.buildNumber`. */
  getManifest(p: Principal, repository: string, c: Coordinate, select: BuildSelector, hops: number): Promise<VersionInfo>;
  /** The archive of the newest build of `c` (or `select.buildNumber`); a GET records one download. */
  archive(p: Principal, repository: string, c: Coordinate, select: BuildSelector, method: "GET" | "HEAD", hops: number): Promise<ProtoArchive>;
}

/** What {@link createProtoService} works with. */
export interface ProtoServiceDeps {
  registry: Registry;
  repos: RepoService;
  mirrorSource: ProtoMirrorSource;
  usage: FormatDeps["usage"];
}

function notFound(what: string): RegistryError {
  return new RegistryError("not_found", `${what} was not found`);
}

function missingBuild(c: Coordinate, buildNumber: number | undefined): RegistryError {
  return notFound(buildNumber === undefined ? `Version ${formatCoordinate(c)}` : `Build ${buildNumber} of ${formatCoordinate(c)}`);
}

function isUnavailable(error: unknown): error is RegistryError {
  return error instanceof RegistryError && error.code === "upstream_unavailable";
}

/**
 * Tries `read` on each repository in order and answers the first non-null result. A repository
 * throwing `upstream_unavailable` is skipped; the first such error is thrown when no later
 * repository has a result, so a failing mirror is not reported as a misleading `not_found`.
 */
async function firstOf<T>(repositories: Repo[], read: (repo: Repo) => Promise<T | null>): Promise<T | null> {
  let failure: RegistryError | null = null;
  for (const repo of repositories) {
    try {
      const result = await read(repo);
      if (result !== null) return result;
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return null;
}

/** Caches an async loader per key for the lifetime of the returned function. */
function memoize<T>(load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key) => {
    let value = cache.get(key);
    if (!value) cache.set(key, (value = load(key)));
    return value;
  };
}

/**
 * Creates the kind-aware proto service. Entries a principal cannot use (unknown, not
 * `format = "proto"`, or unreadable for the coordinate's group) are skipped by `resolve` and
 * `not_found` everywhere else. Read access on a group (`canAccess(p, group, c.group, "read")`, so a
 * key's group prefix on the group entry still narrows it) grants everything served through it;
 * members are then read without their own checks.
 */
export function createProtoService(deps: ProtoServiceDeps): ProtoService {
  const { registry, repos, mirrorSource, usage } = deps;

  /** The addressed proto repository when the principal may read it for `scope`; otherwise `not_found`. */
  async function addressed(p: Principal, name: string, scope: string): Promise<Repo> {
    const repo = await repos.get(name);
    if (!repo || repo.format !== "proto" || !canAccess(p, repo, scope, "read")) throw notFound(`Repository ${name}`);
    return repo;
  }

  /** The repositories holding `repo`'s content: a group's hosted and mirror members in order, else `repo` itself. */
  async function sourcesOf(repo: Repo, members: (groupId: string) => Promise<Repo[]> = (id) => repos.members(id)): Promise<Repo[]> {
    if (repo.kind !== "group") return [repo];
    return (await members(repo.id)).filter((m) => m.format === "proto" && m.kind !== "group");
  }

  function nodeIn(repo: Repo, c: Coordinate, hops: number): Promise<ResolvedNode | null> {
    return repo.kind === "mirror" ? mirrorSource.node(repo, c, hops) : registry.hosted.node(repo, c);
  }

  async function versionsIn(repo: Repo, group: string, name: string, hops: number): Promise<VersionSummary[] | null> {
    const versions = repo.kind === "mirror" ? await mirrorSource.versions(repo, group, name, hops) : await registry.hosted.versions(repo, group, name);
    return versions && versions.length > 0 ? versions : null;
  }

  function manifestIn(repo: Repo, c: Coordinate, select: BuildSelector, hops: number): Promise<VersionInfo | null> {
    return repo.kind === "mirror" ? mirrorSource.manifest(repo, c, hops, select.buildNumber) : registry.hosted.manifest(repo, c, select);
  }

  async function archiveIn(repo: Repo, c: Coordinate, select: BuildSelector, method: "GET" | "HEAD", hops: number): Promise<ProtoArchive | null> {
    const filename = `${c.name}-${c.version}.tar.gz`;
    if (repo.kind === "mirror") {
      const got = await mirrorSource.archive(repo, c, select.buildNumber, hops, method);
      return got && { body: got.body, size: got.size, sha256: got.sha256, filename, cache: got.cache };
    }
    if (method === "HEAD") {
      // Read the manifest instead of the archive, so a HEAD neither loads the blob nor counts a download.
      const info = await registry.hosted.manifest(repo, c, select);
      return info && { body: null, size: info.sizeBytes, sha256: info.sha256, filename, cache: null };
    }
    const got = await registry.hosted.archive(repo, c, select);
    return got && { body: streamOf(got.data), size: got.data.length, sha256: got.sha256, filename, cache: null, componentId: got.componentId };
  }

  return {
    async resolve(p, repositories, roots, options, hops) {
      // Repositories and group members are loaded once per call, however many coordinates the graph has.
      const getRepo = memoize((name) => repos.get(name));
      const getMembers = memoize((groupId) => repos.members(groupId));
      const names = [...new Set(repositories)];
      // A coordinate only a failing mirror could have had counts as missing, so a version the graph
      // supersedes later does not fail the resolution; if it stays missing, the failure is reported.
      const unavailable = new Map<string, RegistryError>();
      const lookup: Lookup = async (c) => {
        const entries = (await Promise.all(names.map(getRepo))).filter(
          (r): r is Repo => r !== null && r.format === "proto" && canAccess(p, r, c.group, "read"),
        );
        try {
          return await firstOf(entries, async (entry) => {
            const node = await firstOf(await sourcesOf(entry, getMembers), (repo) => nodeIn(repo, c, hops));
            return node && { ...node, repository: entry.name };
          });
        } catch (error) {
          if (!isUnavailable(error)) throw error;
          unavailable.set(formatCoordinate(c), error);
          return null;
        }
      };
      try {
        return await resolveGraph(roots, lookup, options);
      } catch (error) {
        if (error instanceof RegistryError && error.code === "not_found") {
          const path = (error.details as { path?: unknown } | undefined)?.path;
          const missing = Array.isArray(path) ? (path.at(-1) as unknown) : undefined;
          const failure = typeof missing === "string" ? unavailable.get(missing) : undefined;
          if (failure) throw failure;
        }
        throw error;
      }
    },

    async listVersions(p, repository, group, name, hops) {
      const repo = await addressed(p, repository, group);
      // Every member contributes, the first one listing a version wins it; a failing member only
      // matters when the union stays empty.
      const byVersion = new Map<string, VersionSummary>();
      let failure: RegistryError | null = null;
      for (const member of await sourcesOf(repo)) {
        let versions: VersionSummary[] | null;
        try {
          versions = await versionsIn(member, group, name, hops);
        } catch (error) {
          if (!isUnavailable(error)) throw error;
          failure ??= error;
          continue;
        }
        for (const v of versions ?? []) if (!byVersion.has(v.version)) byVersion.set(v.version, v);
      }
      if (byVersion.size === 0) throw failure ?? notFound(`Artifact ${group}:${name}`);
      return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
    },

    async getManifest(p, repository, c, select, hops) {
      const repo = await addressed(p, repository, c.group);
      const info = await firstOf(await sourcesOf(repo), (member) => manifestIn(member, c, select, hops));
      if (!info) throw missingBuild(c, select.buildNumber);
      return { ...info, repository: repo.name };
    },

    async archive(p, repository, c, select, method, hops) {
      const repo = await addressed(p, repository, c.group);
      const got = await firstOf(await sourcesOf(repo), (member) => archiveIn(member, c, select, method, hops));
      if (!got) throw missingBuild(c, select.buildNumber);
      if (method === "GET") {
        await usage({
          repositoryId: repo.id,
          path: `${c.group}/${c.name}/${c.version}`,
          action: "download",
          ...(got.cache === null ? {} : { cache: got.cache }),
          ...(got.componentId ? { componentId: got.componentId } : {}),
          bytes: got.size ?? 0,
          principal: p,
        });
      }
      return got;
    },
  };
}

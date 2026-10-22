import type { z } from "zod";
import {
  isSnapshot,
  LIMITS,
  RegistryError,
  sha256,
  type Coordinate,
  type MirrorEngine,
  type MirrorResponse,
  type Repo,
  type ResolvedNode,
  type VersionInfo,
  type VersionSummary,
} from "@weaver/core";
import { readAllLimited, streamOf, TooLargeError } from "./bytes.js";
import { HOPS_HEADER, manifestBodySchema, protoPath, SHA_HEADER, SHA256_PATTERN, versionInfoFromJson, versionsBodySchema } from "./wire.js";

/** An archive a proto mirror served: the body to stream (null for HEAD) with its size and checksum when known. */
export interface MirrorArchive {
  status: 200;
  body: ReadableStream<Uint8Array> | null;
  size: number | null;
  sha256: string | null;
  cache: MirrorResponse["cache"];
}

/**
 * Reads of one proto mirror repository from its upstreams, other Weaver instances' `/api/v1`
 * proto APIs. `hops` is the incoming `x-weaver-hops` count (0 for a client request); every upstream
 * request carries `hops + 1`. Each method answers null when the rules reject the artifact or no
 * upstream has it, and throws `RegistryError("upstream_unavailable")` when an upstream fails or
 * answers something other than the Weaver proto API.
 */
export interface ProtoMirrorSource {
  /** The newest build of `c`, read from its manifest, as a resolved node naming `repo`. */
  node(repo: Repo, c: Coordinate, hops: number): Promise<ResolvedNode | null>;
  /** The versions of an artifact as the upstream lists them. */
  versions(repo: Repo, group: string, name: string, hops: number): Promise<VersionSummary[] | null>;
  /** Metadata of the newest build of `c` or of build `buildNumber`, naming `repo` as its repository. */
  manifest(repo: Repo, c: Coordinate, hops: number, buildNumber?: number): Promise<VersionInfo | null>;
  /** The archive of the newest build of `c` or of build `buildNumber`; the caller must read or cancel its body. */
  archive(repo: Repo, c: Coordinate, buildNumber: number | undefined, hops: number, method: "GET" | "HEAD"): Promise<MirrorArchive | null>;
}

/** The byte count of a `content-length` header, or null when absent or malformed. */
function parseLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : null;
}

/** Releases a mirror response body that is not going to be read. */
async function cancelBody(response: MirrorResponse): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is gone already; nothing to release.
  }
}

/** The error for an upstream that answered, but not as a Weaver proto API does. */
function notWeaver(repo: Repo): RegistryError {
  return new RegistryError("upstream_unavailable", `Upstream of ${repo.name} did not answer as a Weaver proto API`);
}

/** The error for an upstream whose body broke off before its end. */
function brokeOff(repo: Repo, path: string, error: unknown): RegistryError {
  return new RegistryError("upstream_unavailable", `Upstream of ${repo.name} broke off ${path}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Creates the proto mirror source over the core mirror engine. */
export function createMirrorSource(deps: { mirror: MirrorEngine }): ProtoMirrorSource {
  const headers = (hops: number) => ({ accept: "application/json", [HOPS_HEADER]: String(hops + 1) });
  const subject = (group: string, name: string) => `${group}:${name}`;

  /**
   * Answers null for a missing resource, throws for any other non-success status, and otherwise
   * hands back the response; the body is cancelled whenever it is not handed back.
   */
  async function accepted(repo: Repo, response: MirrorResponse | null, ok: (status: number) => boolean): Promise<MirrorResponse | null> {
    if (response === null) return null;
    if (ok(response.status)) return response;
    await cancelBody(response);
    if (response.status === 404) return null;
    throw notWeaver(repo);
  }

  /** Drops whatever the mirror cached at `path`, then answers the error for a non-Weaver upstream. */
  async function rejectBody(repo: Repo, path: string): Promise<RegistryError> {
    await deps.mirror.evict(repo, path);
    return notWeaver(repo);
  }

  /**
   * Fetches `path` as metadata and validates its JSON body against `schema`. A body that is not
   * JSON or fails the schema is evicted from the cache, so it is never served again.
   */
  async function fetchJson<T>(repo: Repo, path: string, group: string, name: string, hops: number, schema: z.ZodType<T>): Promise<T | null> {
    const response = await accepted(
      repo,
      await deps.mirror.fetch({ repo, path, subject: subject(group, name), class: "metadata", headers: headers(hops) }),
      (status) => status >= 200 && status < 300,
    );
    if (response === null) return null;
    let text: string;
    try {
      text = await new Response(response.body).text();
    } catch (error) {
      await deps.mirror.evict(repo, path);
      throw brokeOff(repo, path, error);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw await rejectBody(repo, path);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw await rejectBody(repo, path);
    return parsed.data;
  }

  async function manifest(repo: Repo, c: Coordinate, hops: number, buildNumber?: number): Promise<VersionInfo | null> {
    const path = protoPath("manifest", c, buildNumber);
    const body = await fetchJson(repo, path, c.group, c.name, hops, manifestBodySchema);
    if (body === null) return null;
    const info = versionInfoFromJson(body);
    const same = info.coordinate.group === c.group && info.coordinate.name === c.name && info.coordinate.version === c.version;
    if (!same || (buildNumber !== undefined && info.buildNumber !== buildNumber)) throw await rejectBody(repo, path);
    return { ...info, repository: repo.name };
  }

  return {
    async node(repo, c, hops) {
      const info = await manifest(repo, c, hops);
      if (info === null) return null;
      return {
        coordinate: info.coordinate,
        repository: repo.name,
        buildNumber: info.buildNumber,
        sha256: info.sha256,
        dependencies: info.dependencies,
      };
    },

    async versions(repo, group, name, hops) {
      const body = await fetchJson(repo, protoPath("versions", { group, name }), group, name, hops, versionsBodySchema);
      if (body === null) return null;
      return body.versions.map((v) => ({ ...v, updatedAt: new Date(v.updatedAt) }));
    },

    manifest,

    async archive(repo, c, buildNumber, hops, method) {
      const path = protoPath("archive", c, buildNumber);
      const response = await accepted(
        repo,
        await deps.mirror.fetch({
          repo,
          path,
          subject: subject(c.group, c.name),
          class: isSnapshot(c.version) ? "metadata" : "immutable",
          method,
          headers: headers(hops),
          component: { namespace: c.group, name: c.name, version: c.version },
        }),
        (status) => status === 200,
      );
      if (response === null) return null;
      if (response.asset) {
        // Served from the cache, which only keeps archives that matched their upstream checksum.
        return { status: 200, body: response.body, size: response.asset.size, sha256: response.asset.sha256, cache: response.cache };
      }
      // A Weaver upstream always names the archive's checksum; anything else is not its proto API.
      // A HEAD caches nothing, so it has nothing to evict (a cached archive it bypassed stays).
      const expected = response.headers.get(SHA_HEADER);
      if (expected === null || !SHA256_PATTERN.test(expected)) {
        await cancelBody(response);
        throw method === "HEAD" ? notWeaver(repo) : await rejectBody(repo, path);
      }
      if (response.cache === "miss") {
        // The bytes are being cached as they stream; proto archives are small enough to check whole
        // before serving, so a body that does not match its checksum is evicted instead of kept.
        let data: Buffer;
        try {
          data = await readAllLimited(response.body, LIMITS.archiveBytes);
        } catch (error) {
          if (error instanceof TooLargeError) throw await rejectBody(repo, path);
          await deps.mirror.evict(repo, path);
          throw brokeOff(repo, path, error);
        }
        if (sha256(data) !== expected) throw await rejectBody(repo, path);
        return { status: 200, body: streamOf(data), size: data.length, sha256: expected, cache: "miss" };
      }
      return {
        status: 200,
        body: response.body,
        size: parseLength(response.headers.get("content-length")),
        sha256: expected,
        cache: response.cache,
      };
    },
  };
}

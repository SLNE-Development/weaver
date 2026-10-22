import { z } from "zod";
import { RegistryError } from "../errors.js";
import { STORE_IDS, type StoreId } from "../storage/index.js";

/** The package format a repository serves. */
export type Format = "maven" | "npm" | "docker" | "proto";
/** How a repository gets its content: published to it, proxied from upstreams, or merged from members. */
export type Kind = "hosted" | "mirror" | "group";

/** Every format, in display order. */
export const FORMATS: readonly Format[] = ["maven", "npm", "docker", "proto"];
/** Every kind, in display order. */
export const KINDS: readonly Kind[] = ["hosted", "mirror", "group"];

/** How a mirror caches upstream content. */
export interface CacheConfig {
  enabled: boolean;
  /** The store cached objects go to; null means `settings.defaultCacheStore`. */
  store: StoreId | null;
  /** How long cached metadata is served before it is revalidated upstream. */
  metadataTtlSeconds: number;
  /** Cached objects not accessed for this many days are evicted; null means unlimited. */
  maxAgeDays: number | null;
  /** Least recently used cached objects are evicted beyond this size; null means unlimited. */
  maxSizeBytes: number | null;
}

/** Which subjects a mirror proxies: empty `allow` allows everything, and `deny` wins. */
export interface PathRules {
  allow: string[];
  deny: string[];
}

/** Settings of a mirror repository of any format. */
export interface MirrorConfig {
  cache: CacheConfig;
  /** Serve only cached content and never contact the upstreams. */
  offline: boolean;
  rules: PathRules;
  /** Docker only: the upstream is Docker Hub, so single-segment image names get the `library/` prefix. */
  dockerHub?: boolean;
}

/** Settings of a hosted Maven repository. */
export interface MavenHostedConfig {
  versionPolicy: "release" | "snapshot" | "mixed";
  redeploy: boolean;
}

/** Settings of a hosted npm repository; npm never overwrites a published version. */
export interface NpmHostedConfig {
  redeploy: false;
}

/** Settings of a hosted Docker repository. */
export interface DockerHostedConfig {
  /** Whether a pushed tag may not be moved to another manifest. */
  tagImmutable: boolean;
}

/** Settings of a hosted proto repository. */
export interface ProtoHostedConfig {
  allowRedeploy: boolean;
  allowReleases: boolean;
  allowSnapshots: boolean;
  /**
   * Order in which repositories other than the publish target are searched for dependencies at
   * publish time. Lower wins; ties are broken by repository name.
   */
  resolutionPriority: number;
}

/** The format- and kind-specific settings of a repository, stored in `repository.config`. */
export type RepositoryConfig =
  | MavenHostedConfig
  | NpmHostedConfig
  | DockerHostedConfig
  | ProtoHostedConfig
  | MirrorConfig
  | Record<string, never>;

/** The hosted config type of each format. */
export interface HostedConfigByFormat {
  maven: MavenHostedConfig;
  npm: NpmHostedConfig;
  docker: DockerHostedConfig;
  proto: ProtoHostedConfig;
}

/** The config type of a repository of format `F` and kind `K`. */
export type ConfigOf<F extends Format, K extends Kind> = K extends "hosted"
  ? HostedConfigByFormat[F]
  : K extends "mirror"
    ? MirrorConfig
    : Record<string, never>;

/** Upper bound of `resolutionPriority`. */
export const RESOLUTION_PRIORITY_MAX = 100_000;

const pattern = z.string().trim().min(1).max(500);

const cacheSchema = z.strictObject({
  enabled: z.boolean().default(false),
  store: z.enum(STORE_IDS).nullable().default(null),
  metadataTtlSeconds: z.number().int().min(0).default(1800),
  maxAgeDays: z.number().int().positive().nullable().default(null),
  maxSizeBytes: z.number().int().positive().nullable().default(null),
});

const mirrorFields = {
  cache: cacheSchema.prefault({}),
  offline: z.boolean().default(false),
  rules: z
    .strictObject({ allow: z.array(pattern).default([]), deny: z.array(pattern).default([]) })
    .prefault({}),
};

const mirrorSchema = z.strictObject(mirrorFields);
const dockerMirrorSchema = z.strictObject({ ...mirrorFields, dockerHub: z.boolean().default(false) });
const groupSchema = z.strictObject({});

const hostedSchemas: Record<Format, z.ZodType> = {
  maven: z.strictObject({
    versionPolicy: z.enum(["release", "snapshot", "mixed"]).default("mixed"),
    redeploy: z.boolean().default(false),
  }),
  npm: z.strictObject({ redeploy: z.literal(false).default(false) }),
  docker: z.strictObject({ tagImmutable: z.boolean().default(false) }),
  proto: z.strictObject({
    allowRedeploy: z.boolean().default(false),
    allowReleases: z.boolean().default(true),
    allowSnapshots: z.boolean().default(true),
    resolutionPriority: z.number().int().min(0).max(RESOLUTION_PRIORITY_MAX).default(100),
  }),
};

function schemaFor(format: Format, kind: Kind): z.ZodType {
  switch (kind) {
    case "hosted":
      return hostedSchemas[format];
    case "mirror":
      return format === "docker" ? dockerMirrorSchema : mirrorSchema;
    case "group":
      return groupSchema;
  }
}

/**
 * Validates `raw` as the config of a `format` `kind` repository and fills missing keys with their
 * defaults; `undefined` and `null` count as `{}`. Throws `invalid_request` (with the zod issues as
 * details) on unknown keys or invalid values.
 */
export function parseRepositoryConfig<F extends Format, K extends Kind>(format: F, kind: K, raw: unknown): ConfigOf<F, K>;
export function parseRepositoryConfig(format: Format, kind: Kind, raw: unknown): RepositoryConfig;
export function parseRepositoryConfig(format: Format, kind: Kind, raw: unknown): RepositoryConfig {
  const result = schemaFor(format, kind).safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
    throw new RegistryError("invalid_request", `Invalid ${format} ${kind} repository config: ${summary}`, { issues });
  }
  return result.data as RepositoryConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a stored config without failing: valid values are kept, unknown keys are dropped and
 * invalid values fall back to their defaults (one level deep into `cache` and `rules`).
 * Returns the config and whether anything had to be repaired.
 */
export function salvageRepositoryConfig(format: Format, kind: Kind, raw: unknown): { config: RepositoryConfig; repaired: boolean } {
  const schema = schemaFor(format, kind);
  const strict = schema.safeParse(raw ?? {});
  if (strict.success) return { config: strict.data as RepositoryConfig, repaired: false };

  const valid = (candidate: Record<string, unknown>) => schema.safeParse(candidate).success;
  const source = isPlainObject(raw) ? raw : {};
  const out: Record<string, unknown> = { ...(defaultRepositoryConfig(format, kind) as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (!(key in source)) continue;
    const value = source[key];
    const fallback = out[key];
    if (isPlainObject(fallback) && isPlainObject(value)) {
      const nested: Record<string, unknown> = { ...fallback };
      for (const sub of Object.keys(nested)) {
        if (sub in value && valid({ ...out, [key]: { ...nested, [sub]: value[sub] } })) nested[sub] = value[sub];
      }
      out[key] = nested;
    } else if (valid({ ...out, [key]: value })) {
      out[key] = value;
    }
  }
  return { config: schema.parse(out) as RepositoryConfig, repaired: true };
}

/**
 * Lenient read of a stored `repository.config` (see {@link salvageRepositoryConfig}); logs a warning
 * naming the repository when the stored value had to be repaired. Writes use the strict
 * {@link parseRepositoryConfig}.
 */
export function readRepositoryConfig<F extends Format, K extends Kind>(repo: {
  name: string;
  format: F;
  kind: K;
  config: unknown;
}): ConfigOf<F, K>;
export function readRepositoryConfig(repo: { name: string; format: Format; kind: Kind; config: unknown }): RepositoryConfig;
export function readRepositoryConfig(repo: { name: string; format: Format; kind: Kind; config: unknown }): RepositoryConfig {
  const { config, repaired } = salvageRepositoryConfig(repo.format, repo.kind, repo.config);
  if (repaired) {
    console.warn(`weaver: repository ${repo.name} has an invalid stored config; unknown keys and invalid values were replaced by defaults`);
  }
  return config;
}

/** The default config of a `format` `kind` repository. */
export function defaultRepositoryConfig<F extends Format, K extends Kind>(format: F, kind: K): ConfigOf<F, K>;
export function defaultRepositoryConfig(format: Format, kind: Kind): RepositoryConfig;
export function defaultRepositoryConfig(format: Format, kind: Kind): RepositoryConfig {
  return parseRepositoryConfig(format, kind, {});
}

import { z } from "zod";
import type {
  DockerHostedConfig,
  Format,
  Kind,
  MavenHostedConfig,
  MirrorConfig,
  ProtoHostedConfig,
  StoreId,
  UpstreamAuthType,
  UpstreamView,
} from "@weaver/core";
import { isValidRepositoryName } from "./names";

/** Upper bound the server accepts for `resolutionPriority`. */
export const RESOLUTION_PRIORITY_MAX = 100_000;

/** Every format in display order, with its label. Mirrors `FORMATS` of `@weaver/core`, which can't be bundled. */
export const FORMAT_OPTIONS: readonly { value: Format; label: string }[] = [
  { value: "maven", label: "Maven" },
  { value: "npm", label: "npm" },
  { value: "docker", label: "Docker" },
  { value: "proto", label: "Proto" },
];

/** Every kind in display order, with its label and a one-line explanation. */
export const KIND_OPTIONS: readonly { value: Kind; label: string; description: string }[] = [
  { value: "hosted", label: "Hosted", description: "You publish to it." },
  { value: "mirror", label: "Mirror", description: "Proxies upstream registries." },
  { value: "group", label: "Group", description: "Serves several repositories as one, read-only." },
];

/** The label of a format, e.g. `Maven`. */
export function formatLabel(format: Format): string {
  return FORMAT_OPTIONS.find((o) => o.value === format)?.label ?? format;
}

/** The label of a kind, e.g. `Mirror`. */
export function kindLabel(kind: Kind): string {
  return KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}

/** A typical upstream of a mirror of each format, used as the URL placeholder. */
export const UPSTREAM_EXAMPLES: Record<Format, string> = {
  maven: "https://repo.maven.apache.org/maven2/",
  npm: "https://registry.npmjs.org/",
  docker: "https://registry-1.docker.io",
  proto: "https://weaver.example.com",
};

/** What the subjects of a mirror's allow and deny rules are, per format. */
export const RULE_SUBJECTS: Record<Format, string> = {
  maven: "groupId prefixes, e.g. org.apache.*",
  npm: "scopes and package names, e.g. @acme/* or left-pad",
  docker: "image namespaces, e.g. library/*",
  proto: "group prefixes, e.g. com.acme.*",
};

const repositoryNameField = z
  .string()
  .trim()
  .min(1, "Give the repository a name")
  .refine(isValidRepositoryName, "Use lowercase letters, digits and dashes, starting with a letter or digit");

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The create dialog: name, format and kind, plus one upstream URL for a mirror or the members of a group. */
export const createRepositorySchema = z
  .object({
    name: repositoryNameField,
    format: z.enum(["maven", "npm", "docker", "proto"]),
    kind: z.enum(["hosted", "mirror", "group"]),
    upstreamUrl: z.string().trim(),
    members: z.array(z.string()),
  })
  .superRefine((values, ctx) => {
    if (values.kind === "mirror" && !isHttpUrl(values.upstreamUrl)) {
      ctx.addIssue({ code: "custom", path: ["upstreamUrl"], message: "Enter an http or https URL" });
    }
    if (values.format === "docker" && values.name === "library") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "library is reserved for Docker Hub images" });
    }
  });

/** The values of the create dialog, as {@link createRepositorySchema} validates them. */
export type CreateRepositoryValues = z.infer<typeof createRepositorySchema>;

/** The empty create dialog. */
export const NEW_REPOSITORY_DEFAULTS: CreateRepositoryValues = { name: "", format: "maven", kind: "hosted", upstreamUrl: "", members: [] };

/** The `repositories.create` input of the create dialog; only the fields of the chosen kind are sent. */
export function toCreateRepositoryInput(values: CreateRepositoryValues) {
  const base = { name: values.name.trim(), format: values.format, kind: values.kind };
  if (values.kind === "mirror") return { ...base, upstreams: [{ url: values.upstreamUrl.trim(), authType: "none" as const }] };
  if (values.kind === "group") return { ...base, members: values.members };
  return base;
}

/** Description and visibility, which every repository has. */
export const generalSettingsSchema = z.object({
  description: z.string().trim().max(500, "At most 500 characters"),
  visibility: z.enum(["public", "private"]),
});

/** The values of the general settings form (description, visibility). */
export type GeneralSettingsValues = z.infer<typeof generalSettingsSchema>;

/** The update patch of the general settings; an empty description is stored as null. */
export function toGeneralPatch(values: GeneralSettingsValues) {
  const description = values.description.trim();
  return { description: description === "" ? null : description, visibility: values.visibility };
}

/** Hosted proto settings. */
export const protoHostedSchema = z.object({
  allowRedeploy: z.boolean(),
  allowReleases: z.boolean(),
  allowSnapshots: z.boolean(),
  resolutionPriority: z
    .number({ error: "Enter a number" })
    .int("Enter a whole number")
    .min(0, "Must be 0 or more")
    .max(RESOLUTION_PRIORITY_MAX, `Must be at most ${RESOLUTION_PRIORITY_MAX}`),
}) satisfies z.ZodType<ProtoHostedConfig>;

/** Hosted Maven settings. */
export const mavenHostedSchema = z.object({
  versionPolicy: z.enum(["release", "snapshot", "mixed"]),
  redeploy: z.boolean(),
}) satisfies z.ZodType<MavenHostedConfig>;

/** Hosted Docker settings. */
export const dockerHostedSchema = z.object({ tagImmutable: z.boolean() }) satisfies z.ZodType<DockerHostedConfig>;

const GIB = 1024 ** 3;

/** `cacheStore` value that leaves the choice to the server's default cache storage. */
export const DEFAULT_STORE = "default";

const optionalPositive = (message: string) => z.number({ error: "Enter a number" }).positive(message).nullable();

/** The mirror settings form: upstreams, cache, offline mode, rules and the Docker options. */
export const mirrorSettingsSchema = z
  .object({
    upstreams: z
      .array(
        z.object({
          url: z.string().trim().refine(isHttpUrl, "Enter an http or https URL"),
          authType: z.enum(["none", "basic", "bearer"]),
          username: z.string().trim().max(200),
          /** Empty keeps the stored secret while {@link keepsStoredSecret} holds. */
          secret: z.string().max(4000),
          /** The upstream as loaded from the server; null for a row added in the form. */
          stored: z
            .object({ url: z.string(), authType: z.enum(["none", "basic", "bearer"]), username: z.string(), hasSecret: z.boolean() })
            .nullable(),
        }),
      )
      .min(1, "A mirror needs at least one upstream"),
    cacheEnabled: z.boolean(),
    cacheStore: z.string(),
    metadataTtlSeconds: z.number({ error: "Enter a number" }).int("Enter a whole number").min(0, "Must be 0 or more"),
    maxAgeDays: optionalPositive("Must be more than 0").refine((v) => v === null || Number.isInteger(v), "Enter a whole number"),
    maxSizeGib: optionalPositive("Must be more than 0"),
    /** The stored max size in bytes, kept as is when the GiB field still shows it. */
    storedMaxSizeBytes: z.number().nullable(),
    offline: z.boolean(),
    allow: z.string(),
    deny: z.string(),
    dockerHub: z.boolean(),
    dockerRoot: z.boolean(),
  })
  .superRefine((values, ctx) => {
    values.upstreams.forEach((u, index) => {
      if (u.authType === "basic" && u.username.trim() === "") {
        ctx.addIssue({ code: "custom", path: ["upstreams", index, "username"], message: "Basic auth needs a username" });
      }
      if (u.authType === "bearer" && u.secret === "" && !keepsStoredSecret(u)) {
        ctx.addIssue({ code: "custom", path: ["upstreams", index, "secret"], message: "Bearer auth needs a token" });
      }
    });
  });

/** The values of the mirror settings form, as {@link mirrorSettingsSchema} validates them. */
export type MirrorSettingsValues = z.infer<typeof mirrorSettingsSchema>;

/** One upstream row of the mirror settings form. */
export type UpstreamFormRow = MirrorSettingsValues["upstreams"][number];

/**
 * Whether saving `row` with an empty secret keeps the stored one. The server keeps it only for an
 * upstream with the same URL, auth type and (for basic auth) username as the stored one.
 */
export function keepsStoredSecret(row: UpstreamFormRow): boolean {
  const stored = row.stored;
  return (
    stored !== null &&
    stored.hasSecret &&
    row.authType !== "none" &&
    stored.url === row.url.trim() &&
    stored.authType === row.authType &&
    (row.authType !== "basic" || stored.username === row.username.trim())
  );
}

/** A new, empty upstream row. */
export const EMPTY_UPSTREAM: MirrorSettingsValues["upstreams"][number] = {
  url: "",
  authType: "none",
  username: "",
  secret: "",
  stored: null,
};

/** The max size in GiB as the form shows it (two decimals). */
function toGib(bytes: number | null): number | null {
  return bytes === null ? null : Math.round((bytes / GIB) * 100) / 100;
}

/** One pattern per non-empty line, trimmed. */
export function parsePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The form values of a mirror's stored config and upstreams. */
export function toMirrorFormValues(repo: { config: unknown; dockerRoot: boolean }, upstreams: UpstreamView[]): MirrorSettingsValues {
  const config = repo.config as MirrorConfig;
  return {
    upstreams: upstreams.map((u) => ({
      url: u.url,
      authType: u.authType,
      username: u.username ?? "",
      secret: "",
      stored: { url: u.url, authType: u.authType, username: u.username ?? "", hasSecret: u.hasSecret },
    })),
    cacheEnabled: config.cache.enabled,
    cacheStore: config.cache.store ?? DEFAULT_STORE,
    metadataTtlSeconds: config.cache.metadataTtlSeconds,
    maxAgeDays: config.cache.maxAgeDays,
    maxSizeGib: toGib(config.cache.maxSizeBytes),
    storedMaxSizeBytes: config.cache.maxSizeBytes,
    offline: config.offline,
    allow: config.rules.allow.join("\n"),
    deny: config.rules.deny.join("\n"),
    dockerHub: config.dockerHub ?? false,
    dockerRoot: repo.dockerRoot,
  };
}

/**
 * The update patch of the mirror form. An empty secret is omitted, so the server keeps the stored
 * one (for the same URL, auth type and username); the Docker options are sent for Docker only.
 */
export function toMirrorPatch(values: MirrorSettingsValues, format: Format) {
  const upstreams = values.upstreams.map((u) => {
    const authType: UpstreamAuthType = u.authType;
    if (authType === "none") return { url: u.url.trim(), authType };
    return {
      url: u.url.trim(),
      authType,
      username: authType === "basic" ? u.username.trim() : null,
      ...(u.secret === "" ? {} : { secret: u.secret }),
    };
  });
  const docker = format === "docker";
  return {
    upstreams,
    config: {
      cache: {
        enabled: values.cacheEnabled,
        store: values.cacheStore === DEFAULT_STORE ? null : (values.cacheStore as StoreId),
        metadataTtlSeconds: values.metadataTtlSeconds,
        maxAgeDays: values.maxAgeDays,
        maxSizeBytes:
          values.maxSizeGib === null
            ? null
            : values.maxSizeGib === toGib(values.storedMaxSizeBytes)
              ? values.storedMaxSizeBytes
              : Math.round(values.maxSizeGib * GIB),
      },
      offline: values.offline,
      rules: { allow: parsePatterns(values.allow), deny: parsePatterns(values.deny) },
      ...(docker ? { dockerHub: values.dockerHub } : {}),
    },
    ...(docker ? { dockerRoot: values.dockerRoot } : {}),
  };
}

/**
 * Whether deleting the repository is refused while it holds `artifactCount` artifacts: proto
 * hosted repositories only, because artifacts in other repositories may depend on them. The
 * server guard and the Delete button both use this.
 */
export function deleteBlocked(repo: { format: Format; kind: Kind }, artifactCount: number): boolean {
  return repo.format === "proto" && repo.kind === "hosted" && artifactCount > 0;
}

/** Whether a key entry on a repository of this format and kind can be narrowed to a group prefix. */
export function supportsGroupPrefix(repo: { format: Format; kind: Kind }): boolean {
  return repo.format === "proto" && repo.kind !== "group";
}

import { z } from "zod";
import type { Format } from "@weaver/core";
import { CLEANUP_KINDS_BY_FORMAT, kindUsesPattern, type CleanupKind } from "@weaver/core/cleanup-kinds";
import { GROUP_PREFIX_HINT, isValidGroupPrefix } from "./names";

/** What a policy's `value` counts: builds, versions or tags to keep, or a number of days. */
export type PolicyUnit = "builds" | "versions" | "tags" | "days";

/** Labels and help text of one cleanup kind on a repository of one format, for the policy dialog. */
export interface PolicyKindInfo {
  title: string;
  description: string;
  unit: PolicyUnit;
  /** Label of the `groupPrefix` field, which scopes the policy in the format's own terms. */
  scopeLabel: string;
}

/** The label of the `groupPrefix` field per format. */
const SCOPE_LABELS: Record<Format, string> = {
  proto: "Group prefix",
  maven: "groupId prefix",
  npm: "Package prefix",
  docker: "Image prefix",
};

/** Example scope prefix per format, shown as a hint under the field. */
const SCOPE_HINTS: Record<Format, string> = {
  proto: GROUP_PREFIX_HINT,
  maven: "Matches every groupId that starts with it, e.g. org.example covers org.example.lib.",
  npm: "Matches every package name that starts with it, e.g. @acme/ covers the whole @acme scope.",
  docker: "Matches every image name that starts with it, e.g. team/ covers team/api and team/web.",
};

/** Formats whose `delete_not_downloaded` keeps releases unless `includeReleases` is set. */
const RELEASE_FORMATS: ReadonlySet<Format> = new Set<Format>(["proto", "maven"]);

/** Whether `includeReleases` means anything for `kind` on a repository of `format`. */
export function kindUsesIncludeReleases(format: Format, kind: CleanupKind): boolean {
  return kind === "delete_not_downloaded" && RELEASE_FORMATS.has(format);
}

/** The cleanup kinds a repository of `format` can have, in the order the dialog offers them. */
export function policyKinds(format: Format): readonly CleanupKind[] {
  return CLEANUP_KINDS_BY_FORMAT[format];
}

/** Title, description, unit and scope label of `kind` on a repository of `format`. */
export function policyKindInfo(format: Format, kind: CleanupKind): PolicyKindInfo {
  const scopeLabel = SCOPE_LABELS[format];
  switch (kind) {
    case "keep_last_snapshot_builds":
      return {
        title: "Keep last N snapshot builds",
        description: "Deletes older builds of every -SNAPSHOT version and keeps the newest N.",
        unit: "builds",
        scopeLabel,
      };
    case "delete_stale_snapshots":
      return {
        title: "Delete stale snapshots",
        description: "Deletes whole -SNAPSHOT versions nobody has published to for X days.",
        unit: "days",
        scopeLabel,
      };
    case "delete_not_downloaded":
      if (format === "docker") {
        return {
          title: "Delete tags not pulled",
          description: "Deletes tags nobody has pulled for X days. A pull by digest counts for every tag of that digest.",
          unit: "days",
          scopeLabel,
        };
      }
      if (format === "npm") {
        return {
          title: "Delete not downloaded",
          description: "Deletes versions nobody has downloaded for X days. Versions a dist-tag points to are kept.",
          unit: "days",
          scopeLabel,
        };
      }
      return {
        title: "Delete not downloaded",
        description: "Deletes versions nobody has downloaded for X days. Snapshots only, unless releases are included.",
        unit: "days",
        scopeLabel,
      };
    case "keep_last_versions":
      return {
        title: "Keep last N versions",
        description: "Deletes older versions of every package and keeps the newest N. Versions a dist-tag points to are kept.",
        unit: "versions",
        scopeLabel,
      };
    case "delete_untagged_manifests":
      return {
        title: "Delete untagged manifests",
        description: "Deletes manifests without a tag after X days. Children of an index and live referrers are kept.",
        unit: "days",
        scopeLabel,
      };
    case "keep_last_tags":
      return {
        title: "Keep last N tags",
        description: "Deletes older tags matching a pattern and keeps the newest N of each image.",
        unit: "tags",
        scopeLabel,
      };
    default: {
      const unknown: never = kind;
      throw new Error(`Unknown cleanup kind ${String(unknown)}`);
    }
  }
}

/** The hint under the scope prefix field of a repository of `format`. */
export function scopeHint(format: Format): string {
  return SCOPE_HINTS[format];
}

/** Longest scope prefix and tag pattern accepted. */
export const POLICY_TEXT_MAX = 200;

const PLAIN_TEXT_RE = /^[^\s\p{Cc}]+$/u;

/**
 * Whether `prefix` is a valid scope for a policy of a `format` repository: a group such as
 * `com.acme` for proto, any string without whitespace or control characters for the others.
 */
export function isValidScopePrefix(format: Format, prefix: string): boolean {
  if (prefix.length === 0 || prefix.length > POLICY_TEXT_MAX) return false;
  return format === "proto" ? isValidGroupPrefix(prefix) : PLAIN_TEXT_RE.test(prefix);
}

/** Whether `pattern` is a valid tag glob (`*` matches any run of characters): no whitespace or control characters. */
export function isValidTagPattern(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= POLICY_TEXT_MAX && PLAIN_TEXT_RE.test(pattern);
}

/** Highest value the server accepts (100 years of days). */
export const POLICY_VALUE_MAX = 36_500;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "the last 5 tags", or "the last tag" for 1. */
const lastN = (n: number, word: string) => (n === 1 ? `the last ${word}` : `the last ${n} ${word}s`);

/** One-line, human description of a rule of a `format` repository, e.g. "Keep the last 5 tags matching v*". */
export function describePolicy(
  format: Format,
  policy: { kind: CleanupKind; value: number; includeReleases?: boolean; pattern?: string | null },
): string {
  const { kind, value } = policy;
  switch (kind) {
    case "keep_last_snapshot_builds":
      return `Keep ${lastN(value, "build")} of each snapshot`;
    case "delete_stale_snapshots":
      return `Delete snapshots not published to for ${plural(value, "day")}`;
    case "delete_not_downloaded":
      if (format === "docker") return `Delete tags not pulled for ${plural(value, "day")}`;
      if (format === "npm") return `Delete versions not downloaded for ${plural(value, "day")}`;
      return `Delete ${policy.includeReleases ? "snapshots and releases" : "snapshots"} not downloaded for ${plural(value, "day")}`;
    case "keep_last_versions":
      return `Keep ${lastN(value, "version")} of each package`;
    case "delete_untagged_manifests":
      return `Delete untagged manifests older than ${plural(value, "day")}`;
    case "keep_last_tags":
      return `Keep ${lastN(value, "tag")} matching ${policy.pattern ?? "*"}`;
    default: {
      const unknown: never = kind;
      throw new Error(`Unknown cleanup kind ${String(unknown)}`);
    }
  }
}

/** The values of the add/edit policy form; `groupPrefix` and `pattern` are free text, empty meaning none. */
export interface PolicyFormValues {
  kind: CleanupKind;
  value: number;
  groupPrefix: string;
  pattern: string;
  includeReleases: boolean;
  enabled: boolean;
}

/**
 * The add/edit policy form of a `format` repository: one of the format's kinds, an optional scope
 * prefix valid for the format, and a tag pattern when the kind uses one.
 */
export function policyFormSchema(format: Format): z.ZodType<PolicyFormValues, PolicyFormValues> {
  const kinds = CLEANUP_KINDS_BY_FORMAT[format] as readonly [CleanupKind, ...CleanupKind[]];
  return z
    .object({
      kind: z.enum(kinds),
      value: z
        .number({ error: "Enter a number" })
        .int("Enter a whole number")
        .min(1, "Must be at least 1")
        .max(POLICY_VALUE_MAX, `Must be at most ${POLICY_VALUE_MAX}`),
      groupPrefix: z
        .string()
        .trim()
        .refine(
          (value) => value === "" || isValidScopePrefix(format, value),
          format === "proto" ? "Not a valid group, e.g. com.acme" : `No spaces, at most ${POLICY_TEXT_MAX} characters`,
        ),
      pattern: z.string().trim(),
      includeReleases: z.boolean(),
      enabled: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (!kindUsesPattern(values.kind)) return;
      if (values.pattern === "") {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: "Enter a tag pattern, e.g. v*" });
      } else if (!isValidTagPattern(values.pattern)) {
        ctx.addIssue({ code: "custom", path: ["pattern"], message: `No spaces, at most ${POLICY_TEXT_MAX} characters` });
      }
    });
}

/**
 * The `policies.upsert` input for the form values of a `format` repository; `id` updates an
 * existing policy. Fields the kind does not use are cleared: `pattern` to null, `includeReleases` to false.
 */
export function toPolicyInput(format: Format, repository: string, id: string | undefined, values: PolicyFormValues) {
  const prefix = values.groupPrefix.trim();
  return {
    repository,
    ...(id ? { id } : {}),
    kind: values.kind,
    value: values.value,
    groupPrefix: prefix === "" ? null : prefix,
    pattern: kindUsesPattern(values.kind) ? values.pattern.trim() : null,
    includeReleases: kindUsesIncludeReleases(format, values.kind) && values.includeReleases,
    enabled: values.enabled,
  };
}

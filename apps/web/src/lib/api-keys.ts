import { z } from "zod";
import type { Role } from "@weaver/core";
import { isValidGroupPrefix } from "./names";

export type KeyAccess = "read" | "write";

/** The access levels a user of `role` may put on a key (viewers: read only). Mirrors core `maxKeyAccess`. */
export function accessOptionsFor(role: Role): KeyAccess[] {
  return role === "viewer" ? ["read"] : ["read", "write"];
}

/** Expiry choices of the create dialog, in days, or `never`. */
export const EXPIRY_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
] as const;

export type ExpiryChoice = (typeof EXPIRY_OPTIONS)[number]["value"];

/** Short text per permission entry, e.g. `write main` or `read team · com.acme.*`, with its access level. */
export function summarizePermissions(
  permissions: { repository: string; groupPrefix: string | null; access: KeyAccess }[],
): { text: string; access: KeyAccess }[] {
  return permissions.map((p) => ({
    text: `${p.access} ${p.repository}${p.groupPrefix ? ` · ${p.groupPrefix}.*` : ""}`,
    access: p.access,
  }));
}

const permissionRow = z.object({
  repository: z.string().min(1, "Choose a repository"),
  groupPrefix: z
    .string()
    .refine((value) => value.trim() === "" || isValidGroupPrefix(value.trim()), "Not a valid group, e.g. com.acme"),
  access: z.enum(["read", "write"]),
});

/** The create-key form: a name, an expiry and one or more permission rows. */
export const keyFormSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(32, "At most 32 characters"),
  expiry: z.enum(EXPIRY_OPTIONS.map((o) => o.value) as [ExpiryChoice, ...ExpiryChoice[]]),
  permissions: z.array(permissionRow).min(1, "Add at least one permission"),
});

export type KeyFormValues = z.input<typeof keyFormSchema>;

/** The `keys.create` input for the form values. */
export function toCreateKeyInput(values: KeyFormValues) {
  return {
    name: values.name.trim(),
    ...(values.expiry === "never" ? {} : { expiresInDays: Number(values.expiry) }),
    permissions: values.permissions.map((p) => {
      const prefix = p.groupPrefix.trim();
      return { repository: p.repository, groupPrefix: prefix === "" ? null : prefix, access: p.access };
    }),
  };
}

export type CreateKeyInput = ReturnType<typeof toCreateKeyInput>;

/**
 * Wraps the `keys.create` call so the secret goes straight to `onSecret` and the returned value
 * (which TanStack Query keeps in its mutation cache) holds only the key id.
 */
export function withheldSecret(
  create: (input: CreateKeyInput) => Promise<{ id: string; key: string }>,
  onSecret: (key: string, input: CreateKeyInput) => void,
): (input: CreateKeyInput) => Promise<{ id: string }> {
  return async (input) => {
    const { id, key } = await create(input);
    onSecret(key, input);
    return { id };
  };
}

"use client";

import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { PlusIcon, XIcon } from "lucide-react";
import type { Format, Kind, Role } from "@weaver/core";
import { Button } from "@weaver/ui/components/button";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { Input } from "@weaver/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { FormatBadge } from "@/app/(app)/repositories/_components/format-badge";
import { EXPIRY_OPTIONS, accessOptionsFor, type KeyFormValues } from "@/lib/api-keys";
import { supportsGroupPrefix } from "@/lib/repository-settings";

/** A repository a key permission row can name. */
export interface KeyFormRepository {
  name: string;
  format: Format;
  kind: Kind;
}

const emptyRow = { repository: "", groupPrefix: "", access: "read" } as const;

/**
 * The fields of the create-key form, inside a react-hook-form `<Form>`: name, expiry and permission
 * rows (repository picked from a list with format badges, optional group prefix for proto, access
 * limited by `role` and read-only for groups). Used by the keys dialog and the npm login page.
 */
export function KeyFormFields({
  form,
  repositories: repos,
  loading,
  role,
  autoFocusName = true,
}: {
  form: UseFormReturn<KeyFormValues>;
  repositories: KeyFormRepository[];
  loading: boolean;
  role: Role;
  autoFocusName?: boolean;
}) {
  const rows = useFieldArray({ control: form.control, name: "permissions" });
  const accessOptions = accessOptionsFor(role);
  const repoByName = new Map(repos.map((r) => [r.name, r]));

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} autoFocus={autoFocusName} autoComplete="off" placeholder="ci-orders-service" maxLength={32} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="expiry"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Expires after</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Permissions</legend>
        <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_2rem] gap-2 text-xs text-muted-foreground sm:grid">
          <span>Repository</span>
          <span>Group prefix (optional)</span>
          <span>Access</span>
        </div>
        {rows.fields.map((row, index) => {
          const chosen = repoByName.get(form.watch(`permissions.${index}.repository`));
          // Groups are read-only; group prefixes only narrow proto hosted and mirror repositories.
          const rowAccess = chosen?.kind === "group" ? accessOptions.filter((a) => a === "read") : accessOptions;
          const prefixApplies = chosen === undefined || supportsGroupPrefix(chosen);
          return (
            <div
              key={row.id}
              data-testid="permission-row"
              className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2 rounded-md border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_2.25rem] sm:items-start sm:border-0 sm:p-0"
            >
              <FormField
                control={form.control}
                name={`permissions.${index}.repository`}
                render={({ field }) => (
                  <FormItem className="gap-1">
                    <Select
                      value={field.value}
                      onValueChange={(name) => {
                        field.onChange(name);
                        const repo = repoByName.get(name);
                        if (repo?.kind === "group") form.setValue(`permissions.${index}.access`, "read");
                        if (repo && !supportsGroupPrefix(repo)) form.setValue(`permissions.${index}.groupPrefix`, "");
                      }}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full min-w-0 font-mono data-[placeholder]:font-sans" aria-label="Repository">
                          <SelectValue placeholder={loading ? "Loading…" : "Choose repository"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {repos.length === 0 && !loading && (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">No repositories yet</div>
                        )}
                        {repos.map((repo) => (
                          <SelectItem key={repo.name} value={repo.name} className="font-mono">
                            <FormatBadge format={repo.format} className="w-14 shrink-0 justify-center" aria-hidden />
                            <span className="truncate">{repo.name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`permissions.${index}.groupPrefix`}
                render={({ field }) => (
                  <FormItem className="col-span-2 gap-1 sm:col-span-1">
                    <FormControl>
                      <Input
                        {...field}
                        aria-label="Group prefix"
                        disabled={!prefixApplies}
                        placeholder={prefixApplies ? "all groups" : "not for this repository"}
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono placeholder:font-sans"
                      />
                    </FormControl>
                    <FormMessage className="text-xs" />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name={`permissions.${index}.access`}
                render={({ field }) => (
                  <FormItem className="col-span-2 gap-1 sm:col-span-1">
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full" aria-label="Access">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {rowAccess.map((access) => (
                          <SelectItem key={access} value={access}>
                            {access}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove permission"
                disabled={rows.fields.length === 1}
                onClick={() => rows.remove(index)}
                className="col-start-2 row-start-1 justify-self-end sm:col-start-4"
              >
                <XIcon />
              </Button>
            </div>
          );
        })}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={rows.fields.length >= 100}
            onClick={() => rows.append({ ...emptyRow })}
          >
            <PlusIcon />
            Add permission
          </Button>
          <FormDescription className="text-xs">
            {role === "viewer"
              ? "As a viewer you can create read-only keys (download only)."
              : "read: download. write: also publish and delete. Groups are read-only. A group prefix (proto only) covers the groups below it too."}
          </FormDescription>
        </div>
        {form.formState.errors.permissions?.root?.message && (
          <p className="text-sm text-destructive">{form.formState.errors.permissions.root.message}</p>
        )}
      </fieldset>
    </>
  );
}

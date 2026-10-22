"use client";

import { useFieldArray, useWatch, type UseFormReturn } from "react-hook-form";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import type { Format } from "@weaver/core";
import { Button } from "@weaver/ui/components/button";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { Input } from "@weaver/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { EMPTY_UPSTREAM, UPSTREAM_EXAMPLES, keepsStoredSecret, type MirrorSettingsValues } from "@/lib/repository-settings";

const AUTH_TYPES = [
  { value: "none", label: "No auth" },
  { value: "basic", label: "Basic" },
  { value: "bearer", label: "Bearer token" },
] as const;

/** Most upstreams a mirror can have (the server's limit). */
const MAX_UPSTREAMS = 20;

function UpstreamRow({
  form,
  index,
  count,
  format,
  onMove,
  onRemove,
}: {
  form: UseFormReturn<MirrorSettingsValues>;
  index: number;
  count: number;
  format: Format;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const row = useWatch({ control: form.control, name: `upstreams.${index}` });
  const authType = row.authType;
  // Once the URL, auth type or username changes, the server drops the stored secret.
  const hasSecret = keepsStoredSecret(row);
  const position = index + 1;

  return (
    <li data-testid="upstream-row" className="grid gap-3 px-4 py-3">
      <div className="flex items-start gap-2">
        <span className="mt-2 w-5 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">{position}</span>
        <FormField
          control={form.control}
          name={`upstreams.${index}.url`}
          render={({ field }) => (
            <FormItem className="min-w-0 flex-1 gap-1">
              <FormLabel className="sr-only">Upstream {position} URL</FormLabel>
              <FormControl>
                <Input {...field} placeholder={UPSTREAM_EXAMPLES[format]} autoComplete="off" spellCheck={false} className="font-mono" />
              </FormControl>
              <FormMessage className="text-xs" />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name={`upstreams.${index}.authType`}
          render={({ field }) => (
            <FormItem className="gap-1">
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-36" aria-label={`Upstream ${position} auth`}>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {AUTH_TYPES.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormItem>
          )}
        />
        <div className="flex shrink-0">
          <Button type="button" variant="ghost" size="icon" aria-label={`Move upstream ${position} up`} disabled={index === 0} onClick={() => onMove(index - 1)}>
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Move upstream ${position} down`}
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <ArrowDownIcon />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove upstream ${position}`} disabled={count === 1} onClick={onRemove}>
            <XIcon />
          </Button>
        </div>
      </div>
      {authType !== "none" && (
        <div className="grid gap-2 pl-7 sm:grid-cols-2">
          {authType === "basic" && (
            <FormField
              control={form.control}
              name={`upstreams.${index}.username`}
              render={({ field }) => (
                <FormItem className="gap-1">
                  <FormLabel className="text-xs">Username</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" spellCheck={false} />
                  </FormControl>
                  <FormMessage className="text-xs" />
                </FormItem>
              )}
            />
          )}
          <FormField
            control={form.control}
            name={`upstreams.${index}.secret`}
            render={({ field }) => (
              <FormItem className="gap-1">
                <FormLabel className="text-xs">{authType === "basic" ? "Password" : "Token"}</FormLabel>
                <FormControl>
                  <Input {...field} type="password" autoComplete="new-password" placeholder={hasSecret ? "stored" : ""} />
                </FormControl>
                {hasSecret && <p className="text-[11px] text-muted-foreground">Leave empty to keep the stored secret.</p>}
                <FormMessage className="text-xs" />
              </FormItem>
            )}
          />
        </div>
      )}
    </li>
  );
}

/**
 * The ordered upstreams of a mirror inside the mirror settings form: tried top to bottom until one
 * answers. Each has an auth type; stored secrets are never shown, only marked "stored".
 */
export function UpstreamsEditor({ form, format }: { form: UseFormReturn<MirrorSettingsValues>; format: Format }) {
  const rows = useFieldArray({ control: form.control, name: "upstreams" });
  return (
    <div className="grid">
      <ol className="divide-y">
        {rows.fields.map((row, index) => (
          <UpstreamRow
            key={row.id}
            form={form}
            index={index}
            count={rows.fields.length}
            format={format}
            onMove={(to) => rows.move(index, to)}
            onRemove={() => rows.remove(index)}
          />
        ))}
      </ol>
      <div className="px-4 pb-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.fields.length >= MAX_UPSTREAMS}
          onClick={() => rows.append({ ...EMPTY_UPSTREAM })}
        >
          <PlusIcon />
          Add upstream
        </Button>
      </div>
    </div>
  );
}

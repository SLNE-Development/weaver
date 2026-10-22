"use client";

import { useEffect, useMemo, useRef } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Button } from "@weaver/ui/components/button";
import { Checkbox } from "@weaver/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@weaver/ui/components/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { Input } from "@weaver/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@weaver/ui/components/radio-group";
import { Spinner } from "@weaver/ui/components/spinner";
import { Switch } from "@weaver/ui/components/switch";
import type { Format } from "@weaver/core";
import { kindUsesPattern } from "@weaver/core/cleanup-kinds";
import {
  describePolicy,
  kindUsesIncludeReleases,
  policyFormSchema,
  policyKindInfo,
  policyKinds,
  scopeHint,
  type PolicyFormValues,
  type PolicyUnit,
} from "@/lib/cleanup-policies";

/** The new-policy defaults of a `format` repository: its first kind. */
const emptyValues = (format: Format): PolicyFormValues => ({
  kind: policyKinds(format)[0]!,
  value: 10,
  groupPrefix: "",
  pattern: "",
  includeReleases: false,
  enabled: true,
});

/** Label of the value field per unit. */
const VALUE_LABELS: Record<PolicyUnit, string> = {
  builds: "Builds to keep",
  versions: "Versions to keep",
  tags: "Tags to keep",
  days: "Days",
};

/**
 * Add or edit one cleanup policy of a `format` repository, offering only the format's kinds and
 * the options they use. `initial` (an existing policy) switches the dialog to edit mode.
 */
export function PolicyDialog({
  format,
  open,
  onOpenChange,
  initial,
  submitting,
  onSubmit,
}: {
  format: Format;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: PolicyFormValues | null;
  submitting: boolean;
  onSubmit: (values: PolicyFormValues) => Promise<unknown>;
}) {
  const schema = useMemo(() => policyFormSchema(format), [format]);
  const empty = useMemo(() => emptyValues(format), [format]);
  const form = useForm<PolicyFormValues>({ resolver: zodResolver(schema), defaultValues: initial ?? empty });
  // Reset only when the dialog opens, never while it is being edited (a failed save keeps the input).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) form.reset(initial ?? empty);
    wasOpen.current = open;
  }, [open, initial, empty, form]);

  const [kind, value, includeReleases, groupPrefix, pattern] = useWatch({
    control: form.control,
    name: ["kind", "value", "includeReleases", "groupPrefix", "pattern"],
  });
  const info = policyKindInfo(format, kind);
  const usesPattern = kindUsesPattern(kind);
  const preview =
    Number.isInteger(value) && value > 0
      ? describePolicy(format, { kind, value, includeReleases, pattern: pattern.trim() || "…" })
      : null;
  const prefix = groupPrefix.trim();

  async function submit(values: PolicyFormValues) {
    try {
      await onSubmit(values);
      onOpenChange(false);
    } catch {
      // The caller shows the error; keep the dialog open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit cleanup policy" : "Add cleanup policy"}</DialogTitle>
          <DialogDescription>Policies only ever delete; nothing is archived. Use Preview to see what a rule matches.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} noValidate className="grid gap-5">
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rule</FormLabel>
                  <FormControl>
                    <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-2">
                      {policyKinds(format).map((option) => {
                        const optionInfo = policyKindInfo(format, option);
                        return (
                          <label
                            key={option}
                            className="flex cursor-pointer gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50 has-data-[state=checked]:border-foreground has-data-[state=checked]:bg-muted/40"
                          >
                            <RadioGroupItem value={option} aria-label={optionInfo.title} className="mt-0.5" />
                            <span className="grid gap-0.5">
                              <span className="text-sm font-medium">{optionInfo.title}</span>
                              <span className="text-xs text-muted-foreground">{optionInfo.description}</span>
                            </span>
                          </label>
                        );
                      })}
                    </RadioGroup>
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <FormField
                control={form.control}
                name="value"
                render={({ field }) => (
                  <FormItem className="content-start">
                    <FormLabel>{VALUE_LABELS[info.unit]}</FormLabel>
                    <div className="flex items-center gap-2">
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          step={1}
                          className="w-24 font-mono tabular-nums"
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          value={Number.isNaN(field.value) ? "" : field.value}
                          onChange={(event) => field.onChange(event.target.valueAsNumber)}
                        />
                      </FormControl>
                      <span className="text-sm text-muted-foreground">{info.unit}</span>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="groupPrefix"
                render={({ field }) => (
                  <FormItem className="content-start">
                    <FormLabel>{info.scopeLabel}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="Everything" autoComplete="off" spellCheck={false} className="font-mono placeholder:font-sans" />
                    </FormControl>
                    <FormDescription className="text-xs">Optional. {scopeHint(format)}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {usesPattern && (
              <FormField
                control={form.control}
                name="pattern"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tag pattern</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="v*" autoComplete="off" spellCheck={false} className="font-mono" />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Only tags matching it are counted and deleted; * matches any characters. Other tags are kept.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {kindUsesIncludeReleases(format, kind) && (
              <FormField
                control={form.control}
                name="includeReleases"
                render={({ field }) => (
                  <FormItem className="gap-3">
                    <div className="flex items-start gap-3">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} className="mt-0.5" />
                      </FormControl>
                      <div className="grid gap-1">
                        <FormLabel>Include releases</FormLabel>
                        <FormDescription className="text-xs">Also delete release versions nobody has downloaded.</FormDescription>
                      </div>
                    </div>
                    {field.value && (
                      <Alert variant="destructive">
                        <TriangleAlertIcon />
                        <AlertTitle>Releases will be deleted</AlertTitle>
                        <AlertDescription>
                          Builds pinned to an old release break once it is gone, and a deleted release can't be restored. Versions
                          other artifacts depend on are kept.
                        </AlertDescription>
                      </Alert>
                    )}
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between gap-4 rounded-md border px-3 py-2.5">
                  <div className="grid gap-0.5">
                    <FormLabel>Enabled</FormLabel>
                    <FormDescription className="text-xs">Disabled policies are kept but never run.</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            {preview && (
              <p className="rounded-md bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground" data-testid="policy-summary">
                {preview}
                {prefix ? ` in ${format === "proto" ? `${prefix}.*` : `${prefix}*`}` : ""}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Spinner />}
                {initial ? "Save policy" : "Add policy"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

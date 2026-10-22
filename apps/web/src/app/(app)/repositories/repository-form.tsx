"use client";

import { useEffect, type ReactNode } from "react";
import { useForm, type DefaultValues, type FieldPath, type FieldValues, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { GlobeIcon, LockIcon } from "lucide-react";
import type { z } from "zod";
import { Button } from "@weaver/ui/components/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { RadioGroup, RadioGroupItem } from "@weaver/ui/components/radio-group";
import { Spinner } from "@weaver/ui/components/spinner";
import { Switch } from "@weaver/ui/components/switch";
import { Textarea } from "@weaver/ui/components/textarea";
import { generalSettingsSchema, type GeneralSettingsValues } from "@/lib/repository-settings";

/** One settings row: label and explanation on the left, the control on the right (stacked on phones). */
export function SettingRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-8">{children}</div>;
}

/**
 * A form for one settings section, validated by `schema`. It takes newer server `values` (a
 * refetch after a save elsewhere) unless the user is editing.
 */
export function useSettingsForm<T extends FieldValues>(schema: z.ZodType<T>, values: T): UseFormReturn<T> {
  // The resolver's generics can't follow a generic schema; the schema's output is T.
  const form = useForm<T>({ resolver: zodResolver(schema as never) as never, defaultValues: values as DefaultValues<T> });
  const serverValues = JSON.stringify(values);
  useEffect(() => {
    if (!form.formState.isDirty) form.reset(JSON.parse(serverValues) as T);
  }, [serverValues, form]);
  return form;
}

/** The bordered frame of a settings form: rows, then a footer with Save changes (enabled once edited). */
export function SettingsForm<T extends FieldValues>({
  form,
  onSubmit,
  submitting,
  children,
}: {
  form: UseFormReturn<T>;
  /** Receives validated values; the caller runs the mutation and reports errors. */
  onSubmit: (values: T) => Promise<unknown>;
  submitting: boolean;
  children: ReactNode;
}) {
  async function submit(values: T) {
    try {
      await onSubmit(values);
      form.reset(values);
    } catch {
      // The caller reports the error; keep the input as typed.
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} noValidate className="rounded-md border">
        <div className="divide-y">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-4 py-3">
          <Button type="submit" size="sm" disabled={submitting || !form.formState.isDirty}>
            {submitting && <Spinner />}
            Save changes
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** A switch row bound to the boolean field `name` of `form`. */
export function SwitchRow<T extends FieldValues>({
  form,
  name,
  label,
  description,
}: {
  form: UseFormReturn<T>;
  name: FieldPath<T>;
  label: string;
  description: ReactNode;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <SettingRow>
            <div className="grid gap-1">
              <FormLabel>{label}</FormLabel>
              <FormDescription className="text-xs">{description}</FormDescription>
            </div>
            <FormControl>
              <Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} />
            </FormControl>
          </SettingRow>
        </FormItem>
      )}
    />
  );
}

/** Props for a number input bound to a field: `null` (an empty input) when `nullable`, otherwise NaN until valid. */
export function numberInputProps(
  field: { name: string; ref: (el: HTMLInputElement | null) => void; onBlur: () => void; onChange: (value: number | null) => void; value: unknown },
  nullable = false,
) {
  const value = field.value as number | null;
  return {
    type: "number" as const,
    inputMode: "decimal" as const,
    name: field.name,
    ref: field.ref,
    onBlur: field.onBlur,
    value: value === null || Number.isNaN(value) ? "" : value,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      field.onChange(nullable && event.target.value === "" ? null : event.target.valueAsNumber),
  };
}

const VISIBILITY = [
  {
    value: "public",
    icon: GlobeIcon,
    title: "Public",
    description: "Anyone can download from it without a key, and browse it in the UI when anonymous view is on.",
  },
  {
    value: "private",
    icon: LockIcon,
    title: "Private",
    description: "Only signed-in users and API keys with a permission on this repository can see it.",
  },
] as const;

/** Description and visibility of a repository. `onSubmit` receives validated values; the caller runs the mutation. */
export function GeneralSettingsForm({
  values,
  onSubmit,
  submitting,
}: {
  values: GeneralSettingsValues;
  onSubmit: (values: GeneralSettingsValues) => Promise<unknown>;
  submitting: boolean;
}) {
  const form = useSettingsForm(generalSettingsSchema, values);
  return (
    <SettingsForm form={form} onSubmit={onSubmit} submitting={submitting}>
      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem className="px-4 py-4">
            <FormLabel>Description</FormLabel>
            <FormControl>
              <Textarea {...field} rows={2} placeholder="What lives here, who owns it" className="resize-y" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="visibility"
        render={({ field }) => (
          <FormItem className="px-4 py-4">
            <FormLabel>Visibility</FormLabel>
            <FormControl>
              <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-2 sm:grid-cols-2">
                {VISIBILITY.map((option) => (
                  <label
                    key={option.value}
                    className="flex cursor-pointer gap-3 rounded-md border p-3 transition-colors hover:bg-muted/50 has-data-[state=checked]:border-foreground has-data-[state=checked]:bg-muted/40"
                  >
                    <RadioGroupItem value={option.value} aria-label={option.title} className="mt-0.5" />
                    <span className="grid gap-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <option.icon className="size-3.5 text-muted-foreground" />
                        {option.title}
                      </span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </SettingsForm>
  );
}

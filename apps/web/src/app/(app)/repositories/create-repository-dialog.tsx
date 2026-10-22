"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@weaver/ui/components/button";
import { Checkbox } from "@weaver/ui/components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@weaver/ui/components/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { Input } from "@weaver/ui/components/input";
import { RadioGroup, RadioGroupItem } from "@weaver/ui/components/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { Spinner } from "@weaver/ui/components/spinner";
import { REPOSITORY_NAME_HINT } from "@/lib/names";
import {
  FORMAT_OPTIONS,
  KIND_OPTIONS,
  NEW_REPOSITORY_DEFAULTS,
  UPSTREAM_EXAMPLES,
  createRepositorySchema,
  toCreateRepositoryInput,
  type CreateRepositoryValues,
} from "@/lib/repository-settings";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC } from "@/trpc/client";
import { KindLabel } from "./_components/format-badge";

/**
 * Creating a repository asks only what can't be changed later: name, format and kind, plus one
 * upstream URL for a mirror or the members of a group. Everything else starts at its default and
 * is set on the settings page, which opens after creating.
 */
export function CreateRepositoryDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useForm<CreateRepositoryValues>({ resolver: zodResolver(createRepositorySchema), defaultValues: NEW_REPOSITORY_DEFAULTS });
  const format = useWatch({ control: form.control, name: "format" });
  const kind = useWatch({ control: form.control, name: "kind" });
  const candidates = useQuery({ ...trpc.repositories.candidates.queryOptions({ format }), enabled: open && kind === "group" });

  const create = useMutation(
    trpc.repositories.create.mutationOptions({
      onSuccess: async (repo) => {
        toast.success(`Repository ${repo.name} created`);
        await queryClient.invalidateQueries({ queryKey: trpc.repositories.list.queryKey() });
        onOpenChange(false);
        router.push(`/repositories/${repo.name}/settings`);
      },
      onError: (error) => toast.error("Couldn't create the repository", { description: errorMessage(error) }),
    }),
  );

  useEffect(() => {
    if (!open) form.reset(NEW_REPOSITORY_DEFAULTS);
  }, [open, form]);

  // Members belong to one format; switching the format starts the selection over.
  useEffect(() => form.setValue("members", []), [format, form]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New repository</DialogTitle>
          <DialogDescription>Name, format and kind can&apos;t be changed later. Everything else is on the settings page.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((values) => create.mutate(toCreateRepositoryInput(values)))} noValidate className="grid gap-5">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} autoFocus autoComplete="off" spellCheck={false} placeholder="team-private" className="font-mono" />
                  </FormControl>
                  <FormDescription className="text-xs">{REPOSITORY_NAME_HINT}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="format"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Format</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full" aria-label="Format">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {FORMAT_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kind</FormLabel>
                  <FormControl>
                    <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-2 sm:grid-cols-3">
                      {KIND_OPTIONS.map((o) => (
                        <label
                          key={o.value}
                          className="flex cursor-pointer gap-2 rounded-md border p-3 transition-colors hover:bg-muted/50 has-data-[state=checked]:border-foreground has-data-[state=checked]:bg-muted/40"
                        >
                          <RadioGroupItem value={o.value} aria-label={o.label} className="mt-0.5" />
                          <span className="grid gap-0.5">
                            <span className="text-sm font-medium">{o.label}</span>
                            <span className="text-xs text-muted-foreground">{o.description}</span>
                          </span>
                        </label>
                      ))}
                    </RadioGroup>
                  </FormControl>
                </FormItem>
              )}
            />
            {kind === "mirror" && (
              <FormField
                control={form.control}
                name="upstreamUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Upstream URL</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="off" spellCheck={false} placeholder={UPSTREAM_EXAMPLES[format]} className="font-mono" />
                    </FormControl>
                    <FormDescription className="text-xs">More upstreams, credentials and caching are on the settings page.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {kind === "group" && (
              <FormField
                control={form.control}
                name="members"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Members</FormLabel>
                    <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border p-2">
                      {candidates.isPending ? (
                        <span className="px-1 text-sm text-muted-foreground">Loading…</span>
                      ) : (candidates.data ?? []).length === 0 ? (
                        <span className="px-1 text-sm text-muted-foreground">No hosted or mirror repositories of this format yet.</span>
                      ) : (
                        candidates.data!.map((c) => (
                          <label key={c.name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-muted/50">
                            <Checkbox
                              checked={field.value.includes(c.name)}
                              onCheckedChange={(checked) =>
                                field.onChange(checked ? [...field.value, c.name] : field.value.filter((n) => n !== c.name))
                              }
                            />
                            <span className="flex-1 font-mono text-sm">{c.name}</span>
                            <KindLabel kind={c.kind} />
                          </label>
                        ))
                      )}
                    </div>
                    <FormDescription className="text-xs">Searched in the order you pick them; reorder on the settings page.</FormDescription>
                  </FormItem>
                )}
              />
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Spinner />}
                Create repository
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

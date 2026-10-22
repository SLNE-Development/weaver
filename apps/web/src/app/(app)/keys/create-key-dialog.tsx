"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import type { Role } from "@weaver/core";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Button } from "@weaver/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@weaver/ui/components/dialog";
import { Form } from "@weaver/ui/components/form";
import { Spinner } from "@weaver/ui/components/spinner";
import { CopyButton } from "@/components/manage/copy-button";
import { KeyFormFields } from "@/components/manage/key-form-fields";
import {
  keyFormSchema,
  toCreateKeyInput,
  withheldSecret,
  type CreateKeyInput,
  type KeyFormValues,
} from "@/lib/api-keys";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC, useTRPCClient } from "@/trpc/client";

const emptyRow = { repository: "", groupPrefix: "", access: "read" } as const;
const DEFAULTS: KeyFormValues = { name: "", expiry: "90", permissions: [{ ...emptyRow }] };

/**
 * Create an API key: name, expiry and permission rows (repository picked from a list with format
 * badges, optional group prefix for proto, access limited by the caller's role and read-only for groups). On success the secret is shown exactly once; closing the dialog
 * drops it.
 */
export function CreateKeyDialog({ open, onOpenChange, role }: { open: boolean; onOpenChange: (open: boolean) => void; role: Role }) {
  const trpc = useTRPC();
  const trpcClient = useTRPCClient();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);
  const repositories = useQuery({ ...trpc.browse.repositories.queryOptions(), enabled: open });

  const form = useForm<KeyFormValues>({ resolver: zodResolver(keyFormSchema), defaultValues: DEFAULTS });

  // The secret never enters the mutation cache: `withheldSecret` hands it to component state and
  // the mutation only keeps `{ id }`.
  const create = useMutation({
    mutationFn: withheldSecret(
      (input: CreateKeyInput) => trpcClient.keys.create.mutate(input),
      (key, input) => setSecret({ name: input.name, key }),
    ),
    gcTime: 0,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.keys.list.queryKey() }),
    onError: (error) => toast.error("Couldn't create the key", { description: errorMessage(error) }),
  });
  const resetCreate = create.reset;

  useEffect(() => {
    if (open) return;
    // Forget the secret, the mutation state and the input once the dialog is closed.
    setSecret(null);
    resetCreate();
    form.reset(DEFAULTS);
  }, [open, form, resetCreate]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        // With the secret on screen, only Done or the close button closes the dialog.
        onInteractOutside={(event) => secret && event.preventDefault()}
        onEscapeKeyDown={(event) => secret && event.preventDefault()}
      >
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRoundIcon className="size-4" />
                Key {secret.name} created
              </DialogTitle>
              <DialogDescription>Copy the key now and store it somewhere safe, such as your CI secrets.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 sm:flex-row sm:items-center">
                <code data-testid="api-key-secret" className="min-w-0 flex-1 font-mono text-sm break-all select-all">
                  {secret.key}
                </code>
                <CopyButton value={secret.key} toastText="Key copied" />
              </div>
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>You won&apos;t see this key again</AlertTitle>
                <AlertDescription>
                  Weaver stores only a hash. If you lose the key, revoke it and create a new one.
                </AlertDescription>
              </Alert>
              <p className="text-xs text-muted-foreground">
                Use it as <code className="font-mono">WEAVER_TOKEN</code> for the CLI and the Gradle plugin, or send it as{" "}
                <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.
              </p>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                A key acts on your behalf, limited to the permissions below and to what your role allows.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((values) => create.mutate(toCreateKeyInput(values)))} noValidate className="grid gap-5">
                <KeyFormFields form={form} repositories={repositories.data ?? []} loading={repositories.isPending} role={role} />

                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending && <Spinner />}
                    Create key
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

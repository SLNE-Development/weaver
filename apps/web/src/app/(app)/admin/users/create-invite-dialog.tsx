"use client";

import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Button } from "@weaver/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@weaver/ui/components/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { Input } from "@weaver/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@weaver/ui/components/input-group";
import { Label } from "@weaver/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { Spinner } from "@weaver/ui/components/spinner";
import { Textarea } from "@weaver/ui/components/textarea";
import { useTRPC } from "@/trpc/client";
import { formatDateTime } from "../_components/format";

const ROLE_HINTS = {
  viewer: "Read-only access.",
  maintainer: "Publishes artifacts.",
  admin: "Full control.",
} as const;

const schema = z.object({
  role: z.enum(["admin", "maintainer", "viewer"]),
  expiresInDays: z
    .number({ error: "Enter a number of days" })
    .int("Whole days only")
    .min(1, "At least 1 day")
    .max(30, "At most 30 days"),
  note: z.string().trim().max(200, "Keep the note under 200 characters"),
});

type Values = z.infer<typeof schema>;

const DEFAULTS: Values = { role: "viewer", expiresInDays: 7, note: "" };

/** The one-time result: the absolute invite URL and when it expires. */
interface CreatedInvite {
  url: string;
  expiresAt: Date;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Invite link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy; select the link and copy it manually");
    }
  }
  return (
    <InputGroupButton size="icon-xs" aria-label="Copy invite link" onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </InputGroupButton>
  );
}

/**
 * Creates an invite (role, expiry of 1–30 days, optional note) and then shows its absolute link
 * once, with a copy button. Only the token's hash is stored, so the link can't be shown again.
 */
export function CreateInviteDialog({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  const create = useMutation(
    trpc.invites.create.mutationOptions({
      onSuccess: async (result) => {
        setCreated({ url: result.url, expiresAt: result.expiresAt });
        await onCreated();
      },
      onError: (error) => toast.error("Couldn't create the invite", { description: error.message }),
    }),
  );

  // Drop the one-time result when the dialog unmounts too (for example on navigation).
  const resetCreate = useRef(create.reset);
  resetCreate.current = create.reset;
  useEffect(() => () => resetCreate.current(), []);

  function changeOpen(next: boolean) {
    if (create.isPending) return;
    setOpen(next);
    if (!next) {
      // Forget the link as soon as the dialog closes; it must never be shown twice.
      setCreated(null);
      form.reset(DEFAULTS);
      create.reset();
    }
  }

  function submit(values: Values) {
    create.mutate({ role: values.role, expiresInDays: values.expiresInDays, note: values.note || undefined });
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon />
          Create invite
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-lg"
        // While the link is shown, only "Done" closes the dialog, so it isn't dismissed by accident.
        showCloseButton={!created}
        onInteractOutside={(event) => created && event.preventDefault()}
        onEscapeKeyDown={(event) => created && event.preventDefault()}
      >
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Invite created</DialogTitle>
              <DialogDescription>
                Send this link to the person you&apos;re inviting. It works once and expires {formatDateTime(created.expiresAt)}.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="invite-link">Invite link</Label>
              <InputGroup>
                <InputGroupInput
                  id="invite-link"
                  readOnly
                  value={created.url}
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <InputGroupAddon align="inline-end">
                  <CopyButton value={created.url} />
                </InputGroupAddon>
              </InputGroup>
            </div>
            <Alert className="border-snapshot/40 bg-snapshot-soft text-snapshot">
              <TriangleAlertIcon />
              <AlertTitle>Copy it now</AlertTitle>
              <AlertDescription className="text-snapshot/90">
                This link won&apos;t be shown again. If it gets lost, revoke the invite and create a new one.
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <DialogClose asChild>
                <Button>Done</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create invite</DialogTitle>
              <DialogDescription>
                An invite is a one-time link. Whoever opens it and signs in with GitHub or Discord joins with the role you pick.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form id="create-invite-form" onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4">
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Role</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full font-mono">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {(["viewer", "maintainer", "admin"] as const).map((role) => (
                              <SelectItem key={role} value={role} className="font-mono">
                                {role}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormDescription>{ROLE_HINTS[field.value]}</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="expiresInDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Expires in (days)</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={30}
                            name={field.name}
                            ref={field.ref}
                            onBlur={field.onBlur}
                            value={Number.isNaN(field.value) ? "" : field.value}
                            onChange={(event) => field.onChange(event.target.valueAsNumber)}
                          />
                        </FormControl>
                        <FormDescription>Between 1 and 30.</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="note"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Note</FormLabel>
                      <FormControl>
                        <Textarea rows={2} placeholder="Optional, e.g. who it's for" className="resize-none" {...field} />
                      </FormControl>
                      <FormDescription>Shown on the invite page and in the invite list.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </form>
            </Form>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={create.isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" form="create-invite-form" disabled={create.isPending}>
                {create.isPending && <Spinner />}
                Create invite
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

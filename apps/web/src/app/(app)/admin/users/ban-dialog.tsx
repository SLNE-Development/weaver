"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@weaver/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@weaver/ui/components/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { Input } from "@weaver/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { Spinner } from "@weaver/ui/components/spinner";
import { useTRPC } from "@/trpc/client";

const DURATIONS = [
  { value: "forever", label: "Until unbanned" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "365", label: "1 year" },
] as const;

const schema = z.object({
  reason: z.string().trim().max(200, "Keep the reason under 200 characters"),
  duration: z.enum(DURATIONS.map((d) => d.value) as [string, ...string[]]),
});

type Values = z.infer<typeof schema>;

const DEFAULTS: Values = { reason: "", duration: "forever" };

/**
 * Bans `user` after asking for an optional reason and duration. A ban ends their
 * sessions at once and stops their API keys.
 */
export function BanDialog({
  user,
  open,
  onOpenChange,
  onBanned,
}: {
  /** The user to ban; kept while the dialog animates closed. */
  user: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBanned: () => Promise<unknown>;
}) {
  const trpc = useTRPC();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  const ban = useMutation(
    trpc.users.ban.mutationOptions({
      onSuccess: async () => {
        toast.success(`${user?.name ?? "User"} banned`);
        await onBanned();
      },
      onError: (error) => toast.error("Couldn't ban the user", { description: error.message }),
    }),
  );

  useEffect(() => {
    if (open) form.reset(DEFAULTS);
  }, [open, form]);

  function submit(values: Values) {
    if (!user) return;
    ban.mutate({
      userId: user.id,
      reason: values.reason || undefined,
      expiresInDays: values.duration === "forever" ? undefined : Number(values.duration),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(open) => !ban.isPending && onOpenChange(open)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ban {user?.name}?</DialogTitle>
          <DialogDescription>
            They are signed out everywhere right away, can&apos;t sign in again, and their API keys stop working until the ban ends.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form id="ban-form" onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Input placeholder="Optional" autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>Recorded in the audit log.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="duration"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Duration</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DURATIONS.map((d) => (
                        <SelectItem key={d.value} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={ban.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form="ban-form" variant="destructive" disabled={ban.isPending}>
            {ban.isPending && <Spinner />}
            Ban user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

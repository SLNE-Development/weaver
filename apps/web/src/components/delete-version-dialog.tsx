"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { AlertTriangleIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@weaver/ui/components/alert-dialog";
import { Button } from "@weaver/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@weaver/ui/components/field";
import { Input } from "@weaver/ui/components/input";
import { Spinner } from "@weaver/ui/components/spinner";
import { artifactHref, repositoryHref } from "@/lib/browse";
import type { HasDependentsDetails } from "@/server/trpc/routers/versions";
import type { AppRouter } from "@/server/trpc/root";
import { useTRPC } from "@/trpc/client";

/** The `has_dependents` details of a failed delete, or `null` for any other error. */
function dependentsOf(error: unknown): HasDependentsDetails | null {
  if (!(error instanceof TRPCClientError)) return null;
  const registry = (error as TRPCClientError<AppRouter>).data?.registry;
  return registry?.code === "has_dependents" ? (registry.details as HasDependentsDetails) : null;
}

/**
 * "Delete version" button and confirmation dialog for maintainers and admins. When dependents
 * block the delete, the dialog lists them; admins can then force it by typing the coordinate.
 */
export function DeleteVersionDialog({
  repository,
  coordinate,
  buildCount,
  isAdmin,
  lastVersion,
}: {
  repository: string;
  coordinate: string;
  buildCount: number;
  isAdmin: boolean;
  /** The artifact has no other version: after the delete, go to the repository instead. */
  lastVersion: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState<HasDependentsDetails | null>(null);
  const [typed, setTyped] = useState("");
  const [group, name] = coordinate.split(":") as [string, string, string];

  const remove = useMutation(
    trpc.versions.delete.mutationOptions({
      onSuccess: async () => {
        setOpen(false);
        toast.success(`Deleted ${coordinate}`);
        await queryClient.invalidateQueries({ queryKey: trpc.browse.pathKey() });
        router.push(lastVersion ? repositoryHref(repository) : artifactHref(repository, group, name));
        router.refresh();
      },
      onError: (error) => {
        const details = dependentsOf(error);
        if (details) setBlocked(details);
        else toast.error(error.message || "Couldn't delete the version");
      },
    }),
  );

  function onOpenChange(next: boolean) {
    if (remove.isPending) return;
    setOpen(next);
    if (!next) {
      setBlocked(null);
      setTyped("");
      remove.reset();
    }
  }

  const confirmed = typed.trim() === coordinate;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
          <Trash2Icon />
          Delete version
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{blocked ? "Other versions depend on this one" : "Delete this version?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {blocked ? (
              <>
                Deleting <code className="text-foreground">{coordinate}</code> would break the builds of these dependents.
              </>
            ) : (
              <>
                <code className="text-foreground">{coordinate}</code> and its {buildCount === 1 ? "build" : `${buildCount} builds`} will be
                removed from <code className="text-foreground">{repository}</code>. This can&apos;t be undone.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {blocked && (
          <div className="flex flex-col gap-3">
            <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
              {blocked.dependents.map((d) => {
                const [g, n, v] = d.coordinate.split(":") as [string, string, string];
                return (
                  <li key={`${d.repository}/${d.coordinate}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <Link href={artifactHref(d.repository, g, n, v)} className="min-w-0 truncate font-mono text-[13px] text-link hover:underline">
                      {d.coordinate}
                    </Link>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{d.repository}</span>
                  </li>
                );
              })}
              {blocked.hiddenDependents > 0 && (
                <li className="px-3 py-1.5 text-xs text-muted-foreground">
                  + {blocked.hiddenDependents} in repositories you can&apos;t see
                </li>
              )}
            </ul>
            {isAdmin ? (
              <Field>
                <FieldLabel htmlFor="confirm-coordinate">
                  Type <code className="font-mono">{coordinate}</code> to delete it anyway
                </FieldLabel>
                <Input
                  id="confirm-coordinate"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
                <FieldDescription>The dependents keep their reference and fail to resolve until they are republished.</FieldDescription>
              </Field>
            ) : (
              <p className="flex items-start gap-2 rounded-md border border-snapshot/30 bg-snapshot-soft px-3 py-2 text-xs text-snapshot">
                <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
                Only an admin can delete a version that others depend on.
              </p>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          {blocked ? (
            isAdmin && (
              <Button
                variant="destructive"
                disabled={!confirmed || remove.isPending}
                onClick={() => remove.mutate({ repository, coordinate, force: true })}
              >
                {remove.isPending && <Spinner />}
                Delete anyway
              </Button>
            )
          ) : (
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ repository, coordinate })}>
              {remove.isPending && <Spinner />}
              Delete
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

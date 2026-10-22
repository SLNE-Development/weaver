"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import type { Role } from "@weaver/core";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@weaver/ui/components/alert-dialog";
import { Badge } from "@weaver/ui/components/badge";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Label } from "@weaver/ui/components/label";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Spinner } from "@weaver/ui/components/spinner";
import { Switch } from "@weaver/ui/components/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { PageBody, PageHeader } from "@/components/manage/page-header";
import { summarizePermissions } from "@/lib/api-keys";
import { formatDate, formatRelative } from "@/lib/format";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC, type RouterOutputs } from "@/trpc/client";
import { CreateKeyDialog } from "./create-key-dialog";

type ApiKey = RouterOutputs["keys"]["list"][number];

function Expiry({ date }: { date: Date | null }) {
  if (!date) return <span className="text-muted-foreground">never</span>;
  if (date.getTime() <= Date.now()) {
    return (
      <Badge variant="destructive" className="font-mono text-[11px]" title={formatDate(date)}>
        expired
      </Badge>
    );
  }
  return <span title={formatDate(date)}>{formatRelative(date)}</span>;
}

/** The API keys table with create and revoke; admins can switch to every user's keys. */
export function KeysManager({ role, openCreate }: { role: Role; openCreate: boolean }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const isAdmin = role === "admin";
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useState(openCreate);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const keys = useQuery(trpc.keys.list.queryOptions({ all }));

  useEffect(() => {
    // `?create=1` (from the command dialog) opens the dialog once; drop it from the URL.
    if (openCreate) {
      setCreating(true);
      router.replace("/keys");
    }
  }, [openCreate, router]);

  const revoke = useMutation(
    trpc.keys.revoke.mutationOptions({
      onSuccess: async () => {
        toast.success(`Key ${revoking?.name ?? ""} revoked`);
        setRevoking(null);
        await queryClient.invalidateQueries({ queryKey: trpc.keys.list.queryKey() });
      },
      onError: (error) => toast.error("Couldn't revoke the key", { description: errorMessage(error) }),
    }),
  );

  const createButton = (
    <Button size="sm" onClick={() => setCreating(true)}>
      <PlusIcon />
      Create key
    </Button>
  );

  return (
    <PageBody wide>
      <PageHeader
        title="API keys"
        description="Keys let the CLI, the Gradle plugin and CI publish and download on your behalf."
        actions={
          <>
            {isAdmin && (
              <div className="flex items-center gap-2 pr-2">
                <Switch id="all-keys" checked={all} onCheckedChange={setAll} size="sm" />
                <Label htmlFor="all-keys" className="text-sm font-normal text-muted-foreground">
                  All users
                </Label>
              </div>
            )}
            {createButton}
          </>
        }
      />

      {keys.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load the keys</AlertTitle>
          <AlertDescription>{errorMessage(keys.error)}</AlertDescription>
        </Alert>
      ) : keys.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : keys.data.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>No API keys</EmptyTitle>
            <EmptyDescription>Create a key for each machine or pipeline, so you can revoke one without affecting the rest.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{createButton}</EmptyContent>
        </Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Name</TableHead>
                {all && <TableHead>Owner</TableHead>}
                <TableHead>Permissions</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.map((key) => (
                <TableRow key={key.id} data-testid="api-key-row">
                  <TableCell className="pl-3">
                    <div className="font-medium">{key.name ?? "unnamed"}</div>
                    {key.start && <div className="font-mono text-xs text-muted-foreground">{key.start}…</div>}
                  </TableCell>
                  {all && <TableCell className="text-sm">{key.ownerName ?? "unknown user"}</TableCell>}
                  <TableCell className="whitespace-normal">
                    <div className="flex max-w-md flex-wrap gap-1">
                      {summarizePermissions(key.permissions).map(({ text, access }, i) => (
                        <Badge
                          key={`${i}:${text}`}
                          variant="outline"
                          className={`font-mono text-[11px] ${access === "write" ? "border-foreground/40" : "text-muted-foreground"}`}
                        >
                          {text}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    <Expiry date={key.expiresAt} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {key.lastUsedAt ? (
                      <span title={formatDate(key.lastUsedAt)}>{formatRelative(key.lastUsedAt)}</span>
                    ) : (
                      <span className="text-muted-foreground">never</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-3 text-right whitespace-nowrap">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/keys/${encodeURIComponent(key.id)}/activity`}>Activity</Link>
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRevoking(key)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateKeyDialog open={creating} onOpenChange={setCreating} role={role} />

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name ?? "this key"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything still using the key stops working immediately. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={revoke.isPending} onClick={() => revoking && revoke.mutate({ id: revoking.id })}>
              {revoke.isPending && <Spinner />}
              Revoke key
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageBody>
  );
}

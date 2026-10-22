"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlusIcon, ShieldAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@weaver/ui/components/badge";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { cn } from "@weaver/ui/lib/utils";
import { useTRPC, type RouterOutputs } from "@/trpc/client";
import { ConfirmDialog } from "../_components/confirm-dialog";
import { useDialogTarget } from "../_components/use-dialog-target";
import { formatDate, formatDateTime, formatRelative } from "../_components/format";
import { CreateInviteDialog } from "./create-invite-dialog";

type Invite = RouterOutputs["invites"]["list"][number];

const STATUS_STYLES: Record<Invite["status"], string> = {
  open: "border-release/40 bg-release-soft text-release",
  used: "border-border bg-secondary text-secondary-foreground",
  expired: "border-snapshot/40 bg-snapshot-soft text-snapshot",
};

function StatusBadge({ status }: { status: Invite["status"] }) {
  return (
    <Badge variant="outline" className={cn("font-mono", STATUS_STYLES[status])}>
      {status}
    </Badge>
  );
}

/** What happened to an invite, in one line: expiry for open ones, who used it, or when it lapsed. */
function Outcome({ invite }: { invite: Invite }) {
  if (invite.status === "used") {
    return (
      <span title={invite.usedAt ? formatDateTime(invite.usedAt) : undefined}>
        Used by <span className="font-medium">{invite.usedByName ?? "a removed user"}</span>
        {invite.usedAt && <span className="text-muted-foreground"> · {formatDate(invite.usedAt)}</span>}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground" title={formatDateTime(invite.expiresAt)}>
      {invite.status === "open" ? "Expires" : "Expired"} {formatRelative(invite.expiresAt)}
    </span>
  );
}

/**
 * The invites tab: a button to create one and the list of open, used and expired invites with
 * who created and who used each. Unused invites can be revoked.
 */
export function InvitesPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invites = useQuery(trpc.invites.list.queryOptions());
  const revokeDialog = useDialogTarget<Invite>();

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.invites.list.queryKey() });
  const revoke = useMutation(
    trpc.invites.revoke.mutationOptions({
      onSuccess: async () => {
        toast.success("Invite revoked");
        await refresh();
      },
      onError: (error) => toast.error("Couldn't revoke the invite", { description: error.message }),
    }),
  );

  let body;
  if (invites.isError) {
    body = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Couldn&apos;t load the invites</EmptyTitle>
          <EmptyDescription>{invites.error.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={() => void invites.refetch()}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else if (invites.isPending) {
    body = (
      <div className="flex flex-col gap-2 rounded-md border p-4">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  } else if (invites.data.length === 0) {
    body = (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MailPlusIcon />
          </EmptyMedia>
          <EmptyTitle>No invites yet</EmptyTitle>
          <EmptyDescription>New people join through a one-time invite link with the role you choose.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="pl-4">Status</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="hidden md:table-cell">Created</TableHead>
              <TableHead className="hidden sm:table-cell">Outcome</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.data.map((invite) => (
              <TableRow key={invite.id} className={cn(invite.status !== "open" && "text-muted-foreground")}>
                <TableCell className="pl-4">
                  <StatusBadge status={invite.status} />
                </TableCell>
                <TableCell className="font-mono text-xs">{invite.role}</TableCell>
                <TableCell className="max-w-28 truncate sm:max-w-64" title={invite.note ?? undefined}>
                  {invite.note ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="hidden md:table-cell" title={formatDateTime(invite.createdAt)}>
                  <span className="font-medium">{invite.createdByName ?? "Unknown"}</span>
                  <span className="text-muted-foreground"> · {formatDate(invite.createdAt)}</span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Outcome invite={invite} />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  {invite.status !== "used" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => revokeDialog.show(invite)}
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Invite links work once. Only a hash of each link is stored, so a link is shown only when it&apos;s created.
        </p>
        <CreateInviteDialog onCreated={refresh} />
      </div>
      {body}
      <ConfirmDialog
        open={revokeDialog.open}
        onOpenChange={revokeDialog.onOpenChange}
        title="Revoke this invite?"
        description={
          revokeDialog.target?.status === "expired"
            ? "The invite has already expired; revoking it removes it from the list."
            : "The link stops working immediately. Anyone who hasn't used it yet will need a new invite."
        }
        confirmLabel="Revoke invite"
        destructive
        onConfirm={() => revoke.mutateAsync({ id: revokeDialog.target!.id })}
      />
    </div>
  );
}

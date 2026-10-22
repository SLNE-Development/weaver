"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlertIcon, UsersIcon } from "lucide-react";
import { toast } from "sonner";
import type { Role } from "@weaver/core";
import { Avatar, AvatarFallback, AvatarImage } from "@weaver/ui/components/avatar";
import { Badge } from "@weaver/ui/components/badge";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@weaver/ui/components/tooltip";
import { ProviderIcon } from "@/components/provider-icon";
import { PROVIDER_NAMES, type ProviderId } from "@/lib/auth-client";
import { useTRPC, type RouterOutputs } from "@/trpc/client";
import { ConfirmDialog } from "../_components/confirm-dialog";
import { useDialogTarget } from "../_components/use-dialog-target";
import { formatDate, formatDateTime, initials } from "../_components/format";
import { BanDialog } from "./ban-dialog";
import { lastAdminId } from "./last-admin";

type UserSummary = RouterOutputs["users"]["list"][number];

const ROLES: Role[] = ["admin", "maintainer", "viewer"];

const LAST_ADMIN_REASON = "The last admin can't be demoted, banned or removed. Promote another user to admin first.";
const SELF_REASON = "You can't ban or remove your own account.";

function withArticle(role: Role): string {
  return role === "admin" ? "an admin" : `a ${role}`;
}

function isProvider(id: string): id is ProviderId {
  return id in PROVIDER_NAMES;
}

/** Connected sign-in providers as small marks with their names for screen readers and tooltips. */
function Providers({ providers }: { providers: string[] }) {
  if (providers.length === 0) return <span className="text-xs text-muted-foreground">None</span>;
  return (
    <span className="flex items-center gap-2">
      {providers.map((id) =>
        isProvider(id) ? (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <span className="inline-flex text-muted-foreground" aria-label={PROVIDER_NAMES[id]} role="img">
                <ProviderIcon provider={id} className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{PROVIDER_NAMES[id]}</TooltipContent>
          </Tooltip>
        ) : (
          <span key={id} className="font-mono text-xs text-muted-foreground">
            {id}
          </span>
        ),
      )}
    </span>
  );
}

function LoadingRows() {
  return Array.from({ length: 4 }, (_, i) => (
    <TableRow key={i}>
      <TableCell colSpan={6}>
        <Skeleton className="h-8 w-full" />
      </TableCell>
    </TableRow>
  ));
}

/**
 * Every user with their providers, role and ban state. Admins change roles inline (promoting to
 * admin and demoting yourself ask first) and ban, unban or remove users after a confirmation. The
 * last active admin is protected and nobody can ban or remove their own account; the reason is shown.
 */
export function UsersTable({ currentUserId }: { currentUserId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const users = useQuery(trpc.users.list.queryOptions());
  const banDialog = useDialogTarget<UserSummary>();
  const unbanDialog = useDialogTarget<UserSummary>();
  const removeDialog = useDialogTarget<UserSummary>();
  const roleDialog = useDialogTarget<{ user: UserSummary; role: Role }>();

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.users.list.queryKey() });
  const fail = (title: string) => (error: { message: string }) => toast.error(title, { description: error.message });

  const setRole = useMutation(
    trpc.users.setRole.mutationOptions({
      onSuccess: async (_, input) => {
        if (input.userId === currentUserId && input.role !== "admin") {
          toast.success(`You are now ${withArticle(input.role)}`);
          // Admin pages are gone for this user; a full load re-renders the shell with the new role.
          window.location.assign("/dashboard");
          return;
        }
        const name = users.data?.find((u) => u.id === input.userId)?.name ?? "The user";
        toast.success(`${name} is now ${withArticle(input.role)}`);
        await refresh();
      },
      onError: fail("Couldn't change the role"),
    }),
  );
  const unban = useMutation(
    trpc.users.unban.mutationOptions({
      onSuccess: async () => {
        toast.success("User unbanned");
        await refresh();
      },
      onError: fail("Couldn't unban the user"),
    }),
  );
  const remove = useMutation(
    trpc.users.remove.mutationOptions({
      onSuccess: async () => {
        toast.success("User removed");
        await refresh();
      },
      onError: fail("Couldn't remove the user"),
    }),
  );

  const protectedId = users.data ? lastAdminId(users.data) : null;

  /** Applies a role change at once, or asks first when it promotes to admin or demotes yourself. */
  function changeRole(user: UserSummary, role: Role) {
    if (role === user.role) return;
    const demotesSelf = user.id === currentUserId && user.role === "admin";
    if (role === "admin" || demotesSelf) roleDialog.show({ user, role });
    else setRole.mutate({ userId: user.id, role });
  }

  const pendingRole = roleDialog.target;
  const pendingSelfDemotion = pendingRole !== null && pendingRole.user.id === currentUserId;

  if (users.isError) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Couldn&apos;t load the users</EmptyTitle>
          <EmptyDescription>{users.error.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={() => void users.refetch()}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="pl-4">User</TableHead>
              <TableHead className="hidden md:table-cell">Sign-in</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="hidden sm:table-cell">Status</TableHead>
              <TableHead className="hidden lg:table-cell">Joined</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isPending ? (
              <LoadingRows />
            ) : users.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  <UsersIcon className="mx-auto mb-2 size-5" />
                  No users yet.
                </TableCell>
              </TableRow>
            ) : (
              users.data.map((u) => {
                const isLastAdmin = u.id === protectedId;
                const isSelf = u.id === currentUserId;
                const blockedReason = isLastAdmin ? LAST_ADMIN_REASON : isSelf ? SELF_REASON : undefined;
                return (
                  <TableRow key={u.id}>
                    <TableCell className="pl-4">
                      <div className="flex min-w-44 items-center gap-3">
                        <Avatar className="rounded-md">
                          {u.image && <AvatarImage src={u.image} alt="" />}
                          <AvatarFallback className="rounded-md text-xs">{initials(u.name)}</AvatarFallback>
                        </Avatar>
                        <div className="grid min-w-0 gap-0.5">
                          <span className="flex items-center gap-2 truncate font-medium">
                            {u.name}
                            {isSelf && (
                              <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
                                you
                              </Badge>
                            )}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                          {u.banned && <span className="text-xs font-medium text-destructive sm:hidden">banned</span>}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Providers providers={u.providers} />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={u.role}
                        disabled={isLastAdmin || setRole.isPending}
                        onValueChange={(role) => changeRole(u, role as Role)}
                      >
                        <SelectTrigger size="sm" aria-label="Role" className="w-32 font-mono text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((role) => (
                            <SelectItem key={role} value={role} className="font-mono text-xs">
                              {role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {u.banned ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
                                Banned
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              {u.banReason ? `Reason: ${u.banReason}. ` : ""}
                              {u.banExpires ? `Until ${formatDateTime(u.banExpires)}` : "Until unbanned"}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-xs text-muted-foreground">Active</span>
                        )}
                        {isLastAdmin && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="gap-1 text-muted-foreground" tabIndex={0}>
                                <ShieldAlertIcon />
                                Last admin
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-64">{LAST_ADMIN_REASON}</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell" title={formatDateTime(u.createdAt)}>
                      {formatDate(u.createdAt)}
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex justify-end gap-1">
                        {u.banned ? (
                          <Button variant="ghost" size="sm" onClick={() => unbanDialog.show(u)}>
                            Unban
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={blockedReason !== undefined}
                            title={blockedReason}
                            onClick={() => banDialog.show(u)}
                          >
                            Ban
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={blockedReason !== undefined}
                          title={blockedReason}
                          onClick={() => removeDialog.show(u)}
                        >
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {protectedId && (
        <p className="text-xs text-muted-foreground sm:hidden">
          <ShieldAlertIcon className="mr-1 inline size-3.5 align-[-2px]" />
          {LAST_ADMIN_REASON}
        </p>
      )}

      <BanDialog
        user={banDialog.target}
        open={banDialog.open}
        onOpenChange={banDialog.onOpenChange}
        onBanned={async () => {
          banDialog.onOpenChange(false);
          await refresh();
        }}
      />
      <ConfirmDialog
        open={unbanDialog.open}
        onOpenChange={unbanDialog.onOpenChange}
        title={`Unban ${unbanDialog.target?.name ?? "user"}?`}
        description="They can sign in again with their connected accounts, and their API keys work again."
        confirmLabel="Unban user"
        onConfirm={() => unban.mutateAsync({ userId: unbanDialog.target!.id })}
      />
      <ConfirmDialog
        open={removeDialog.open}
        onOpenChange={removeDialog.onOpenChange}
        title={`Remove ${removeDialog.target?.name ?? "user"}?`}
        description={
          <>
            This deletes <span className="font-medium text-foreground">{removeDialog.target?.email}</span> with their sessions,
            connected accounts and API keys. They need a new invite to come back. This can&apos;t be undone.
          </>
        }
        confirmLabel="Remove user"
        destructive
        onConfirm={() => remove.mutateAsync({ userId: removeDialog.target!.id })}
      />
      <ConfirmDialog
        open={roleDialog.open}
        onOpenChange={roleDialog.onOpenChange}
        title={
          pendingSelfDemotion
            ? `Make yourself ${pendingRole ? withArticle(pendingRole.role) : ""}?`
            : `Make ${pendingRole?.user.name ?? "this user"} an admin?`
        }
        description={
          pendingSelfDemotion
            ? "You'll lose admin access immediately: the users, settings and audit pages close for you, and only another admin can give the role back."
            : "Admins have full control of this Weaver, including users, settings, every repository and the audit log."
        }
        confirmLabel={pendingSelfDemotion ? "Give up admin access" : "Make admin"}
        destructive={pendingSelfDemotion}
        onConfirm={() => setRole.mutateAsync({ userId: pendingRole!.user.id, role: pendingRole!.role })}
      />
    </>
  );
}

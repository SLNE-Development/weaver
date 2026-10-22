"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, EyeIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@weaver/ui/components/alert-dialog";
import { Badge } from "@weaver/ui/components/badge";
import { Button } from "@weaver/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@weaver/ui/components/dialog";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Spinner } from "@weaver/ui/components/spinner";
import { Switch } from "@weaver/ui/components/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import type { Format } from "@weaver/core";
import { describePolicy, toPolicyInput, type PolicyFormValues } from "@/lib/cleanup-policies";
import { errorMessage, runNowErrorMessage } from "@/lib/trpc-error";
import { useTRPC, type RouterOutputs } from "@/trpc/client";
import { PolicyDialog } from "./policy-dialog";

type Policy = RouterOutputs["policies"]["list"][number];

const toFormValues = (p: Policy): PolicyFormValues => ({
  kind: p.kind,
  value: p.value,
  groupPrefix: p.groupPrefix ?? "",
  pattern: p.pattern ?? "",
  includeReleases: p.includeReleases,
  enabled: p.enabled,
});

/**
 * The cleanup policies of a hosted repository of `format`: table, add/edit/delete, enable toggle,
 * Preview and Run now. Only the format's kinds and options are offered.
 */
export function CleanupPolicies({ repository, format }: { repository: string; format: Format }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const policies = useQuery(trpc.policies.list.queryOptions({ repository }));
  const [editing, setEditing] = useState<{ policy: Policy | null } | null>(null);
  const [deleting, setDeleting] = useState<Policy | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [running, setRunning] = useState(false);
  // Stable while the dialog is open, so re-renders (e.g. a pending save) don't reset the form.
  const initial = useMemo(() => (editing?.policy ? toFormValues(editing.policy) : null), [editing]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.policies.list.queryKey({ repository }) }),
      queryClient.invalidateQueries({ queryKey: trpc.policies.preview.queryKey({ repository }) }),
      queryClient.invalidateQueries({ queryKey: trpc.repositories.get.queryKey({ name: repository }) }),
    ]);
  };

  const upsert = useMutation(
    trpc.policies.upsert.mutationOptions({
      onSuccess: refresh,
      onError: (error) => toast.error("Couldn't save the policy", { description: errorMessage(error) }),
    }),
  );
  const remove = useMutation(
    trpc.policies.delete.mutationOptions({
      onSuccess: async () => {
        toast.success("Policy deleted");
        setDeleting(null);
        await refresh();
      },
      onError: (error) => toast.error("Couldn't delete the policy", { description: errorMessage(error) }),
    }),
  );

  function toggle(policy: Policy, enabled: boolean) {
    upsert.mutate(toPolicyInput(format, repository, policy.id, { ...toFormValues(policy), enabled }), {
      onSuccess: () => toast.success(enabled ? "Policy enabled" : "Policy disabled"),
    });
  }

  const list = policies.data ?? [];
  const anyEnabled = list.some((p) => p.enabled);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)} disabled={!anyEnabled}>
          <EyeIcon />
          Preview
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirmRun(true)} disabled={!anyEnabled || running}>
          {running ? <Spinner /> : <PlayIcon />}
          Run now
        </Button>
        <Button size="sm" onClick={() => setEditing({ policy: null })}>
          <PlusIcon />
          Add policy
        </Button>
      </div>

      <RunStatus repository={repository} confirm={confirmRun} onConfirmChange={setConfirmRun} onRunningChange={setRunning} />

      {policies.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load the policies</AlertTitle>
          <AlertDescription>{errorMessage(policies.error)}</AlertDescription>
        </Alert>
      ) : policies.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : list.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No cleanup policies. Everything published here is kept until someone deletes it.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Rule</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((policy) => (
                <TableRow key={policy.id} data-state={policy.enabled ? undefined : "disabled"} className="data-[state=disabled]:text-muted-foreground">
                  <TableCell className="pl-3 whitespace-normal">
                    <span className="flex flex-wrap items-center gap-2">
                      {describePolicy(format, policy)}
                      {policy.includeReleases && (
                        <Badge variant="outline" className="border-destructive/40 font-mono text-[11px] text-destructive">
                          incl. releases
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {policy.groupPrefix ? (
                      format === "proto" ? `${policy.groupPrefix}.*` : `${policy.groupPrefix}*`
                    ) : (
                      <span className="text-muted-foreground">everything</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={policy.enabled}
                      onCheckedChange={(enabled) => toggle(policy, enabled)}
                      disabled={upsert.isPending}
                      aria-label={policy.enabled ? "Disable policy" : "Enable policy"}
                    />
                  </TableCell>
                  <TableCell className="pr-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label="Edit policy" onClick={() => setEditing({ policy })}>
                        <PencilIcon />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Delete policy" onClick={() => setDeleting(policy)}>
                        <Trash2Icon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <PolicyDialog
        format={format}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        initial={initial}
        submitting={upsert.isPending}
        onSubmit={async (values) => {
          await upsert.mutateAsync(toPolicyInput(format, repository, editing?.policy?.id, values));
          toast.success(editing?.policy ? "Policy saved" : "Policy added");
        }}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this policy?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? describePolicy(format, deleting) : ""}. Deleting the policy deletes no artifacts; it just stops running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate({ id: deleting.id })}>
              {remove.isPending && <Spinner />}
              Delete policy
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PreviewDialog repository={repository} open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  );
}

/** What the enabled policies would delete right now, fetched fresh each time the dialog opens. */
function PreviewDialog({ repository, open, onOpenChange }: { repository: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const trpc = useTRPC();
  const preview = useQuery({ ...trpc.policies.preview.queryOptions({ repository }), enabled: open, staleTime: 0, gcTime: 0 });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Cleanup preview</DialogTitle>
          <DialogDescription>
            What a run would delete right now, from the enabled policies. Nothing is deleted by previewing.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {preview.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn't compute the preview</AlertTitle>
              <AlertDescription>{errorMessage(preview.error)}</AlertDescription>
            </Alert>
          ) : preview.isPending ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner /> Computing…
            </div>
          ) : preview.data.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground" data-testid="preview-empty">
              Nothing to clean up right now.
            </p>
          ) : (
            <>
              <p className="mb-2 text-sm" data-testid="preview-count">
                {preview.data.length} {preview.data.length === 1 ? "item" : "items"} would be deleted.
              </p>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-3">Deletes</TableHead>
                      <TableHead className="pr-3">Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.data.map((item) => (
                      <TableRow key={item.key}>
                        <TableCell className="pl-3 font-mono text-xs">{item.label}</TableCell>
                        <TableCell className="pr-3 text-xs text-muted-foreground">{item.reason}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const FINISHED = new Set(["completed", "failed", "unknown"]);

/** "Run now": the confirmation, then the queued job's progress and result (polled every second). */
function RunStatus({
  repository,
  confirm,
  onConfirmChange,
  onRunningChange,
}: {
  repository: string;
  confirm: boolean;
  onConfirmChange: (open: boolean) => void;
  /** Whether a run is being queued or its job is still in progress (Run now stays disabled meanwhile). */
  onRunningChange: (running: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const run = useMutation(
    trpc.policies.runNow.mutationOptions({
      onMutate: () => {
        setStartError(null);
        setJobId(null);
      },
      onSuccess: ({ jobId: id }) => setJobId(id),
      onError: (error) => {
        // Shown inline (and kept) instead of a toast, so the reason stays readable.
        setStartError(runNowErrorMessage(error));
      },
    }),
  );

  const job = useQuery({
    ...trpc.policies.job.queryOptions({ jobId: jobId ?? "" }),
    enabled: jobId !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.status === "error" || (query.state.data && FINISHED.has(query.state.data.state)) ? false : 1000,
  });

  const state = job.data?.state;
  useEffect(() => {
    if (state === "completed") {
      void queryClient.invalidateQueries({ queryKey: trpc.repositories.get.queryKey({ name: repository }) });
      void queryClient.invalidateQueries({ queryKey: trpc.policies.preview.queryKey({ repository }) });
    }
  }, [state, queryClient, trpc, repository]);

  const dismiss = () => {
    setJobId(null);
    setStartError(null);
  };

  let status: React.ReactNode = null;
  if (startError) {
    status = (
      <Alert variant="destructive" data-testid="run-status">
        <CircleXIcon />
        <AlertTitle>Cleanup could not start</AlertTitle>
        <AlertDescription>{startError}</AlertDescription>
      </Alert>
    );
  } else if (jobId && job.isError) {
    status = (
      <Alert variant="destructive" data-testid="run-status">
        <CircleXIcon />
        <AlertTitle>Lost track of the cleanup job</AlertTitle>
        <AlertDescription>{runNowErrorMessage(job.error)}</AlertDescription>
      </Alert>
    );
  } else if (jobId && state === "completed") {
    const deleted = job.data?.result?.deleted ?? 0;
    status = (
      <Alert data-testid="run-status">
        <CircleCheckIcon className="text-release" />
        <AlertTitle>Cleanup finished</AlertTitle>
        <AlertDescription>
          {deleted === 0 ? "Nothing needed deleting." : `${deleted} ${deleted === 1 ? "item was" : "items were"} deleted.`}
        </AlertDescription>
      </Alert>
    );
  } else if (jobId && state === "failed") {
    status = (
      <Alert variant="destructive" data-testid="run-status">
        <CircleXIcon />
        <AlertTitle>Cleanup failed</AlertTitle>
        <AlertDescription>{job.data?.failedReason ?? "The job failed without a reason."} It is retried automatically.</AlertDescription>
      </Alert>
    );
  } else if (jobId && state === "unknown") {
    status = (
      <Alert data-testid="run-status">
        <AlertTitle>Job not found</AlertTitle>
        <AlertDescription>The job finished long ago or was removed from the queue.</AlertDescription>
      </Alert>
    );
  } else if (run.isPending || jobId) {
    status = (
      <Alert data-testid="run-status">
        <Spinner />
        <AlertTitle>Cleanup running</AlertTitle>
        <AlertDescription>
          {run.isPending ? "Queuing the job…" : `Job ${jobId} is ${state ?? "queued"}. This page updates when it is done.`}
        </AlertDescription>
      </Alert>
    );
  }

  const finished = startError !== null || (jobId !== null && (job.isError || (state !== undefined && FINISHED.has(state))));
  const running = run.isPending || (jobId !== null && !finished);
  useEffect(() => onRunningChange(running), [running, onRunningChange]);

  return (
    <>
      {status && (
        <div className="relative">
          {status}
          {finished && (
            <Button variant="ghost" size="icon-xs" className="absolute top-2 right-2" aria-label="Dismiss" onClick={dismiss}>
              <XIcon />
            </Button>
          )}
        </div>
      )}
      <AlertDialog open={confirm} onOpenChange={onConfirmChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run cleanup now?</AlertDialogTitle>
            <AlertDialogDescription>
              The enabled policies of <span className="font-mono text-foreground">{repository}</span> run right away and permanently
              delete what they match. Use Preview first if you're unsure.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => run.mutate({ repository })}>
              Run cleanup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

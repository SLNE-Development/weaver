"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, Trash2Icon } from "lucide-react";
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
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Button } from "@weaver/ui/components/button";
import { Input } from "@weaver/ui/components/input";
import { Label } from "@weaver/ui/components/label";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Spinner } from "@weaver/ui/components/spinner";
import { PageBody, PageHeader } from "@/components/manage/page-header";
import { VisibilityBadge } from "@/components/manage/visibility-badge";
import { formatBytes } from "@/lib/browse";
import { deleteBlocked, formatLabel, toGeneralPatch } from "@/lib/repository-settings";
import { errorCode, errorMessage } from "@/lib/trpc-error";
import { useTRPC, type RouterInputs, type RouterOutputs } from "@/trpc/client";
import { FormatBadge, KindLabel } from "../../_components/format-badge";
import { HostedSettings } from "../../_components/hosted-settings";
import { MembersEditor } from "../../_components/members-editor";
import { MirrorSettings } from "../../_components/mirror-settings";
import { GeneralSettingsForm } from "../../repository-form";
import { CleanupPolicies } from "./cleanup-policies";

type Repository = RouterOutputs["repositories"]["get"];

/** What the cleanup policies of a hosted repository delete, per format. */
const CLEANUP_DESCRIPTIONS: Record<Repository["format"], string> = {
  proto: "Rules that delete old builds and versions.",
  maven: "Rules that delete old snapshot builds and versions.",
  npm: "Rules that delete old package versions.",
  docker: "Rules that delete old tags and untagged manifests.",
};
type Patch = RouterInputs["repositories"]["update"]["patch"];

/** A titled settings section; its heading names the region for assistive technology and tests. */
function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** One-line summary under the title: stored files and size, and the cleanup policies of a hosted repository. */
function summary(repo: Repository): string {
  const parts = [`${repo.assetCount} ${repo.assetCount === 1 ? "file" : "files"}`, formatBytes(repo.storageBytes)];
  if (repo.kind === "hosted") parts.push(`${repo.policyCount} cleanup policies`);
  return parts.join(" · ");
}

/**
 * The settings of one repository. Only what applies to its format and kind is shown: general
 * settings for all, then the hosted options and cleanup policies of its format, the mirror
 * settings (whose cache eviction replaces cleanup), or the group members, and finally deletion.
 */
export function RepositorySettings({ name }: { name: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const repo = useQuery(trpc.repositories.get.queryOptions({ name }));

  const update = useMutation(
    trpc.repositories.update.mutationOptions({
      onSuccess: (updated) => {
        queryClient.setQueryData(trpc.repositories.get.queryKey({ name }), (old) => (old ? { ...old, ...updated } : old));
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.repositories.list.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.repositories.upstreams.queryKey({ name }) }),
          queryClient.invalidateQueries({ queryKey: trpc.repositories.members.queryKey({ name }) }),
        ]);
        toast.success("Settings saved");
      },
      onError: (error) => toast.error("Couldn't save the settings", { description: errorMessage(error) }),
    }),
  );
  const save = (patch: Patch) => update.mutateAsync({ name, patch });

  const header = (
    <PageHeader
      back={{ href: "/repositories", label: "Repositories" }}
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{name}</span>
          {repo.data && (
            <>
              <FormatBadge format={repo.data.format} />
              <KindLabel kind={repo.data.kind} />
              <VisibilityBadge visibility={repo.data.visibility} />
            </>
          )}
        </span>
      }
      description={repo.data ? summary(repo.data) : undefined}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/browse/${name}`}>
            <ExternalLinkIcon />
            Browse
          </Link>
        </Button>
      }
    />
  );

  if (repo.isError) {
    return (
      <PageBody>
        {header}
        <Alert variant="destructive">
          <AlertTitle>{errorCode(repo.error) === "NOT_FOUND" ? "Repository not found" : "Couldn't load the repository"}</AlertTitle>
          <AlertDescription>{errorMessage(repo.error)}</AlertDescription>
        </Alert>
      </PageBody>
    );
  }
  if (repo.isPending) {
    return (
      <PageBody>
        {header}
        <Skeleton className="h-96 w-full" />
      </PageBody>
    );
  }

  const data = repo.data;
  const format = formatLabel(data.format);
  return (
    <PageBody>
      {header}
      <Section title="General" description="What this repository is for and who can see it.">
        <GeneralSettingsForm
          values={{ description: data.description ?? "", visibility: data.visibility }}
          submitting={update.isPending}
          onSubmit={(values) => save(toGeneralPatch(values))}
        />
      </Section>

      {data.kind === "hosted" && (
        <Section title={`${format} options`} description="What publishing to this repository may do.">
          <HostedSettings repo={data} submitting={update.isPending} onSave={(config) => save({ config: { ...config } })} />
        </Section>
      )}

      {data.kind === "hosted" && (
        <Section
          title="Cleanup policies"
          description={`${CLEANUP_DESCRIPTIONS[data.format]} They run every night at 03:00 server time; preview them first.`}
        >
          <CleanupPolicies repository={name} format={data.format} />
        </Section>
      )}

      {data.kind === "mirror" && (
        <Section title="Mirror" description={`Where this mirror gets ${format} content from, and what it keeps.`}>
          <MirrorSettings repo={data} submitting={update.isPending} onSave={save} />
          <p className="text-sm text-muted-foreground">Mirror caches are cleaned up by the eviction settings above.</p>
        </Section>
      )}

      {data.kind === "group" && (
        <Section title="Members" description="Searched in order; the first member that has an item serves it. Groups are read-only.">
          <MembersEditor repo={data} submitting={update.isPending} onSave={(members) => save({ members })} />
        </Section>
      )}

      <DangerZone repo={data} />
    </PageBody>
  );
}

/** Deleting the repository after typing its name; a proto hosted repository only while it holds no artifacts. */
function DangerZone({ repo }: { repo: Repository }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const remove = useMutation(
    trpc.repositories.delete.mutationOptions({
      onSuccess: async () => {
        toast.success(`Repository ${repo.name} deleted`);
        await queryClient.invalidateQueries({ queryKey: trpc.repositories.list.queryKey() });
        router.push("/repositories");
      },
      onError: (error) => toast.error("Couldn't delete the repository", { description: errorMessage(error) }),
    }),
  );
  // The same rule as the server's delete guard.
  const blocked = deleteBlocked(repo, repo.artifactCount);
  const explanation = blocked
    ? `It still holds ${repo.artifactCount} artifacts. Delete them first.`
    : repo.kind === "group"
      ? "Removes the group and API key permissions on it. Its members are not touched."
      : repo.assetCount > 0
        ? `Removes the repository with its ${repo.assetCount} stored files (${formatBytes(repo.storageBytes)}) and API key permissions on it.`
        : "Removes the repository and API key permissions on it.";

  return (
    <Section title="Danger zone" description="Irreversible actions.">
      <div className="flex flex-col gap-3 rounded-md border border-destructive/40 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid gap-1">
          <span className="text-sm font-medium">Delete this repository</span>
          <span className="text-xs text-muted-foreground">{explanation}</span>
        </div>
        <AlertDialog onOpenChange={(open) => !open && setConfirm("")}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={blocked}>
              <Trash2Icon />
              Delete repository
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {repo.name}?</AlertDialogTitle>
              <AlertDialogDescription>This can&apos;t be undone. Type the repository name to confirm.</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="confirm-repo-name" className="sr-only">
                Repository name
              </Label>
              <Input
                id="confirm-repo-name"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder={repo.name}
                autoComplete="off"
                className="font-mono"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={confirm !== repo.name || remove.isPending}
                onClick={() => remove.mutate({ name: repo.name })}
              >
                {remove.isPending && <Spinner />}
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Section>
  );
}

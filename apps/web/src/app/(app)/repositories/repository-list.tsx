"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { DatabaseIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { PageBody, PageHeader } from "@/components/manage/page-header";
import { VisibilityBadge } from "@/components/manage/visibility-badge";
import { formatBytes } from "@/lib/browse";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC } from "@/trpc/client";
import { FormatBadge, KindLabel } from "./_components/format-badge";
import { CreateRepositoryDialog } from "./create-repository-dialog";

/**
 * Repository table with format and kind. Admins see stored files and size (`repositories.list`),
 * settings links and "New repository"; others a read-only list (`browse.repositories`).
 * `openCreate` (from `?create=1`) opens the create dialog once.
 */
export function RepositoryList({ isAdmin, openCreate = false }: { isAdmin: boolean; openCreate?: boolean }) {
  const trpc = useTRPC();
  const router = useRouter();
  const admin = useQuery({ ...trpc.repositories.list.queryOptions(), enabled: isAdmin });
  const browse = useQuery({ ...trpc.browse.repositories.queryOptions(), enabled: !isAdmin });
  const query = isAdmin ? admin : browse;
  const [creating, setCreating] = useState(isAdmin && openCreate);

  useEffect(() => {
    if (isAdmin && openCreate) {
      setCreating(true);
      router.replace("/repositories");
    }
  }, [isAdmin, openCreate, router]);

  const newButton = isAdmin && (
    <Button size="sm" onClick={() => setCreating(true)}>
      <PlusIcon />
      New repository
    </Button>
  );

  return (
    <PageBody wide>
      <PageHeader
        title="Repositories"
        description={
          isAdmin
            ? "Hosted repositories take publishes, mirrors proxy upstream registries, groups serve several as one."
            : "Where artifacts live. Only admins can change repository settings."
        }
        actions={newButton}
      />

      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load repositories</AlertTitle>
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
        </Alert>
      ) : query.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : query.data.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DatabaseIcon />
            </EmptyMedia>
            <EmptyTitle>No repositories yet</EmptyTitle>
            <EmptyDescription>
              {isAdmin
                ? "Create a hosted repository to publish to, or a mirror of a public registry."
                : "An admin needs to create a repository before anything can be published."}
            </EmptyDescription>
          </EmptyHeader>
          {newButton && <EmptyContent>{newButton}</EmptyContent>}
        </Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Name</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Visibility</TableHead>
                {isAdmin && <TableHead className="text-right">Files</TableHead>}
                {isAdmin && <TableHead className="text-right">Size</TableHead>}
                {isAdmin && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(isAdmin ? admin.data : browse.data)?.map((repo) => {
                const href = isAdmin ? `/repositories/${repo.name}/settings` : `/browse/${repo.name}`;
                const stored = "assetCount" in repo ? repo : undefined;
                return (
                  <TableRow key={repo.name} data-testid={`repository-${repo.name}`}>
                    <TableCell className="max-w-80 pl-3">
                      <Link href={href} className="font-mono font-medium hover:underline">
                        {repo.name}
                      </Link>
                      {repo.description && <p className="truncate text-xs text-muted-foreground">{repo.description}</p>}
                    </TableCell>
                    <TableCell>
                      <FormatBadge format={repo.format} />
                    </TableCell>
                    <TableCell>
                      <KindLabel kind={repo.kind} />
                    </TableCell>
                    <TableCell>
                      <VisibilityBadge visibility={repo.visibility} />
                    </TableCell>
                    {stored && (
                      <>
                        <TableCell className="text-right font-mono tabular-nums">{stored.assetCount}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(stored.storageBytes)}</TableCell>
                        <TableCell className="pr-3 text-right">
                          <Button asChild variant="ghost" size="icon-sm" aria-label={`Settings of ${repo.name}`}>
                            <Link href={href}>
                              <SettingsIcon />
                            </Link>
                          </Button>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {isAdmin && <CreateRepositoryDialog open={creating} onOpenChange={setCreating} />}
    </PageBody>
  );
}

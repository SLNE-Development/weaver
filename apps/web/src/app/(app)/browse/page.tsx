import type { Metadata } from "next";
import Link from "next/link";
import { BoxesIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { PageContainer, PageHeader, Panel, RelativeTime, VisibilityBadge } from "@/components/browse-ui";
import { repositoryHref } from "@/lib/browse";
import { requirePageAccess } from "@/server/session";
import { api } from "@/trpc/server";
import { FormatBadge } from "../repositories/_components/format-badge";

export const metadata: Metadata = { title: "Browse" };

/** Every repository the visitor may browse, with its format and (proto) artifact and version counts. */
export default async function BrowsePage() {
  await requirePageAccess("/browse");
  const repositories = await api.browse.repositories();

  return (
    <PageContainer>
      <PageHeader
        crumbs={[{ label: "Browse" }]}
        title="Repositories"
        meta={<span>Pick a repository to see its artifacts. Press Ctrl K to search artifacts everywhere.</span>}
      />
      {repositories.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>No repositories to browse</EmptyTitle>
            <EmptyDescription>There is nothing here you can read yet.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Repository</TableHead>
                <TableHead className="hidden md:table-cell">Description</TableHead>
                <TableHead className="text-right">Artifacts</TableHead>
                <TableHead className="text-right">Versions</TableHead>
                <TableHead className="hidden pr-4 text-right sm:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repositories.map((repo) => (
                <TableRow key={repo.name}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-2">
                      <Link href={repositoryHref(repo.name)} className="font-mono text-[13px] font-medium hover:underline">
                        {repo.name}
                      </Link>
                      <FormatBadge format={repo.format} />
                      <VisibilityBadge visibility={repo.visibility} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-80 truncate text-muted-foreground md:table-cell">{repo.description ?? "—"}</TableCell>
                  {/* Artifact and version counts exist for proto repositories only. */}
                  <TableCell className="text-right font-mono tabular-nums">{repo.format === "proto" ? repo.artifactCount : "—"}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{repo.format === "proto" ? repo.versionCount : "—"}</TableCell>
                  <TableCell className="hidden pr-4 text-right text-xs text-muted-foreground sm:table-cell">
                    <RelativeTime date={repo.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </PageContainer>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { HistoryIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { KindBadge, PageContainer, PageHeader, Panel, RelativeTime, SectionTitle } from "@/components/browse-ui";
import { UsageSnippet } from "@/components/usage-snippet";
import { artifactHref, listingMetadataInput, repositoryHref } from "@/lib/browse";
import { pageMetadata } from "@/lib/seo";
import { visibleRepository } from "@/server/browse-metadata";
import { orNotFound } from "@/server/page-data";
import { requirePageAccess } from "@/server/session";
import { api } from "@/trpc/server";

type Params = { repo: string; group: string; name: string };

/** Canonical URL and description; artifacts in private repositories are kept out of search engines. */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { repo, group, name } = await params;
  const info = await visibleRepository(repo);
  return pageMetadata(listingMetadataInput({ repository: repo, group, name, visibility: info?.visibility ?? null }));
}

/** One artifact: its versions (newest first) and how to use the newest release. */
export default async function ArtifactPage({ params }: { params: Promise<Params> }) {
  const { repo, group, name } = await params;
  await requirePageAccess(artifactHref(repo, group, name));
  const versions = await orNotFound(api.browse.versions({ repository: repo, group, name }), artifactHref(repo, group, name));
  const latest = versions[0];
  const latestRelease = versions.find((v) => !v.isSnapshot);
  const usageVersion = latestRelease ?? latest;
  const releases = versions.filter((v) => !v.isSnapshot).length;

  return (
    <PageContainer>
      <PageHeader
        crumbs={[
          { label: "Browse", href: "/browse" },
          { label: repo, href: repositoryHref(repo), mono: true },
          { label: `${group}:${name}`, mono: true },
        ]}
        title={
          <span className="font-mono">
            <span className="text-muted-foreground">{group}:</span>
            {name}
          </span>
        }
        meta={
          <span className="font-mono">
            {versions.length} {versions.length === 1 ? "version" : "versions"} · {releases} releases · {versions.length - releases} snapshots
          </span>
        }
      />

      {!latest ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HistoryIcon />
            </EmptyMedia>
            <EmptyTitle>No versions</EmptyTitle>
            <EmptyDescription>Every version of this artifact has been deleted.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section className="flex min-w-0 flex-col gap-2">
            <SectionTitle count={versions.length}>Versions</SectionTitle>
            <Panel>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Version</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead className="text-right">Builds</TableHead>
                    <TableHead className="pr-4 text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.version}>
                      <TableCell className="pl-4">
                        <Link href={artifactHref(repo, group, name, v.version)} className="font-mono text-[13px] font-medium hover:underline">
                          {v.version}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <KindBadge version={v.version} />
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{v.latestBuild}</TableCell>
                      <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                        <RelativeTime date={v.updatedAt} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </section>
          {usageVersion && (
            <section className="flex min-w-0 flex-col gap-2">
              <SectionTitle>
                Use {latestRelease ? "the latest release" : "the latest snapshot"}
                <span className="font-mono normal-case tracking-normal text-foreground">{usageVersion.version}</span>
              </SectionTitle>
              <UsageSnippet
                stacked
                repository={repo}
                coordinate={`${group}:${name}:${usageVersion.version}`}
              />
            </section>
          )}
        </div>
      )}
    </PageContainer>
  );
}

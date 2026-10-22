import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3Icon, BoxesIcon } from "lucide-react";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { BROWSE_VIEWS } from "@/components/browse/registry";
import { PageContainer, PageHeader, VisibilityBadge } from "@/components/browse-ui";
import { listingMetadataInput, repositoryHref } from "@/lib/browse";
import { formatLabel } from "@/lib/repository-settings";
import { pageMetadata } from "@/lib/seo";
import { visibleRepository } from "@/server/browse-metadata";
import { orNotFound } from "@/server/page-data";
import { requirePageAccess } from "@/server/session";
import { api } from "@/trpc/server";
import { FormatBadge, KindLabel } from "../../repositories/_components/format-badge";

type Params = { repo: string };

/** Canonical URL and description; private repositories are kept out of search engines. */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { repo } = await params;
  const info = await visibleRepository(repo);
  return pageMetadata(listingMetadataInput({ repository: repo, visibility: info?.visibility ?? null, description: info?.description }));
}

/** One repository: a common header, then the browse view of its format (`BROWSE_VIEWS`), or "not available yet". */
export default async function RepositoryPage({ params }: { params: Promise<Params> }) {
  const { repo: name } = await params;
  await requirePageAccess(repositoryHref(name));
  const repo = await orNotFound(api.browse.repository({ name }), repositoryHref(name));
  const View = BROWSE_VIEWS[repo.format];

  return (
    <PageContainer>
      <PageHeader
        crumbs={[{ label: "Browse", href: "/browse" }, { label: repo.name, mono: true }]}
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{repo.name}</span>
            <FormatBadge format={repo.format} />
            <KindLabel kind={repo.kind} />
            <VisibilityBadge visibility={repo.visibility} />
          </span>
        }
        meta={repo.description ? <span className="text-sm">{repo.description}</span> : undefined}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`${repositoryHref(repo.name)}/stats`}>
              <BarChart3Icon />
              Stats
            </Link>
          </Button>
        }
      />
      {View ? (
        <View repo={repo} />
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>Browsing {formatLabel(repo.format)} repositories is not available yet</EmptyTitle>
            <EmptyDescription>The repository works for clients; only this page is missing.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </PageContainer>
  );
}

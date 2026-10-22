import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageContainer, PageHeader } from "@/components/browse-ui";
import { NpmPackageView } from "@/components/browse/npm/npm-package-view";
import { listingMetadataInput, repositoryHref } from "@/lib/browse";
import { npmPackageHref } from "@/lib/npm-config";
import { pageMetadata } from "@/lib/seo";
import { visibleRepository } from "@/server/browse-metadata";
import { orNotFound } from "@/server/page-data";
import { requirePageAccess } from "@/server/session";
import { api } from "@/trpc/server";

type Params = { repo: string; name: string[] };

/** The package name of the catch-all segments, e.g. `["%40acme", "ui"]` is `@acme/ui`. */
function packageName(segments: string[]): string {
  try {
    return segments.map(decodeURIComponent).join("/");
  } catch {
    return notFound();
  }
}

/** Canonical URL and description; packages in private repositories are kept out of search engines. */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { repo, name } = await params;
  const info = await visibleRepository(repo);
  const base = listingMetadataInput({ repository: repo, visibility: info?.visibility ?? null });
  return pageMetadata({ ...base, title: packageName(name), path: npmPackageHref(repo, packageName(name)) });
}

/** One npm package of a repository: README, dist-tags, versions and the install command. */
export default async function NpmPackagePage({ params }: { params: Promise<Params> }) {
  const { repo, name: segments } = await params;
  const name = packageName(segments);
  const path = npmPackageHref(repo, name);
  await requirePageAccess(path);
  const pkg = await orNotFound(api.npm.package({ repo, name }), path);
  if (!pkg) notFound();
  return (
    <PageContainer>
      <PageHeader
        crumbs={[{ label: "Browse", href: "/browse" }, { label: repo, href: repositoryHref(repo), mono: true }, { label: name, mono: true }]}
        title={<span className="font-mono">{name}</span>}
      />
      <NpmPackageView pkg={pkg} />
    </PageContainer>
  );
}

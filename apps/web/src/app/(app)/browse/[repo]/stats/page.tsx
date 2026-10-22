import type { Metadata } from "next";
import { PageContainer, PageHeader } from "@/components/browse-ui";
import { DownloadsChart } from "@/components/stats/downloads-chart";
import { RangeSelect } from "@/components/stats/range-select";
import { measuredLabel } from "@/components/stats/storage-table";
import { TopPackages } from "@/components/stats/top-packages";
import { formatBytes, repositoryHref } from "@/lib/browse";
import { formatPercent, parseDays } from "@/lib/stats";
import { orNotFound } from "@/server/page-data";
import { requirePageAccess } from "@/server/session";
import { api } from "@/trpc/server";

type Params = { repo: string };

export const metadata: Metadata = { title: "Repository stats", robots: { index: false } };

/** One labelled figure of the storage summary. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** The usage of one repository the caller may read: downloads over time, top packages, storage and, for mirrors, the cache hit rate. */
export default async function RepositoryStatsPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ repo: name }, query] = await Promise.all([params, searchParams]);
  const path = `${repositoryHref(name)}/stats`;
  await requirePageAccess(path);
  const days = parseDays(query.days);
  const [repo, stats] = await Promise.all([
    orNotFound(api.browse.repository({ name }), path),
    orNotFound(api.stats.repository({ repository: name, days }), path),
  ]);
  // A mirror with caching off stores nothing, so there is neither storage nor a hit rate to show.
  const cachingOff = repo.kind === "mirror" && repo.cacheEnabled !== true;

  return (
    <PageContainer>
      <PageHeader
        crumbs={[{ label: "Browse", href: "/browse" }, { label: repo.name, href: repositoryHref(repo.name), mono: true }, { label: "Stats" }]}
        title="Stats"
        actions={<RangeSelect days={days} />}
      />
      <DownloadsChart series={stats.series} />
      {cachingOff ? (
        <p className="text-sm text-muted-foreground">Caching is off; nothing is stored for this mirror.</p>
      ) : (
        <section className="flex flex-col gap-2" aria-labelledby="storage-heading">
          <div className="flex items-baseline justify-between gap-2">
            <h2 id="storage-heading" className="text-sm font-medium">
              Storage
            </h2>
            <span className="text-xs text-muted-foreground">{measuredLabel(stats.storage?.takenAt ?? null)}</span>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {repo.kind !== "mirror" && <Figure label="Hosted" value={formatBytes(stats.storage?.hostedBytes ?? 0)} />}
            {repo.kind !== "hosted" && <Figure label="Cache" value={formatBytes(stats.storage?.cacheBytes ?? 0)} />}
            <Figure label="Assets" value={(stats.storage?.assetCount ?? 0).toLocaleString("en")} />
            {stats.hitRate !== null && <Figure label="Hit rate" value={formatPercent(stats.hitRate)} />}
          </dl>
        </section>
      )}
      <TopPackages rows={stats.topPackages} showRepository={repo.kind === "group"} />
    </PageContainer>
  );
}

import type { Metadata } from "next";
import { DownloadsChart } from "@/components/stats/downloads-chart";
import { HitRateTable } from "@/components/stats/hit-rate-table";
import { RangeSelect } from "@/components/stats/range-select";
import { StorageTable } from "@/components/stats/storage-table";
import { TokenTable } from "@/components/stats/token-table";
import { TopPackages } from "@/components/stats/top-packages";
import { parseDays } from "@/lib/stats";
import { orNotFound } from "@/server/page-data";
import { api } from "@/trpc/server";
import { AdminPage } from "../_components/admin-page";

export const metadata: Metadata = { title: "Usage" };

/** Usage across all repositories: downloads over time, top packages, storage, mirror hit rates and the busiest API keys. Admins only: the app shell redirects other users to the dashboard, and the data call refuses them. */
export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const days = parseDays(params.days);
  const overview = await orNotFound(api.stats.overview({ days }), "/admin/stats");
  return (
    <AdminPage title="Usage" description="Downloads, storage and cache efficiency across all repositories." actions={<RangeSelect days={days} />}>
      <DownloadsChart series={overview.series} />
      <TopPackages rows={overview.topPackages} />
      <StorageTable rows={overview.storage} />
      <HitRateTable rows={overview.hitRates} />
      <TokenTable rows={overview.tokens} days={days} />
    </AdminPage>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@weaver/ui/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { DownloadsChart } from "@/components/stats/downloads-chart";
import { RangeSelect } from "@/components/stats/range-select";
import { PageBody, PageHeader } from "@/components/manage/page-header";
import { formatBytes } from "@/lib/browse";
import { parseDays } from "@/lib/stats";
import { orNotFound } from "@/server/page-data";
import { requireRole } from "@/server/session";
import { api } from "@/trpc/server";

export const metadata: Metadata = { title: "Key activity" };

/** Events listed per page. */
const PAGE_SIZE = 50;

/** What one API key did: downloads per day and its raw events, newest first. Only the owner and admins see it. */
export default async function KeyActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const path = `/keys/${encodeURIComponent(id)}/activity`;
  await requireRole("viewer", path);
  const days = parseDays(query.days);
  const beforeRaw = Number(Array.isArray(query.before) ? query.before[0] : query.before);
  const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
  const activity = await orNotFound(api.stats.tokenActivity({ keyId: id, days, before, limit: PAGE_SIZE }), path);

  return (
    <PageBody wide>
      <PageHeader
        back={{ href: "/keys", label: "API keys" }}
        title={activity.key.name || "Unnamed key"}
        description="Detailed activity is kept for 90 days."
        actions={<RangeSelect days={days} />}
      />
      <DownloadsChart series={activity.series} />
      <section className="flex flex-col gap-2" aria-labelledby="events-heading" data-testid="key-events">
        <h2 id="events-heading" className="text-sm font-medium">
          Events
        </h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Time (UTC)</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Package</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="pr-3 text-right">Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activity.events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="pl-3 text-muted-foreground">
                    No activity recorded.
                  </TableCell>
                </TableRow>
              ) : (
                activity.events.map((event) => (
                  <TableRow key={event.id} data-testid="key-event">
                    <TableCell className="pl-3 font-mono text-xs">{event.at.toISOString().slice(0, 19).replace("T", " ")}</TableCell>
                    <TableCell className="text-sm">{event.action}</TableCell>
                    <TableCell className="font-mono text-xs">{event.repository ?? "deleted"}</TableCell>
                    <TableCell className="font-mono text-xs">{event.label ?? "-"}</TableCell>
                    <TableCell className="max-w-72 truncate font-mono text-xs" title={event.path}>
                      {event.path}
                    </TableCell>
                    <TableCell className="pr-3 text-right tabular-nums">{formatBytes(event.bytes)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {activity.nextBefore !== null && (
          <Button asChild variant="outline" size="sm" className="self-start">
            <Link href={`${path}?days=${days}&before=${activity.nextBefore}`}>Older events</Link>
          </Button>
        )}
      </section>
    </PageBody>
  );
}

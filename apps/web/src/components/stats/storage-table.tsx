import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { formatBytes } from "@/lib/browse";
import { formatRelative } from "@/lib/format";
import type { RouterOutputs } from "@/trpc/client";

type Storage = RouterOutputs["stats"]["overview"]["storage"][number];

/** `Measured 3 hours ago` for a snapshot time, or a note that nothing was measured yet. */
export function measuredLabel(takenAt: Date | null): string {
  return takenAt ? `Measured ${formatRelative(takenAt)}` : "Not measured yet";
}

/** Stored bytes per repository (hosted content and mirror cache), with the time of the newest measurement above. */
export function StorageTable({ rows }: { rows: Storage[] }) {
  const newest = rows.reduce<Date | null>((acc, row) => (row.takenAt && (!acc || row.takenAt > acc) ? row.takenAt : acc), null);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="storage-heading" data-testid="storage-table">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="storage-heading" className="text-sm font-medium">
          Storage
        </h2>
        <span className="text-xs text-muted-foreground">{measuredLabel(newest)}</span>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Repository</TableHead>
              <TableHead>Format</TableHead>
              <TableHead className="text-right">Hosted</TableHead>
              <TableHead className="text-right">Cache</TableHead>
              <TableHead className="pr-3 text-right">Assets</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="pl-3 text-muted-foreground">
                  No repositories yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.repositoryId}>
                  <TableCell className="pl-3 font-mono text-xs">{row.repository}</TableCell>
                  <TableCell className="text-sm">{row.format}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(row.hostedBytes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.kind === "mirror" ? formatBytes(row.cacheBytes) : "-"}</TableCell>
                  <TableCell className="pr-3 text-right tabular-nums">{row.assetCount.toLocaleString("en")}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

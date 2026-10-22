import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { formatPercent } from "@/lib/stats";
import type { RouterOutputs } from "@/trpc/client";

type HitRate = RouterOutputs["stats"]["overview"]["hitRates"][number];

/** Cache results per mirror over the range; the rate counts stale serves as hits. */
export function HitRateTable({ rows }: { rows: HitRate[] }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="hit-rate-heading" data-testid="hit-rate-table">
      <h2 id="hit-rate-heading" className="text-sm font-medium">
        Mirror hit rate
      </h2>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Mirror</TableHead>
              <TableHead className="text-right">Hits</TableHead>
              <TableHead className="text-right">Stale</TableHead>
              <TableHead className="text-right">Misses</TableHead>
              <TableHead className="pr-3 text-right">Hit rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="pl-3 text-muted-foreground">
                  No mirrors yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.repositoryId}>
                <TableCell className="pl-3 font-mono text-xs">{row.repository}</TableCell>
                <TableCell className="text-right tabular-nums">{row.hits.toLocaleString("en")}</TableCell>
                <TableCell className="text-right tabular-nums">{row.stale.toLocaleString("en")}</TableCell>
                <TableCell className="text-right tabular-nums">{row.misses.toLocaleString("en")}</TableCell>
                <TableCell className="pr-3 text-right font-medium tabular-nums">{formatPercent(row.hitRate)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { formatUtcDay } from "@/lib/stats";
import type { RouterOutputs } from "@/trpc/client";

type Token = RouterOutputs["stats"]["overview"]["tokens"][number];

/** The most active API keys of the range, each linking to its activity page. */
export function TokenTable({ rows, days }: { rows: Token[]; days: number }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="tokens-heading" data-testid="token-table">
      <h2 id="tokens-heading" className="text-sm font-medium">
        API key activity
      </h2>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Key</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead className="text-right">Downloads</TableHead>
              <TableHead className="text-right">Uploads</TableHead>
              <TableHead className="text-right">Deletes</TableHead>
              <TableHead className="pr-3 text-right">Last active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="pl-3 text-muted-foreground">
                  No key was used in this period.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.apiKeyId}>
                  <TableCell className="pl-3 text-sm">
                    <Link href={`/keys/${encodeURIComponent(row.apiKeyId)}/activity?days=${days}`} className="font-medium hover:underline">
                      {row.keyName || "unnamed"}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{row.ownerName ?? "-"}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.downloads.toLocaleString("en")}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.uploads.toLocaleString("en")}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.deletes.toLocaleString("en")}</TableCell>
                  <TableCell className="pr-3 text-right text-sm">{formatUtcDay(row.lastDay)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

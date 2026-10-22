import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { repositoryHref } from "@/lib/browse";
import type { RouterOutputs } from "@/trpc/client";

type Top = RouterOutputs["stats"]["overview"]["topPackages"][number];

/** The most downloaded packages of the range; `showRepository` is off on a single repository page. */
export function TopPackages({ rows, showRepository = true }: { rows: Top[]; showRepository?: boolean }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="top-packages-heading" data-testid="top-packages">
      <h2 id="top-packages-heading" className="text-sm font-medium">
        Top packages
      </h2>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Package</TableHead>
              {showRepository && <TableHead>Repository</TableHead>}
              <TableHead className="pr-3 text-right">Downloads</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={showRepository ? 3 : 2} className="pl-3 text-muted-foreground">
                  No downloads in this period.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={`${row.repositoryId}:${row.namespace}:${row.name}`}>
                  <TableCell className="pl-3 font-mono text-xs">{row.label}</TableCell>
                  {showRepository && (
                    <TableCell className="text-sm">
                      <Link href={repositoryHref(row.repository)} className="font-mono text-xs hover:underline">
                        {row.repository}
                      </Link>
                    </TableCell>
                  )}
                  <TableCell className="pr-3 text-right tabular-nums">{row.downloads.toLocaleString("en")}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

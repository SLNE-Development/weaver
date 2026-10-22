import { ArchiveIcon } from "lucide-react";
import { Badge } from "@weaver/ui/components/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { Panel, RelativeTime, SectionTitle } from "@/components/browse-ui";
import { UsageSnippet } from "@/components/usage-snippet";
import { formatBytes } from "@/lib/browse";
import type { BrowseRepo } from "@/server/trpc/routers/browse";
import { api } from "@/trpc/server";

/**
 * The browse view of a proto mirror: what it has cached (archives, newest access first) or, with
 * caching off, a note that its content lives upstream, plus the client setup for the mirror. Only
 * admins are told the upstream URL; nothing else of the mirror config is shown.
 */
export async function ProtoMirrorView({ repo }: { repo: BrowseRepo }) {
  const cache = await api.browse.protoCache({ repository: repo.name });

  return (
    <>
      {!cache.caching && (
        <p className="rounded-md border bg-surface px-3 py-2 text-sm text-muted-foreground">
          {cache.upstream ? (
            <>
              This mirror does not cache; its content lives upstream at <code className="break-all text-foreground">{cache.upstream}</code>.
            </>
          ) : (
            "This mirror does not cache; every request is passed on to its upstream, so nothing is kept here to browse."
          )}
        </p>
      )}
      {cache.items.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle count={cache.items.length}>Cached archives</SectionTitle>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Coordinate</TableHead>
                  <TableHead className="hidden sm:table-cell">Build</TableHead>
                  <TableHead className="hidden sm:table-cell">Cache</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Size</TableHead>
                  <TableHead className="pr-4 text-right">Last fetched</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cache.items.map((item) => (
                  <TableRow key={`${item.coordinate}#${item.buildNumber ?? "latest"}`}>
                    <TableCell className="max-w-0 pl-4">
                      <span className="block truncate font-mono text-[13px]">{item.coordinate}</span>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                      {item.buildNumber === null ? "newest" : `#${item.buildNumber}`}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="outline" className="rounded-sm px-1.5 py-0 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                        {item.cache === "immutable" ? "kept" : "revalidated"}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden text-right font-mono text-xs tabular-nums md:table-cell">{formatBytes(item.size)}</TableCell>
                    <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                      {item.lastAccessedAt ? <RelativeTime date={item.lastAccessedAt} /> : "never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </section>
      ) : (
        cache.caching && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ArchiveIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing cached yet</EmptyTitle>
              <EmptyDescription>Archives show up here once they have been fetched through this mirror.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      )}
      <section className="flex flex-col gap-2">
        <SectionTitle>Use this mirror</SectionTitle>
        <UsageSnippet repository={repo.name} />
      </section>
    </>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import { DownloadIcon, PackageSearchIcon } from "lucide-react";
import type { Format } from "@weaver/core";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@weaver/ui/components/toggle-group";
import { FormatBadge } from "@/app/(app)/repositories/_components/format-badge";
import { packageHref } from "@/components/browse/links";
import { Panel } from "@/components/browse-ui";
import { searchHref } from "@/lib/search";
import { repositoryHref } from "@/lib/browse";
import { FORMAT_OPTIONS } from "@/lib/repository-settings";
import { useTRPCClient } from "@/trpc/client";

/** Hits per page of the search page. */
const PAGE_SIZE = 20;
/** The largest offset `search.query` accepts. */
const OFFSET_MAX = 1000;
/** The chip value of "All formats". */
const ALL = "all";

/** The format filter chips: All, then every format; picking one reloads `/search` with it. */
function FormatChips({ q, format }: { q: string; format: Format | null }) {
  const router = useRouter();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label="Filter by format"
      value={format ?? ALL}
      onValueChange={(next) => {
        if (next) router.push(searchHref(q, next === ALL ? null : next));
      }}
    >
      <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
      {FORMAT_OPTIONS.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * The results of `/search?q=&format=`: format chips, one row per package (format badge, label
 * linking the package page when it has one, repository and "via <group>" linking their browse
 * pages, latest version, downloads), and
 * "Load more" while more pages exist.
 */
export function SearchResults({ q, format }: { q: string; format: Format | null }) {
  const client = useTRPCClient();
  const results = useInfiniteQuery({
    queryKey: ["search.query", q, format],
    queryFn: ({ pageParam }) =>
      client.search.query.query({ q, ...(format ? { format } : {}), limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const next = pages.length * PAGE_SIZE;
      return last.hasMore && next <= OFFSET_MAX ? next : undefined;
    },
    retry: false,
  });
  const hits = results.data?.pages.flatMap((page) => page.hits) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <FormatChips q={q} format={format} />
      {results.isPending ? (
        <Panel className="flex flex-col gap-2 p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </Panel>
      ) : results.isError ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Search failed</EmptyTitle>
            <EmptyDescription>{results.error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : hits.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageSearchIcon />
            </EmptyMedia>
            <EmptyTitle>No packages match &quot;{q}&quot;</EmptyTitle>
            <EmptyDescription>Only packages in repositories you can read are searched.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Panel>
            <ul className="divide-y" aria-label="Search results">
              {hits.map((hit) => {
                const href = packageHref(hit);
                const label = <span className="min-w-0 flex-1 truncate font-mono text-sm">{hit.label}</span>;
                return (
                  <li
                    key={`${hit.repository}/${hit.via ?? ""}/${hit.namespace}/${hit.name}`}
                    data-format={hit.format}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
                  >
                    <FormatBadge format={hit.format} className="shrink-0" />
                    {href ? (
                      <Link href={href} className="min-w-0 flex-1 truncate font-mono text-sm hover:underline">
                        {hit.label}
                      </Link>
                    ) : (
                      label
                    )}
                    <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
                      <Link href={repositoryHref(hit.repository)} className="hover:underline">
                        {hit.repository}
                      </Link>
                      {hit.via && (
                        <>
                          {" via "}
                          <Link href={repositoryHref(hit.via)} className="hover:underline">
                            {hit.via}
                          </Link>
                        </>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-xs">{hit.latestVersion}</span>
                    <span className="flex w-16 shrink-0 items-center justify-end gap-1 font-mono text-xs text-muted-foreground tabular-nums">
                      <DownloadIcon className="size-3" aria-hidden />
                      <span aria-label="Downloads">{hit.downloads}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>
          {results.hasNextPage && (
            <Button variant="outline" className="self-center" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
              {results.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

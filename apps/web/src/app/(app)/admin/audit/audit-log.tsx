"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BotIcon, ChevronRightIcon, KeyRoundIcon, ScrollTextIcon, ShieldAlertIcon, UserIcon, UserXIcon } from "lucide-react";
import { Badge } from "@weaver/ui/components/badge";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Spinner } from "@weaver/ui/components/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { cn } from "@weaver/ui/lib/utils";
import { useTRPC, type RouterOutputs } from "@/trpc/client";
import { formatDateTime, formatTimestamp } from "../_components/format";

type AuditItem = RouterOutputs["audit"]["list"]["items"][number];

const ALL = "__all__";
const PAGE_SIZE = 50;

const ACTOR_ICONS = { user: UserIcon, apikey: KeyRoundIcon, system: BotIcon, anonymous: UserXIcon } as const;

/** Who did it: the user or key name (or its id once deleted), the system, or an anonymous caller. */
function Actor({ item }: { item: AuditItem }) {
  const Icon = ACTOR_ICONS[item.actorType];
  const label =
    item.actorType === "system"
      ? "System"
      : item.actorType === "anonymous"
        ? "Anonymous"
        : (item.actorName ?? (item.actorId ? `${item.actorId} (deleted)` : "Unknown"));
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className={cn("truncate", item.actorType === "apikey" && "font-mono text-xs")}>{label}</span>
      {item.actorType === "apikey" && <span className="sr-only">(API key)</span>}
    </span>
  );
}

function hasDetails(details: unknown): boolean {
  if (details === null || details === undefined) return false;
  if (typeof details === "object") return Object.keys(details).length > 0;
  return true;
}

/**
 * The audit log as an endlessly scrolling table (time, actor, action, target, forced) with
 * expandable details and a filter by action. Pages load as the end of the table scrolls into view.
 */
export function AuditLog() {
  const trpc = useTRPC();
  const [action, setAction] = useState<string>(ALL);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const actions = useQuery(trpc.audit.actions.queryOptions());
  const log = useInfiniteQuery(
    trpc.audit.list.infiniteQueryOptions(
      { limit: PAGE_SIZE, action: action === ALL ? undefined : action },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  );
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = log;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasNextPage || isFetchNextPageError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const items = log.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger size="sm" aria-label="Action" className="w-full font-mono text-xs sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">
              All actions
            </SelectItem>
            {actions.data && actions.data.length > 0 && <SelectSeparator />}
            {actions.data?.map((name) => (
              <SelectItem key={name} value={name} className="font-mono text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {action !== ALL && (
          <Button variant="ghost" size="sm" onClick={() => setAction(ALL)}>
            Clear filter
          </Button>
        )}
        {log.isFetching && !log.isFetchingNextPage && <Spinner className="text-muted-foreground" />}
      </div>

      {log.isError && !log.data ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldAlertIcon />
            </EmptyMedia>
            <EmptyTitle>Couldn&apos;t load the audit log</EmptyTitle>
            <EmptyDescription>{log.error.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={() => void log.refetch()}>
              Try again
            </Button>
          </EmptyContent>
        </Empty>
      ) : !log.isPending && items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon />
            </EmptyMedia>
            <EmptyTitle>No entries</EmptyTitle>
            <EmptyDescription>{action === ALL ? "Nothing has been recorded yet." : "No entries for this action."}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-md border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="w-10 pl-2">
                  <span className="sr-only">Details</span>
                </TableHead>
                <TableHead className="hidden w-44 md:table-cell">Time</TableHead>
                <TableHead className="w-36 sm:w-44">Actor</TableHead>
                <TableHead className="w-40 sm:w-48">Action</TableHead>
                <TableHead className="hidden sm:table-cell">Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.isPending
                ? Array.from({ length: 8 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : items.map((item) => {
                    const open = expanded.has(item.id);
                    return (
                      <Fragment key={item.id}>
                        <TableRow data-state={open ? "selected" : undefined} className="cursor-pointer" onClick={() => toggle(item.id)}>
                          <TableCell className="pl-2">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-expanded={open}
                              aria-label={open ? "Hide details" : "Show details"}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggle(item.id);
                              }}
                            >
                              <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
                            </Button>
                          </TableCell>
                          <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell" title={formatDateTime(item.at)}>
                            {formatTimestamp(item.at)}
                          </TableCell>
                          <TableCell>
                            <Actor item={item} />
                          </TableCell>
                          <TableCell>
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate font-mono text-xs">{item.action}</span>
                              {item.forced && (
                                <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-[10px] text-destructive">
                                  forced
                                </Badge>
                              )}
                            </span>
                            <span className="block font-mono text-[10px] text-muted-foreground md:hidden">{formatTimestamp(item.at)}</span>
                          </TableCell>
                          <TableCell className="hidden truncate font-mono text-xs sm:table-cell" title={item.target}>
                            {item.target}
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={5} className="px-4 py-3 whitespace-normal">
                              <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                                <dt className="text-muted-foreground">Time</dt>
                                <dd className="font-mono">{formatDateTime(item.at)}</dd>
                                <dt className="text-muted-foreground">Actor</dt>
                                <dd className="font-mono break-all">
                                  {item.actorType}
                                  {item.actorId ? ` · ${item.actorId}` : ""}
                                </dd>
                                <dt className="text-muted-foreground">Target</dt>
                                <dd className="font-mono break-all">{item.target}</dd>
                              </dl>
                              {hasDetails(item.details) ? (
                                <pre className="max-h-80 overflow-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed">
                                  {JSON.stringify(item.details, null, 2)}
                                </pre>
                              ) : (
                                <p className="text-xs text-muted-foreground">No further details.</p>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
            </TableBody>
          </Table>
          <div ref={sentinel} className="flex justify-center border-t px-4 py-2 text-xs text-muted-foreground">
            {log.isFetchingNextPage ? (
              <Spinner />
            ) : log.isFetchNextPageError ? (
              <span role="alert" className="flex items-center gap-2 text-destructive">
                Couldn&apos;t load more entries.
                <Button variant="outline" size="sm" onClick={() => void log.fetchNextPage()}>
                  Try again
                </Button>
              </span>
            ) : log.hasNextPage ? (
              <Button variant="ghost" size="sm" onClick={() => void log.fetchNextPage()}>
                Load more
              </Button>
            ) : (
              !log.isPending && <span>{items.length === 1 ? "1 entry" : `${items.length} entries`} · end of the log</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

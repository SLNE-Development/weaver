"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PackageIcon, SearchIcon } from "lucide-react";
import { CommandGroup, CommandItem } from "@weaver/ui/components/command";
import { packageHref } from "@/components/browse/links";
import { repositoryHref } from "@/lib/browse";
import { searchHref } from "@/lib/search";
import { useTRPC } from "@/trpc/client";
import type { PackageSearchProps } from "./command-menu";

/** Characters needed before the dialog searches packages. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * The command dialog's "Packages" group: live `search.query` results (8 at most) for the typed
 * query, debounced, from two characters on. Enter opens the package page, or the repository
 * for a package without one. A last item opens the full search page for the query.
 */
export function PackageSearch({ query, onNavigate }: PackageSearchProps) {
  const trpc = useTRPC();
  const term = useDebounced(query.trim(), DEBOUNCE_MS);
  const enabled = term.length >= MIN_QUERY && query.trim().length >= MIN_QUERY;
  const { data } = useQuery({
    ...trpc.search.query.queryOptions({ q: term, limit: 8 }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    retry: false,
  });

  if (!enabled || !data) return null;
  return (
    <CommandGroup heading="Packages">
      {data.hits.map((hit) => (
        <CommandItem
          key={`${hit.repository}/${hit.via ?? ""}/${hit.namespace}/${hit.name}`}
          // cmdk filters items by value and keywords; the server already matched them, so the
          // typed query is a keyword too and the results are never filtered away.
          value={`package ${hit.repository} ${hit.via ?? ""} ${hit.label}`}
          keywords={[query, hit.label, hit.repository, ...(hit.via ? [hit.via] : [])]}
          // Packages without a page of their own open their repository.
          onSelect={() => onNavigate(packageHref(hit) ?? repositoryHref(hit.via ?? hit.repository))}
        >
          <PackageIcon />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{hit.label}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {hit.via ? `${hit.repository} via ${hit.via}` : hit.repository} · {hit.latestVersion}
          </span>
        </CommandItem>
      ))}
      {/* Always shown, never scored against the query, so it stays below the matches. */}
      <CommandItem value="See all package results" forceMount onSelect={() => onNavigate(searchHref(term))}>
        <SearchIcon />
        <span className="flex-1">See all results</span>
      </CommandItem>
    </CommandGroup>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { FORMATS, type Format } from "@weaver/core";
import { PageContainer, PageHeader } from "@/components/browse-ui";
import { searchHref } from "@/lib/search";
import { SearchBox } from "@/components/search-box";
import { SearchResults } from "@/components/search-results";
import { requirePageAccess } from "@/server/session";

export const metadata: Metadata = { title: "Search", robots: { index: false } };

type SearchParams = { q?: string | string[]; format?: string | string[] };

/** The first value of a search param. */
function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** Package search across every repository the visitor may read: `/search?q=&format=`. */
export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const q = first(params.q).slice(0, 200);
  const rawFormat = first(params.format);
  const format = (FORMATS as readonly string[]).includes(rawFormat) ? (rawFormat as Format) : null;
  await requirePageAccess(q ? searchHref(q, format) : "/search");

  return (
    <PageContainer>
      <PageHeader crumbs={[{ label: "Search" }]} title={q ? <>Packages matching <span className="font-mono">{q}</span></> : "Search packages"} />
      <Suspense>
        <SearchBox className="mb-6" />
      </Suspense>
      {q.length >= 2 ? (
        <SearchResults key={`${q}/${format ?? ""}`} q={q} format={format} />
      ) : (
        <p className="text-sm text-muted-foreground">Type at least two characters in the search box above, or press Ctrl+K anywhere.</p>
      )}
    </PageContainer>
  );
}

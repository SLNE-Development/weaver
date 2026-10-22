/** The search page of `q`, optionally filtered to one format. */
export function searchHref(q: string, format?: string | null): string {
  const params = new URLSearchParams({ q });
  if (format) params.set("format", format);
  return `/search?${params.toString()}`;
}

import type { FormatDeps, Repo } from "@weaver/core";
import type { MavenContext } from "./context.js";
import { textResponse } from "./http.js";

/** One row of a directory listing: a child file or directory of the listed prefix. */
export interface ListingEntry {
  name: string;
  directory: boolean;
  /** Bytes of a file; null for directories. */
  size: number | null;
  /** Last change of a file; null for directories. */
  updatedAt: Date | null;
}

/** Column the size starts at, counted in visible characters of the link text. */
const NAME_COLUMN = 50;

/**
 * Immediate children of `prefix` (empty or ending in `/`) across the given repos' stored assets;
 * the first repo wins when two hold the same name; directories first, then by name.
 */
export async function listEntries(deps: FormatDeps, repoIds: string[], prefix: string): Promise<ListingEntry[]> {
  const byName = new Map<string, ListingEntry>();
  for (const repoId of repoIds) {
    const seen = new Map<string, ListingEntry>();
    for (const asset of await deps.assets.list(repoId, prefix)) {
      const rest = asset.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (name === "" || byName.has(name) || seen.has(name)) continue;
      seen.set(name, slash < 0 ? { name, directory: false, size: asset.size, updatedAt: asset.updatedAt } : { name, directory: true, size: null, updatedAt: null });
    }
    for (const [name, entry] of seen) byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** The entity for each character that is special in HTML. */
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for use in HTML content and double-quoted attributes. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** One `<pre>` line: the link, padded to a column, then the size and ISO time (`-` for directories). */
function entryLine(entry: ListingEntry): string {
  const text = entry.directory ? `${entry.name}/` : entry.name;
  const href = encodeURIComponent(entry.name) + (entry.directory ? "/" : "");
  const pad = " ".repeat(Math.max(1, NAME_COLUMN - text.length));
  const size = entry.size === null ? "-" : String(entry.size);
  const time = entry.updatedAt === null ? "-" : entry.updatedAt.toISOString();
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>${pad}${size.padStart(12)}  ${time}`;
}

/** Renders the HTML listing page of `prefix` in a repository. */
export function renderListing(repoName: string, prefix: string, entries: ListingEntry[]): string {
  const title = escapeHtml(`Weaver: ${repoName}/${prefix}`);
  const lines = entries.map(entryLine);
  if (prefix !== "") lines.unshift('<a href="../">../</a>');
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    "<hr>",
    "<pre>",
    ...lines,
    "</pre>",
    "<hr>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * Answers a directory request with the HTML listing of the stored (for mirrors: cached) assets;
 * groups list the union of their members in member order. An empty directory below the root is 404.
 */
export async function listDirectory(ctx: MavenContext, repo: Repo, prefix: string): Promise<Response> {
  const repoIds = repo.kind === "group" ? (await ctx.deps.repos.members(repo.id)).map((m) => m.id) : [repo.id];
  const entries = await listEntries(ctx.deps, repoIds, prefix);
  if (prefix !== "" && entries.length === 0) return textResponse(404, "Not Found");
  const html = Buffer.from(renderListing(repo.name, prefix, entries), "utf8");
  return new Response(ctx.method === "HEAD" ? null : html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-length": String(html.length) },
  });
}

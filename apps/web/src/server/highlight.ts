import "server-only";

import { createHighlighter, type Highlighter } from "shiki";

/** Languages the UI highlights. */
export type CodeLanguage = "proto" | "kotlin" | "json";

const LANGUAGES: CodeLanguage[] = ["proto", "kotlin", "json"];

/** Sources larger than this (UTF-8 bytes) are shown as plain, escaped text instead of highlighted. */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024;

/** Highlighted files kept in memory, keyed by build checksum and path. */
const CACHE_ENTRIES = 200;

interface ShikiState {
  highlighter?: Promise<Highlighter>;
  cache: Map<string, string>;
}

// Kept on globalThis so dev-mode reloads reuse the loaded grammars and the cache.
const globalForShiki = globalThis as typeof globalThis & { __weaverShiki?: ShikiState };
const state: ShikiState = (globalForShiki.__weaverShiki ??= { cache: new Map() });

function highlighter(): Promise<Highlighter> {
  state.highlighter ??= createHighlighter({ themes: ["github-light", "github-dark"], langs: LANGUAGES });
  return state.highlighter;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** The same markup Shiki produces (`pre.shiki > code > span.line`), without colors. */
export function plainHtml(code: string): string {
  const lines = code.split("\n").map((line) => `<span class="line">${escapeHtml(line)}</span>`);
  return `<pre class="shiki plain"><code>${lines.join("\n")}</code></pre>`;
}

/** Least-recently-used lookup: a hit moves the entry to the end; inserts evict the oldest. */
function cached(key: string, compute: () => Promise<string>): Promise<string> {
  const hit = state.cache.get(key);
  if (hit !== undefined) {
    state.cache.delete(key);
    state.cache.set(key, hit);
    return Promise.resolve(hit);
  }
  return compute().then((html) => {
    state.cache.set(key, html);
    while (state.cache.size > CACHE_ENTRIES) state.cache.delete(state.cache.keys().next().value!);
    return html;
  });
}

/**
 * Turns `code` into Shiki HTML (`<pre class="shiki"><code><span class="line">…`) on the server.
 * Token colors come as `--shiki-light` / `--shiki-dark` custom properties, so the CSS of
 * `CodeBlock` picks the right one for the active theme without re-rendering. Sources above
 * {@link HIGHLIGHT_MAX_BYTES} come back as plain escaped text. With `cacheKey` (for example a build
 * checksum plus the file path) the result is kept in a bounded LRU cache.
 */
export async function highlight(code: string, lang: CodeLanguage, cacheKey?: string): Promise<string> {
  if (Buffer.byteLength(code, "utf8") > HIGHLIGHT_MAX_BYTES) return plainHtml(code);
  const render = async () =>
    (await highlighter()).codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
  return cacheKey ? cached(`${lang}\u0000${cacheKey}`, render) : render();
}

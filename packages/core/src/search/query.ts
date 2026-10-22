import { RegistryError } from "../errors.js";

/** Most terms a search query keeps; later terms are ignored. */
export const SEARCH_TERMS_MAX = 5;

/** A search query split into terms the way `component.search_text` is normalised. */
export interface ParsedSearch {
  /** The normalised query split on whitespace, at most {@link SEARCH_TERMS_MAX}. */
  terms: string[];
  /** The terms without a trailing version segment (`g:a:1.0`, `pkg@1.2.3`, `image:tag`); null when the query has none. */
  altTerms: string[] | null;
  /** The whole query normalised like `search_text`: lower-cased, `:` and `/` as spaces, trimmed. */
  normalized: string;
}

/**
 * Normalises text like the generated `search_text` column (`btrim(lower(translate(text, ':/', '  ')))`),
 * with runs of whitespace collapsed to one space.
 */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/[:/]/g, " ").trim().replace(/\s+/g, " ");
}

/** Whether a term has at least two characters as `search_text` stores it (npm scopes lose their `@`). */
function isUsableTerm(term: string): boolean {
  return (term.startsWith("@") ? term.slice(1) : term).length >= 2;
}

/** The normalised text split into at most {@link SEARCH_TERMS_MAX} terms. */
function termsOf(normalized: string): string[] {
  return normalized.split(/\s+/).filter((t) => t !== "").slice(0, SEARCH_TERMS_MAX);
}

/**
 * The query without its trailing version segment: from an `@` that is not the first character
 * and comes after the last `/` (`pkg@1.2.3`, `@s/p@1.2.3`, `image@sha256:…`), otherwise from the
 * last `:` (`g:a:1.0`, `image:tag`). Null when there is no such segment.
 */
function withoutVersion(raw: string): string | null {
  const at = raw.lastIndexOf("@");
  if (at > 0 && at > raw.lastIndexOf("/")) return raw.slice(0, at);
  const colon = raw.lastIndexOf(":");
  return colon >= 0 ? raw.slice(0, colon) : null;
}

/**
 * Parses a search query: normalises it like `search_text` and splits it into terms, plus the
 * alternative terms without a trailing version segment (null unless one of them has two stored
 * characters). Throws `invalid_request` when fewer than two characters remain after normalising
 * or no term has two characters as `search_text` stores it (`"@ @"`, `"a b"`).
 */
export function parseSearchQuery(raw: string): ParsedSearch {
  const trimmed = raw.trim();
  const normalized = normalizeSearchText(trimmed);
  const terms = termsOf(normalized);
  // A query without a term of two stored characters would match (and scan) nearly everything.
  if (normalized.length < 2 || !terms.some(isUsableTerm)) {
    throw new RegistryError("invalid_request", "A search needs a term of at least 2 characters");
  }
  const stripped = withoutVersion(trimmed);
  const alt = stripped === null ? [] : termsOf(normalizeSearchText(stripped));
  return { terms, altTerms: alt.some(isUsableTerm) ? alt : null, normalized };
}

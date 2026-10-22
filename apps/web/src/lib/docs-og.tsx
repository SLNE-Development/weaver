import { renderOgCard, type OgCardInput } from "./og";

/** Content of a docs share card. */
export interface DocsOgCard {
  /** Short mono line above the title, such as `Docs · Getting started`. */
  eyebrow: string;
  title: string;
  subtitle: string;
  /** Instance host shown bottom left, such as `protos.example.com`. */
  host: string;
  /** Page path shown bottom right, such as `/docs/admin/keys`. */
  path: string;
}

/** Longest description shown on a card before it is cut with an ellipsis. */
const MAX_SUBTITLE = 150;

/** The shared share-card input for a docs page: host bottom left, page path bottom right. */
export function docsOgCardInput({ eyebrow, title, subtitle, host, path }: DocsOgCard): OgCardInput {
  return {
    eyebrow,
    title,
    subtitle: subtitle.length > MAX_SUBTITLE ? `${subtitle.slice(0, MAX_SUBTITLE - 3)}…` : subtitle,
    footer: host,
    meta: [path],
  };
}

/** Renders a 1200×630 docs share card with the one Weaver card template (see ./og). */
export function renderDocsOgCard(card: DocsOgCard, init?: { headers?: Record<string, string> }) {
  return renderOgCard(docsOgCardInput(card), init);
}

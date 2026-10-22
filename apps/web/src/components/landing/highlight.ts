import { createHighlighter, type ShikiTransformer, type ThemeRegistration } from "shiki";
import type { SnippetLang } from "./samples";

/** Languages used on the landing page. */
export type CodeLang = SnippetLang | "proto";

const LANGS: CodeLang[] = ["proto", "kotlin", "json", "yaml", "ini", "shellscript", "xml"];

interface InkPalette {
  fg: string;
  muted: string;
  link: string;
  release: string;
  snapshot: string;
}

/**
 * Shiki theme in the Ink palette (packages/ui globals.css): keywords in bold ink, types and calls
 * in link blue, strings in release green, numbers in snapshot amber, comments muted italic.
 * Font styles are the same in both themes, so only the colour switches with dark mode.
 */
function inkTheme(name: string, type: "light" | "dark", c: InkPalette): ThemeRegistration {
  return {
    name,
    type,
    colors: { "editor.foreground": c.fg, "editor.background": "#00000000" },
    tokenColors: [
      { settings: { foreground: c.fg } },
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: c.muted, fontStyle: "italic" } },
      { scope: ["keyword.other", "keyword.control", "storage.modifier", "keyword.declaration"], settings: { foreground: c.fg, fontStyle: "bold" } },
      { scope: ["keyword.operator", "punctuation"], settings: { foreground: c.fg, fontStyle: "" } },
      { scope: ["storage.type", "entity.name.class", "entity.name.type", "support.type", "entity.name.function"], settings: { foreground: c.link } },
      { scope: ["entity.name.function.call"], settings: { foreground: c.fg } },
      { scope: ["string", "string.unquoted.plain.out.yaml"], settings: { foreground: c.release } },
      { scope: ["string.unquoted.proto.package", "entity.name.tag", "support.type.property-name"], settings: { foreground: c.fg } },
      { scope: ["constant.numeric", "constant.language"], settings: { foreground: c.snapshot } },
      { scope: ["variable.other.normal.shell", "punctuation.definition.variable.shell", "variable.other.bracket.shell"], settings: { foreground: c.snapshot } },
    ],
  };
}

const INK_LIGHT = inkTheme("ink-light", "light", {
  fg: "#0a0a0a",
  muted: "#6b6b6b",
  link: "#1f5eff",
  release: "#15803d",
  snapshot: "#b45309",
});

const INK_DARK = inkTheme("ink-dark", "dark", {
  fg: "#ededed",
  muted: "#8f8f8f",
  link: "#7aa2ff",
  release: "#4ade80",
  snapshot: "#f59e0b",
});

let highlighter: ReturnType<typeof createHighlighter> | undefined;

/** One highlighter per process, with only the landing languages and the Ink themes loaded. */
function getHighlighter() {
  highlighter ??= createHighlighter({ themes: [INK_LIGHT, INK_DARK], langs: LANGS });
  return highlighter;
}

/** Drops Shiki's inline pre colours (the page sets them) and optionally prefixes line numbers. */
function inkTransformer(lineNumbers: boolean): ShikiTransformer {
  return {
    pre(node) {
      delete node.properties.style;
      node.properties.tabindex = "0";
    },
    line(node, line) {
      if (!lineNumbers) return;
      node.children.unshift({
        type: "element",
        tagName: "span",
        properties: { className: ["ln"], "aria-hidden": "true" },
        children: [{ type: "text", value: String(line) }],
      });
    },
  };
}

/** Highlights `code` to HTML with the Ink light colours inline and the dark ones in `--shiki-dark`. */
export async function highlight(code: string, lang: CodeLang, opts: { lineNumbers?: boolean } = {}): Promise<string> {
  const hl = await getHighlighter();
  return hl.codeToHtml(code.replace(/\n$/, ""), {
    lang,
    themes: { light: INK_LIGHT, dark: INK_DARK },
    defaultColor: "light",
    transformers: [inkTransformer(opts.lineNumbers ?? false)],
  });
}

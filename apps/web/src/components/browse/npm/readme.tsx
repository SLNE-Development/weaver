import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/** Longest README rendered; the rest is cut off. */
const README_MAX = 512 * 1024;

/**
 * Renders package README Markdown to HTML. Raw HTML in the source is dropped by the Markdown to HTML step and the result
 * goes through `rehype-sanitize` with its default (GitHub-like) schema, so the output holds no scripts, event handlers
 * or `javascript:` URLs.
 */
export async function renderReadmeHtml(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize)
    .use(rehypeStringify)
    .process(markdown.slice(0, README_MAX));
  return String(file);
}

/** A package README as sanitized HTML. */
export async function Readme({ markdown }: { markdown: string }) {
  const html = await renderReadmeHtml(markdown);
  return (
    <article
      className="prose-readme min-w-0 max-w-none overflow-x-auto text-sm leading-6 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_img]:max-w-full [&_li]:ml-5 [&_li]:list-disc [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-card [&_pre]:p-3 [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2"
      // The HTML was sanitized by rehype-sanitize in renderReadmeHtml.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

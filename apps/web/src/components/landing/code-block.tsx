import type { ReactNode } from "react";
import { cn } from "@weaver/ui/lib/utils";

/**
 * Styles for Shiki output from ./highlight: light colours are inline, dark ones come from
 * `--shiki-dark`. The block is as tall as its code; a long line scrolls sideways inside the `pre`
 * only (`overflow-y: hidden`, since `overflow-x: auto` alone would make the other axis scroll too).
 */
export const codeClasses = cn(
  "min-w-0 font-mono text-[12px] leading-[1.65] sm:text-[12.5px]",
  "[&_pre]:overflow-x-auto [&_pre]:overflow-y-hidden [&_pre]:px-4 [&_pre]:py-3.5 [&_pre]:outline-none",
  "[&_pre:focus-visible]:ring-2 [&_pre:focus-visible]:ring-ring/40 [&_pre:focus-visible]:ring-inset",
  "dark:[&_span[style]]:text-(--shiki-dark)!",
  "[&_.ln]:inline-block [&_.ln]:w-[2.2em] [&_.ln]:text-muted-foreground/60 [&_.ln]:select-none",
);

/** Pre-highlighted HTML from {@link highlight}. */
export function CodeHtml({ html, label, className }: { html: string; label?: string; className?: string }) {
  return <div role={label ? "region" : undefined} aria-label={label} className={cn(codeClasses, className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** File name bar above a code block. Long names wrap instead of being cut off. */
export function FileLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        "border-b px-4 py-2 font-mono text-[11.5px] leading-snug [overflow-wrap:anywhere] text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A labelled, highlighted file: name bar on top, code below. */
export function CodeFile({ file, html, className }: { file: string; html: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <FileLabel>{file}</FileLabel>
      <CodeHtml html={html} label={file} />
    </div>
  );
}

/**
 * A short terminal transcript; lines are given as nodes so prompts and results can be coloured.
 * Long lines wrap, so the box is always as wide as its column and as tall as its text.
 */
export function Terminal({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <pre
      aria-label={label}
      className={cn(
        "rounded-md border bg-surface px-3 py-2.5 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap text-[12px] leading-[1.65] text-foreground",
        className,
      )}
    >
      {children}
    </pre>
  );
}

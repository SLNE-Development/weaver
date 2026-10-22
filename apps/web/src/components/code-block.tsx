import type { ReactNode } from "react";
import { cn } from "@weaver/ui/lib/utils";
import { highlight, type CodeLanguage } from "@/server/highlight";
import { CopyButton } from "./copy-button";

/**
 * Server-highlighted code with a header bar (title, extra content, copy action). Colors follow
 * the light/dark theme through Shiki's CSS variables; `lineNumbers` adds a gutter. The copy action
 * is `copy` when given (e.g. one that fetches a large file on demand), otherwise a button that
 * copies `code` (only for small sources: the text becomes a client prop).
 */
export async function CodeBlock({
  code,
  lang,
  cacheKey,
  title,
  extra,
  copy,
  copyLabel = "Copy",
  lineNumbers = false,
  className,
  testId,
}: {
  code: string;
  lang: CodeLanguage;
  /** Key of the highlight cache, e.g. build checksum plus path. */
  cacheKey?: string;
  title: ReactNode;
  extra?: ReactNode;
  copy?: ReactNode;
  copyLabel?: string;
  lineNumbers?: boolean;
  className?: string;
  testId?: string;
}) {
  const html = await highlight(code, lang, cacheKey);
  return (
    <div data-testid={testId} className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border bg-card", className)}>
      <div className="flex h-9 items-center gap-2 border-b bg-surface px-3">
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{title}</div>
        {extra}
        {copy ?? <CopyButton text={code} label={copyLabel} toastText="Copied to clipboard" />}
      </div>
      <div
        className={cn(
          "overflow-x-auto text-[13px] leading-6",
          "[&_pre]:min-w-fit [&_pre]:bg-transparent! [&_pre]:py-3 [&_pre]:font-mono [&_code]:block",
          "[&_pre]:px-4",
          "[&_span]:text-(--shiki-light) dark:[&_span]:text-(--shiki-dark)",
          lineNumbers &&
            "[&_code]:[counter-reset:line] [&_pre]:pl-0 [&_.line]:before:mr-4 [&_.line]:before:inline-block [&_.line]:before:w-10 [&_.line]:before:pr-1 [&_.line]:before:text-right [&_.line]:before:text-muted-foreground/60 [&_.line]:before:select-none [&_.line]:before:[counter-increment:line] [&_.line]:before:content-[counter(line)]",
        )}
        // Shiki (or plainHtml) escapes the source; the HTML only contains its own spans.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

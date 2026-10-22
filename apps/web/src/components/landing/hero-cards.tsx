"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@weaver/ui/components/tabs";
import { cn } from "@weaver/ui/lib/utils";
import { CodeHtml, FileLabel } from "./code-block";

export interface HighlightedFormat {
  /** Tab label, e.g. "npm". */
  format: string;
  /** Where clients of this format point, e.g. "/npm/<repo>/". */
  url: string;
  files: { file: string; html: string }[];
}

/*
 * The design system's TabsList pins its height with `group-data-[orientation=horizontal]/tabs:h-9`,
 * and its triggers fill that height and draw the line indicator 5px below it. Overrides have to use
 * the same variants, or tailwind-merge keeps both classes and the more specific one wins: a plain
 * `h-auto` loses, the list stays 36px while its triggers are taller, and the header clips them.
 */
const listClass = cn(
  "w-full flex-wrap justify-start gap-x-1 gap-y-0 rounded-none border-b bg-surface px-2 py-0",
  "group-data-[orientation=horizontal]/tabs:h-auto",
);

const triggerClass = cn(
  "h-auto flex-none rounded-none px-2.5 py-2.5 font-mono text-xs font-normal",
  "group-data-[orientation=horizontal]/tabs:after:bottom-[-1px] group-data-[orientation=horizontal]/tabs:after:h-[1.5px]",
  // The card clips overflow, so the focus ring is drawn inside the tab.
  "focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none",
);

/**
 * The hero's client card: one tab per format with the files a client needs to point at this
 * instance. The card is as tall as the active panel's code; nothing in it scrolls vertically.
 */
export function HeroCards({ formats }: { formats: HighlightedFormat[] }) {
  const [value, setValue] = useState(formats[0]!.format);

  return (
    <div className="w-full max-w-[640px] overflow-hidden rounded-lg border bg-background shadow-[0_18px_40px_-18px_rgb(0_0_0/0.35)] xl:max-w-none dark:shadow-[0_18px_40px_-18px_rgb(0_0_0/0.8)]">
      <Tabs value={value} onValueChange={setValue} className="gap-0">
        <TabsList variant="line" aria-label="Client setup by format" className={listClass}>
          {formats.map((f) => (
            <TabsTrigger key={f.format} value={f.format} className={triggerClass}>
              {f.format}
            </TabsTrigger>
          ))}
        </TabsList>
        {formats.map((f) => (
          <TabsContent key={f.format} value={f.format} className="min-w-0">
            {f.files.map((file, i) => (
              <div key={file.file} className={cn("min-w-0", i > 0 && "border-t")}>
                <FileLabel className="bg-surface/60">{file.file}</FileLabel>
                <CodeHtml html={file.html} label={file.file} />
              </div>
            ))}
            <p className="border-t px-4 py-2 font-mono text-[11.5px] [overflow-wrap:anywhere] text-muted-foreground">{f.url}</p>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

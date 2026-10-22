"use client";

import { useEffect, useState } from "react";
import { cn } from "@weaver/ui/lib/utils";
import type { DocHeading } from "@/lib/docs";

/** "On this page": links to the page's headings, highlighting the one currently in view. */
export function DocsToc({ headings }: { headings: DocHeading[] }) {
  const [active, setActive] = useState<string | undefined>(headings[0]?.id);

  useEffect(() => {
    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = elements.find((element) => visible.has(element.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-72px 0px -60% 0px" },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;
  return (
    <nav aria-labelledby="docs-toc-heading" className="grid gap-1.5 text-[12.5px]">
      <h2 id="docs-toc-heading" className="mb-1 font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        On this page
      </h2>
      <ul className="grid gap-1.5">
        {headings.map((heading) => (
          <li key={heading.id} className={cn(heading.depth === 3 && "pl-3")}>
            <a
              href={`#${heading.id}`}
              aria-current={active === heading.id ? "location" : undefined}
              className={cn(
                "block rounded-sm leading-snug text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                active === heading.id && "text-foreground",
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

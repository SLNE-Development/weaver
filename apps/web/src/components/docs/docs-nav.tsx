"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@weaver/ui/lib/utils";
import type { DocNavGroup } from "@/lib/docs";

/** The docs navigation grouped by section; the current page is highlighted and marked `aria-current`. */
export function DocsNav({ groups, onNavigate }: { groups: DocNavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs" className="grid gap-6 text-[13.5px]">
      {groups.map((group) => (
        <div key={group.section} className="grid gap-px">
          <h2 className="px-2 pb-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            {group.section}
          </h2>
          <ul className="grid gap-px">
            {group.items.map((item) => {
              const active = pathname === item.path;
              return (
                <li key={item.path}>
                  <Link
                    href={item.path}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-2 py-1 text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                      active && "bg-accent font-medium text-foreground",
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

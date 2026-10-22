import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@weaver/ui/components/logo";
import { ThemeToggle } from "@weaver/ui/components/theme-toggle";
import { DocsMobileNav } from "@/components/docs/docs-mobile-nav";
import { DocsNav } from "@/components/docs/docs-nav";
import { DocsSearch } from "@/components/docs/docs-search";
import { env } from "@/env";
import { docNavigation, searchIndex } from "@/lib/docs";
import "./docs.css";

/** Shared metadata of every docs page; absolute URLs are based on `BETTER_AUTH_URL`. */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(env.BETTER_AUTH_URL),
    title: { template: "%s · Weaver", default: "Docs · Weaver" },
  };
}

/** The public docs shell: top bar with search and theme, section navigation on the left. */
export default async function DocsLayout({ children }: { children: ReactNode }) {
  const groups = docNavigation();
  const entries = await searchIndex();
  return (
    <div className="min-h-svh bg-background">
      <a
        href="#docs-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <DocsMobileNav groups={groups} />
          <div className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
            <Link href="/" className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              <Logo className="[&_svg]:size-6" />
              <span className="hidden sm:inline">Weaver</span>
            </Link>
            <span className="font-normal text-muted-foreground" aria-hidden="true">
              /
            </span>
            <Link href="/docs" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              Docs
            </Link>
          </div>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-2">
            <DocsSearch entries={entries} />
            <ThemeToggle />
            <Link
              href="/dashboard"
              className="hidden h-8 items-center rounded-md border px-3 text-[13px] font-medium transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 md:inline-flex"
            >
              Open app
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1400px] lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] overflow-y-auto border-r px-3 py-6 lg:block">
          <DocsNav groups={groups} />
        </aside>
        <main id="docs-content" className="min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}

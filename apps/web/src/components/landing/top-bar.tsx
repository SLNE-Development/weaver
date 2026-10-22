import Link from "next/link";
import { Button } from "@weaver/ui/components/button";
import { Logo } from "@weaver/ui/components/logo";
import { ThemeToggle } from "@weaver/ui/components/theme-toggle";
import { Container } from "./layout";

const linkClass = "rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

/** Sticky landing header: brand, Docs / Browse / Self-hosting, theme switch and Sign in. */
export function TopBar({ showBrowse }: { showBrowse: boolean }) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <Container className="flex h-14 items-center gap-4 sm:gap-6">
        <Link href="/" aria-label="Weaver home" className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
          <Logo variant="full" className="[&>span:last-child]:text-[15px]" />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-4 text-[13px] sm:gap-5">
          <Link href="/docs" className={linkClass}>
            Docs
          </Link>
          {showBrowse && (
            <Link href="/browse" className={linkClass}>
              Browse
            </Link>
          )}
          <a href="#self-hosting" className={`${linkClass} hidden sm:inline`}>
            Self-hosting
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          <Button asChild variant="outline" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </Container>
    </header>
  );
}

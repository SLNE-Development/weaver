import Link from "next/link";
import { Container } from "./layout";

const LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/docs/maven", label: "Maven" },
  { href: "/docs/npm", label: "npm" },
  { href: "/docs/docker", label: "Docker" },
  { href: "/docs/gradle", label: "proto" },
  { href: "/docs/self-host/compose", label: "Self-hosting" },
];

/** Instance host and doc links. */
export function Footer({ host }: { host: string }) {
  return (
    <footer>
      <Container className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-[18px] font-mono text-xs text-muted-foreground">
        <span>Weaver · {host}</span>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-[18px] gap-y-2">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </Container>
    </footer>
  );
}

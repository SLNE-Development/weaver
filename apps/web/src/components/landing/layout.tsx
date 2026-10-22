import type { ReactNode } from "react";
import { Badge } from "@weaver/ui/components/badge";
import { cn } from "@weaver/ui/lib/utils";

/** Centred page column with the landing gutters (16px on phones, 40px from lg). */
export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-10", className)}>{children}</div>;
}

/** Small uppercase mono label above headings. */
export function Eyebrow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        "mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] font-medium tracking-[0.1em] text-muted-foreground uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A full-width band with a hairline bottom border. */
export function Section({
  id,
  label,
  className,
  innerClassName,
  children,
}: {
  id?: string;
  /** Accessible name; pairs with the heading id when given. */
  label?: string;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={label} className={cn("scroll-mt-16 border-b", className)}>
      <Container className={cn("py-14 sm:py-16", innerClassName)}>{children}</Container>
    </section>
  );
}

/** Two-column section heading: eyebrow + title on the left, a short paragraph on the right. */
export function SectionHead({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <div className="mb-8 grid gap-4 md:grid-cols-2 md:items-end md:gap-10">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={id} className="text-2xl leading-[1.15] font-semibold tracking-[-0.025em] text-balance sm:text-[28px]">
          {title}
        </h2>
      </div>
      <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/** Release / snapshot pill as used across the app. */
export function KindPill({ kind, className }: { kind: "release" | "snapshot"; className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "px-2 py-px font-mono text-[11px]",
        kind === "release" ? "bg-release-soft text-release" : "bg-snapshot-soft text-snapshot",
        className,
      )}
    >
      {kind}
    </Badge>
  );
}

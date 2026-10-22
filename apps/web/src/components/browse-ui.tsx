import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
// The subpath keeps node-only parts of core (storage, database) out of client bundles.
import { isSnapshot } from "@weaver/core/coordinates";
import { Badge } from "@weaver/ui/components/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@weaver/ui/components/breadcrumb";
import { cn } from "@weaver/ui/lib/utils";
import { formatRelative, formatTimestamp } from "@/lib/browse";

/** Shared building blocks of the browse pages and the dashboard (server-renderable). */

/** Release (green) or snapshot (amber) tag for a version, by the registry's own (case-sensitive) rule. */
export function KindBadge({ version, className }: { version: string; className?: string }) {
  const snapshot = isSnapshot(version);
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-sm border-transparent px-1.5 py-0 font-mono text-[10px] tracking-wide uppercase",
        snapshot ? "bg-snapshot-soft text-snapshot" : "bg-release-soft text-release",
        className,
      )}
    >
      {snapshot ? "snapshot" : "release"}
    </Badge>
  );
}

/** Public / private tag for a repository. */
export function VisibilityBadge({ visibility }: { visibility: "public" | "private" }) {
  return (
    <Badge variant="outline" className="rounded-sm px-1.5 py-0 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
      {visibility}
    </Badge>
  );
}

/** A date as "5 minutes ago", with the exact UTC time on hover. */
export function RelativeTime({ date, className }: { date: Date; className?: string }) {
  return (
    <time dateTime={date.toISOString()} title={formatTimestamp(date)} className={cn("whitespace-nowrap", className)}>
      {formatRelative(date)}
    </time>
  );
}

/** One breadcrumb step; the last one has no `href`. */
export interface Crumb {
  label: string;
  href?: string;
  mono?: boolean;
}

/** Page frame of the browse pages: breadcrumbs, a title row with actions, then the content. */
export function PageHeader({
  crumbs,
  title,
  meta,
  actions,
}: {
  crumbs: Crumb[];
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b pb-4">
      <Breadcrumb>
        <BreadcrumbList className="text-xs">
          {crumbs.map((crumb, i) => (
            <span key={`${crumb.label}-${i}`} className="contents">
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem className={cn("min-w-0", crumb.mono && "font-mono")}>
                {crumb.href ? (
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href} className="truncate">
                      {crumb.label}
                    </Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </span>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="min-w-0 text-xl font-semibold tracking-tight break-words">{title}</h1>
          {meta && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Width and padding of every browse page. */
export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-6", className)}>{children}</div>;
}

/** A small uppercase section label with an optional count and trailing content. */
export function SectionTitle({ children, count, trailing }: { children: ReactNode; count?: number; trailing?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
        {children}
        {count !== undefined && <span className="font-mono text-foreground tabular-nums">{count}</span>}
      </h2>
      {trailing}
    </div>
  );
}

/** Bordered box around tables and lists (hairline, no shadow). */
export function Panel({ children, className, ...props }: { children: ReactNode; className?: string } & ComponentProps<"div">) {
  return (
    <div className={cn("overflow-hidden rounded-md border bg-card", className)} {...props}>
      {children}
    </div>
  );
}

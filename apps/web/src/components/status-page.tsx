import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { PageContainer } from "./browse-ui";

/** Centered empty state for not-found and error pages inside the app shell. */
export function StatusPage({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  /** Actions (buttons/links). */
  children?: ReactNode;
}) {
  return (
    <PageContainer className="min-h-[60svh] justify-center">
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>
            {title}
          </EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {children && <EmptyContent className="flex-row justify-center gap-2">{children}</EmptyContent>}
      </Empty>
    </PageContainer>
  );
}

/** Placeholder of an app page while its server data loads: header, a toolbar row and a table. */
export function PageSkeleton() {
  return (
    <PageContainer>
      <span className="sr-only" role="status">
        Loading…
      </span>
      <div className="flex flex-col gap-3 border-b pb-4">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-3 w-80 max-w-full" />
      </div>
      <Skeleton className="h-8 w-72 max-w-full" />
      <div className="flex flex-col gap-px overflow-hidden rounded-md border">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9 rounded-none" />
        ))}
      </div>
    </PageContainer>
  );
}

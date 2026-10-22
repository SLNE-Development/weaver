import type { ComponentProps } from "react";
import type { Format, Kind } from "@weaver/core";
import { Badge } from "@weaver/ui/components/badge";
import { cn } from "@weaver/ui/lib/utils";
import { formatLabel, kindLabel } from "@/lib/repository-settings";

/** The format of a repository as a small outlined chip, e.g. `npm`. */
export function FormatBadge({ format, className, ...props }: { format: Format } & Omit<ComponentProps<typeof Badge>, "children">) {
  return (
    <Badge variant="outline" className={cn("font-mono text-[11px]", className)} data-format={format} {...props}>
      {formatLabel(format)}
    </Badge>
  );
}

/** The kind of a repository (hosted, mirror, group) as muted text. */
export function KindLabel({ kind, className }: { kind: Kind; className?: string }) {
  return <span className={cn("text-xs text-muted-foreground", className)}>{kindLabel(kind)}</span>;
}

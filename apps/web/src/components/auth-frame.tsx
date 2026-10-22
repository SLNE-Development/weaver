import type { ReactNode } from "react";
import { Logo } from "@weaver/ui/components/logo";

const SAMPLE = [
  { coordinate: "dev.example:money", version: "1.4.0", kind: "release" },
  { coordinate: "dev.example:orders", version: "2.1.0-SNAPSHOT", kind: "snapshot" },
  { coordinate: "dev.example:common", version: "0.9.2", kind: "release" },
] as const;

/**
 * Page frame of the signed-out screens (login, invite) and the npm login authorization: a dark brand panel with the logo, the
 * product's purpose and a sample of what it serves, next to the actual form. On narrow screens the
 * panel shrinks to a header above the form.
 */
export function AuthFrame({
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Gives the form column room for wider forms (the npm login key form). */
  wide?: boolean;
}) {
  return (
    <div className="grid min-h-svh grid-rows-[auto_1fr] bg-background lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:grid-rows-1">
      {/* `dark` scopes the dark tokens to the panel, which is dark in both themes like the sidebar. */}
      <aside className="dark relative flex flex-col justify-between gap-10 overflow-hidden bg-sidebar px-6 py-6 text-sidebar-foreground sm:px-10 lg:py-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(var(--sidebar-border)_1px,transparent_1px),linear-gradient(90deg,var(--sidebar-border)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:radial-gradient(ellipse_at_top_left,black,transparent_70%)]"
        />
        <div className="relative">
          <Logo variant="full" className="[&>svg]:size-7" />
        </div>
        <div className="relative hidden max-w-md flex-col gap-6 lg:flex">
          <p className="text-2xl leading-snug font-medium tracking-tight text-balance text-sidebar-accent-foreground">
            One place for your team&apos;s .proto contracts, versioned like any other dependency.
          </p>
          <div className="rounded-md border border-sidebar-border bg-black/40 font-mono text-xs">
            <div className="border-b border-sidebar-border px-3 py-2 text-muted-foreground">$ weaver fetch</div>
            <ul className="flex flex-col gap-1.5 px-3 py-3">
              {SAMPLE.map((row) => (
                <li key={row.coordinate} className="grid grid-cols-[1fr_auto] items-baseline gap-4">
                  <span className="truncate text-sidebar-foreground">{row.coordinate}</span>
                  <span className={row.kind === "release" ? "text-release" : "text-snapshot"}>{row.version}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="relative hidden text-xs text-muted-foreground lg:block">Self-hosted repository manager for Maven, npm, Docker and proto</p>
      </aside>

      <main className="flex items-start justify-center px-4 py-12 sm:px-10 lg:items-center">
        <div className={wide ? "flex w-full max-w-2xl flex-col gap-8" : "flex w-full max-w-sm flex-col gap-8"}>
          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            <div className="text-sm text-muted-foreground">{description}</div>
          </div>
          {children}
          {footer && <div className="border-t pt-4 text-xs text-muted-foreground">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

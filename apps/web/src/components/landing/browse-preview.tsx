import { Logo } from "@weaver/ui/components/logo";
import { cn } from "@weaver/ui/lib/utils";
import { CodeHtml } from "./code-block";
import { highlight } from "./highlight";
import { KindPill, Section, SectionHead } from "./layout";
import { PROTO_FILES } from "./samples";

const NAV = ["Dashboard", "Browse", "Repositories", "API keys", "Users"];

const DETAILS: [string, string, boolean?][] = [
  ["Published", "14 Oct 2026"],
  ["By", "ci-economy"],
  ["Downloads", "1,204"],
  ["sha256", "9f2c…e41a", true],
];

const DEPENDENTS = ["protection-contracts:2.0.0", "shop-contracts:1.2.0", "quests-contracts:0.9.1"];

function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="px-3.5 pb-2 font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">{children}</h3>
  );
}

/**
 * A static picture of the app's proto version page (sidebar, files, viewer, details), built from the
 * same tokens. Columns drop away on narrower screens: sidebar below xl, file list below md.
 */
export async function BrowsePreview() {
  const money = PROTO_FILES[0];
  const html = await highlight(money.code, "proto", { lineNumbers: true });

  return (
    <Section label="browse-title">
      <SectionHead id="browse-title" eyebrow="Browse" title="A view that fits each format.">
        Maven artifacts, npm packages with their dist-tags, Docker tags with their platforms, Helm charts, signatures and
        SBOMs, and proto versions with a file viewer, like the one below.
      </SectionHead>
      <figure
        aria-label="Version page of dev.surf.economy:economy-contracts:1.4.0"
        className="grid min-h-[380px] overflow-hidden rounded-lg border md:grid-cols-[180px_minmax(0,1fr)] lg:grid-cols-[200px_minmax(0,1fr)_220px] xl:grid-cols-[160px_200px_minmax(0,1fr)_220px]"
      >
        <div aria-hidden="true" className="hidden content-start gap-0.5 bg-sidebar p-2.5 text-[13px] text-sidebar-foreground xl:grid">
          <div className="px-1.5 pt-0.5 pb-3">
            {/* The sidebar is dark in both themes: always show the inverted (white) tile. */}
            <Logo
              variant="full"
              className="[&_svg]:size-5 [&>span:last-child]:text-sm [&>svg:first-child]:hidden [&>svg:nth-of-type(2)]:block"
            />
          </div>
          {NAV.map((item) => (
            <div
              key={item}
              className={cn(
                "rounded-md px-2 py-[5px]",
                item === "Browse" ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/60",
              )}
            >
              {item}
            </div>
          ))}
        </div>

        <div className="hidden border-r py-3 md:block">
          <PanelHeading>Files · 3</PanelHeading>
          <ul className="font-mono text-[12.5px] leading-loose text-muted-foreground">
            <li className="truncate px-3.5">surf/economy/v1/</li>
            {PROTO_FILES.map((file, i) => (
              <li key={file.path} className={cn("truncate pr-3.5 pl-6", i === 0 && "bg-accent text-foreground")}>
                {file.path.split("/").at(-1)}
              </li>
            ))}
          </ul>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-4 py-[11px] font-mono text-xs text-muted-foreground">
            <span className="min-w-0 break-words">
              releases / dev.surf.economy / <b className="font-medium text-foreground">economy-contracts</b> /{" "}
              <b className="font-medium text-foreground">1.4.0</b>
            </span>
            <KindPill kind="release" className="ml-auto" />
          </div>
          <CodeHtml html={html} label="money.proto" />
        </div>

        <div className="grid content-start gap-[18px] border-t py-3 sm:grid-cols-3 md:col-span-2 lg:col-span-1 lg:grid-cols-1 lg:border-t-0 lg:border-l">
          <div>
            <PanelHeading>Details</PanelHeading>
            <dl className="grid gap-1.5 px-3.5 text-[12.5px]">
              {DETAILS.map(([label, value, mono]) => (
                <div key={label} className="flex justify-between gap-2.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className={cn("tabular-nums", mono && "font-mono")}>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <PanelHeading>Depends on</PanelHeading>
            <p className="truncate px-3.5 py-[3px] font-mono text-xs text-link">dev.surf.core:core-types:2.1.0</p>
          </div>
          <div>
            <PanelHeading>Dependents · 3</PanelHeading>
            <ul>
              {DEPENDENTS.map((d) => (
                <li key={d} className="truncate px-3.5 py-[3px] font-mono text-xs text-link">
                  {d}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </figure>
    </Section>
  );
}

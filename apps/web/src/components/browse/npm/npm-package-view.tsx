import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { CopyButton } from "@/components/copy-button";
import { Panel, RelativeTime, SectionTitle } from "@/components/browse-ui";
import { formatBytes } from "@/lib/browse";
import type { RouterOutputs } from "@/trpc/client";
import { Readme } from "./readme";

/** One npm package: description, dist-tags, install command, versions (newest first, deprecated marked) and README. */
export function NpmPackageView({ pkg }: { pkg: NonNullable<RouterOutputs["npm"]["package"]> }) {
  const install = `npm install ${pkg.name}`;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        {pkg.description && <p className="text-sm text-muted-foreground">{pkg.description}</p>}
        <section className="flex flex-col gap-2">
          <SectionTitle>Readme</SectionTitle>
          {pkg.readme ? <Readme markdown={pkg.readme} /> : <p className="text-sm text-muted-foreground">This package has no README stored.</p>}
        </section>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <section className="flex flex-col gap-2">
          <SectionTitle>Install</SectionTitle>
          <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{install}</code>
            <CopyButton text={install} label="Copy install command" toastText="Copied to clipboard" />
          </div>
        </section>
        {Object.keys(pkg.distTags).length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionTitle count={Object.keys(pkg.distTags).length}>Dist-tags</SectionTitle>
            <Panel>
              <Table>
                <TableBody>
                  {Object.entries(pkg.distTags).map(([tag, version]) => (
                    <TableRow key={tag}>
                      <TableCell className="pl-4 font-mono text-[13px]">{tag}</TableCell>
                      <TableCell className="pr-4 text-right font-mono text-[13px]">{version}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </section>
        )}
        <section className="flex flex-col gap-2">
          <SectionTitle count={pkg.versions.length}>Versions</SectionTitle>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Version</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="pr-4 text-right">Published</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pkg.versions.map((v) => (
                  <TableRow key={v.version}>
                    <TableCell className="pl-4 font-mono text-[13px]">
                      {v.version}
                      {v.deprecated !== null && (
                        <span className="ml-2 text-[11px] text-snapshot" title={v.deprecated}>
                          deprecated
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{v.size === null ? "-" : formatBytes(v.size)}</TableCell>
                    <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                      {v.publishedAt ? <RelativeTime date={new Date(v.publishedAt)} /> : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </section>
      </div>
    </div>
  );
}

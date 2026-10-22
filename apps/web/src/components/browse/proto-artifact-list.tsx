"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PackageIcon, SearchIcon } from "lucide-react";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@weaver/ui/components/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { KindBadge, Panel, RelativeTime } from "@/components/browse-ui";
import type { Kind } from "@weaver/core";
import { artifactHref, filterArtifacts, repositoryHref } from "@/lib/browse";
import type { RouterOutputs } from "@/trpc/client";

type Artifact = RouterOutputs["browse"]["artifacts"][number];

/** What an empty repository of each kind says. */
const EMPTY_TEXT: Record<Kind, string> = {
  hosted: "Publish to this repository from Gradle with publishProtos.",
  mirror: "Artifacts show up here once they have been fetched through this mirror.",
  group: "None of this group's members has artifacts yet.",
};

/** The artifacts of a proto repository, filtered by `?q=` on group or name. */
export function ProtoArtifactList({ repository, kind, artifacts }: { repository: string; kind: Kind; artifacts: Artifact[] }) {
  const q = useSearchParams().get("q")?.trim() ?? "";
  const shown = filterArtifacts(artifacts, q);
  const groups = new Set(shown.map((a) => a.group)).size;

  return (
    <>
      <form action={repositoryHref(repository)} className="flex max-w-md gap-2" role="search">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput key={q} name="q" defaultValue={q} placeholder="Filter by group or name" aria-label="Filter artifacts" />
        </InputGroup>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {shown.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageIcon />
            </EmptyMedia>
            <EmptyTitle>{q ? "No matching artifacts" : "No artifacts yet"}</EmptyTitle>
            <EmptyDescription>
              {q ? (
                <>
                  Nothing in <code>{repository}</code> matches <code>{q}</code>.{" "}
                  <Link href={repositoryHref(repository)}>Clear the filter</Link>
                </>
              ) : (
                EMPTY_TEXT[kind]
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Artifact</TableHead>
                <TableHead className="hidden sm:table-cell">Group</TableHead>
                <TableHead>Latest</TableHead>
                <TableHead className="hidden text-right md:table-cell">Versions</TableHead>
                <TableHead className="pr-4 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((a) => (
                <TableRow key={`${a.group}:${a.name}`}>
                  <TableCell className="max-w-0 pl-4">
                    <div className="flex min-w-0 flex-col">
                      <Link href={artifactHref(repository, a.group, a.name)} className="truncate font-mono text-[13px] font-medium hover:underline">
                        {a.name}
                      </Link>
                      <span className="truncate font-mono text-[11px] text-muted-foreground sm:hidden">{a.group}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{a.group}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        href={artifactHref(repository, a.group, a.name, a.latestVersion)}
                        className="font-mono text-[13px] hover:underline"
                        aria-label={`${a.name} ${a.latestVersion}`}
                      >
                        {a.latestVersion}
                      </Link>
                      <KindBadge version={a.latestVersion} className="hidden sm:inline-flex" />
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{a.versionCount}</TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                    <RelativeTime date={a.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="border-t bg-surface px-4 py-1.5 text-[11px] text-muted-foreground">
            {shown.length} {shown.length === 1 ? "artifact" : "artifacts"} in {groups} {groups === 1 ? "group" : "groups"}
            {q && ` matching “${q}”`}
          </p>
        </Panel>
      )}
    </>
  );
}

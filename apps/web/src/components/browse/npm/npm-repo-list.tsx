"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PackageIcon, SearchIcon } from "lucide-react";
import type { Kind } from "@weaver/core";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@weaver/ui/components/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@weaver/ui/components/tabs";
import { CopyButton } from "@/components/copy-button";
import { Panel, RelativeTime, SectionTitle } from "@/components/browse-ui";
import { repositoryHref } from "@/lib/browse";
import { npmPackageHref, type NpmClientConfig } from "@/lib/npm-config";
import { useTRPC } from "@/trpc/client";

/** What the list receives from the server wrapper. */
export interface NpmRepoListProps {
  repository: string;
  kind: Kind;
  /** Whether a mirror stores what it fetches; null for other kinds. */
  cacheEnabled: boolean | null;
  config: NpmClientConfig;
}

/** Shown for a mirror that does not store what it fetches. */
const UNCACHED_TEXT = "Packages of this mirror live upstream. Weaver stores nothing while caching is off.";

/** One client configuration file with a copy action. */
function ConfigBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border bg-card">
      <div className="flex h-9 items-center gap-2 border-b bg-surface px-3">
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{title}</div>
        <CopyButton text={code} label={`Copy ${title}`} toastText="Copied to clipboard" />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-6">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Package list (25 per page, name search), group members, mirror hint and client configuration tabs. */
export function NpmRepoList({ repository, kind, cacheEnabled, config }: NpmRepoListProps) {
  const trpc = useTRPC();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(0);
  const query = useQuery(trpc.npm.packages.queryOptions({ repo: repository, query: search || undefined, cursor }));
  const page = query.data;
  const mirrorUncached = kind === "mirror" && cacheEnabled !== true;

  return (
    <>
      {page?.members && page.members.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionTitle count={page.members.length}>Members</SectionTitle>
          <ol className="flex flex-wrap gap-2">
            {page.members.map((m, i) => (
              <li key={m}>
                <Link href={repositoryHref(m)} className="rounded-md border px-2 py-1 font-mono text-xs hover:underline">
                  {i + 1}. {m}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      <form
        className="flex max-w-md gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(0);
          setSearch(draft.trim());
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search packages by name" aria-label="Search packages by name" />
        </InputGroup>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {query.isError ? (
        <p className="text-sm text-destructive">Could not load the packages.</p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : page!.items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageIcon />
            </EmptyMedia>
            <EmptyTitle>{search ? "No matching packages" : "No packages yet"}</EmptyTitle>
            <EmptyDescription>
              {mirrorUncached
                ? UNCACHED_TEXT
                : search
                  ? `Nothing stored matches ${search}.`
                  : kind === "hosted"
                    ? "Publish to this repository with npm publish."
                    : "Packages show up here once they have been stored."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {mirrorUncached && <p className="text-xs text-muted-foreground">{UNCACHED_TEXT}</p>}
          <Panel>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Package</TableHead>
                  <TableHead>Latest</TableHead>
                  <TableHead className="hidden md:table-cell">Description</TableHead>
                  <TableHead className="pr-4 text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page!.items.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell className="pl-4">
                      <Link href={npmPackageHref(repository, p.name)} className="font-mono text-[13px] font-medium hover:underline">
                        {p.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-[13px]">{p.latest ?? "-"}</TableCell>
                    <TableCell className="hidden max-w-80 truncate text-xs text-muted-foreground md:table-cell">{p.description}</TableCell>
                    <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                      <RelativeTime date={p.updatedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
          <div className="flex gap-2">
            <Button variant="outline" disabled={cursor === 0} onClick={() => setCursor(Math.max(0, cursor - 25))}>
              Previous
            </Button>
            <Button variant="outline" disabled={page!.nextCursor === null} onClick={() => setCursor(page!.nextCursor ?? cursor)}>
              Next
            </Button>
          </div>
        </>
      )}

      <section className="flex flex-col gap-3">
        <SectionTitle>Use this repository</SectionTitle>
        <p className="text-xs text-muted-foreground">
          The token is read from <code className="text-foreground">WEAVER_TOKEN</code>. Public repositories can be read without one.
        </p>
        <Tabs defaultValue="npmrc">
          <TabsList>
            <TabsTrigger value="npmrc">.npmrc</TabsTrigger>
            <TabsTrigger value="yarnrc">.yarnrc.yml</TabsTrigger>
            <TabsTrigger value="bunfig">bunfig.toml</TabsTrigger>
          </TabsList>
          <TabsContent value="npmrc">
            <ConfigBlock title=".npmrc (npm, pnpm, yarn classic)" code={config.npmrc} />
          </TabsContent>
          <TabsContent value="yarnrc">
            <ConfigBlock title=".yarnrc.yml (yarn berry)" code={config.yarnrc} />
          </TabsContent>
          <TabsContent value="bunfig">
            <ConfigBlock title="bunfig.toml (bun)" code={config.bunfig} />
          </TabsContent>
        </Tabs>
      </section>
    </>
  );
}

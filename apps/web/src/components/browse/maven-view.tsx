"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PackageIcon, SearchIcon } from "lucide-react";
import type { Kind } from "@weaver/core";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@weaver/ui/components/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { CopyButton } from "@/components/copy-button";
import { Panel, RelativeTime, SectionTitle } from "@/components/browse-ui";
import { formatBytes, repositoryHref } from "@/lib/browse";
import { gradleKotlinSnippet, mavenPomSnippet, mavenSettingsXml, type MavenSnippetInput } from "@/lib/maven-snippets";
import { useTRPC, type RouterOutputs } from "@/trpc/client";

/** What the Maven view receives from its server wrapper. */
export interface MavenViewProps {
  repository: string;
  /** The public base URL of Weaver. */
  url: string;
  isPrivate: boolean;
  overview: RouterOutputs["maven"]["overview"];
}

/** The link to a level of the Maven browse view (`?g=&a=&v=`). */
function levelHref(repository: string, g?: string, a?: string, v?: string): string {
  const params = new URLSearchParams();
  if (g) params.set("g", g);
  if (a) params.set("a", a);
  if (v) params.set("v", v);
  const query = params.toString();
  return query ? `${repositoryHref(repository)}?${query}` : repositoryHref(repository);
}

/** Plain code block with a copy action; the snippets depend on the browsed level, so they render in the client. */
function SnippetBlock({ title, code }: { title: string; code: string }) {
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

/** The three client snippets (`settings.xml`, `pom.xml`, `build.gradle.kts`) for the current level. */
function Snippets({ input }: { input: MavenSnippetInput }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Use this repository</SectionTitle>
      <p className="text-xs text-muted-foreground">
        Authenticate with HTTP Basic: any username and an access token as the password, here read from <code className="text-foreground">WEAVER_TOKEN</code>.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <SnippetBlock title="settings.xml" code={mavenSettingsXml(input)} />
        <SnippetBlock title="pom.xml" code={mavenPomSnippet(input)} />
      </div>
      <SnippetBlock title="build.gradle.kts" code={gradleKotlinSnippet(input)} />
    </section>
  );
}

/** A centered empty state. */
function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PackageIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** What an empty repository of each kind says. */
const EMPTY_TEXT: Record<Kind, string> = {
  hosted: "Deploy to this repository with mvn deploy or Gradle publish.",
  mirror: "Artifacts show up here once they have been fetched through this mirror.",
  group: "None of this group's members has artifacts yet.",
};

/** Level 1: the artifacts, with a filter on the groupId prefix. */
function ArtifactList({ props }: { props: MavenViewProps }) {
  const trpc = useTRPC();
  const [draft, setDraft] = useState("");
  const [prefix, setPrefix] = useState("");
  const query = useQuery(trpc.maven.artifacts.queryOptions({ repository: props.repository, groupPrefix: prefix || undefined }));
  const artifacts = query.data ?? [];
  return (
    <>
      <form
        className="flex max-w-md gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPrefix(draft.trim());
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Filter by groupId prefix" aria-label="Filter by groupId prefix" />
        </InputGroup>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      {query.isError ? (
        <p className="text-sm text-destructive">Could not load the artifacts.</p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : artifacts.length === 0 ? (
        <EmptyState title={prefix ? "No matching artifacts" : "No artifacts yet"}>{prefix ? `Nothing under ${prefix}.` : EMPTY_TEXT[props.overview.kind]}</EmptyState>
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
              {artifacts.map((a) => (
                <TableRow key={`${a.groupId}:${a.artifactId}`}>
                  <TableCell className="pl-4">
                    <Link href={levelHref(props.repository, a.groupId, a.artifactId)} className="font-mono text-[13px] font-medium hover:underline">
                      {a.artifactId}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{a.groupId}</TableCell>
                  <TableCell>
                    <Link href={levelHref(props.repository, a.groupId, a.artifactId, a.latestVersion)} className="font-mono text-[13px] hover:underline">
                      {a.latestVersion}
                    </Link>
                  </TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{a.versionCount}</TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                    <RelativeTime date={a.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </>
  );
}

/** Level 2: the versions of one artifact, newest first. */
function VersionList({ props, g, a }: { props: MavenViewProps; g: string; a: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.maven.versions.queryOptions({ repository: props.repository, groupId: g, artifactId: a }));
  const versions = query.data ?? [];
  return (
    <>
      <SectionTitle count={query.data?.length}>
        <span className="font-mono normal-case">
          {g}:{a}
        </span>
      </SectionTitle>
      {query.isError ? (
        <p className="text-sm text-destructive">Could not load the versions.</p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : versions.length === 0 ? (
        <EmptyState title="No such artifact">Nothing is stored for this groupId and artifactId.</EmptyState>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Version</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Downloads</TableHead>
                <TableHead className="pr-4 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.version}>
                  <TableCell className="pl-4">
                    <Link href={levelHref(props.repository, g, a, v.version)} className="font-mono text-[13px] hover:underline">
                      {v.version}
                    </Link>
                    {v.snapshot && <span className="ml-2 text-[11px] text-muted-foreground">snapshot</span>}
                  </TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">{v.downloadCount}</TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                    <RelativeTime date={v.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </>
  );
}

/** Level 3: the files of one version with download links, sizes and SHA-1 checksums. */
function FileList({ props, g, a, v }: { props: MavenViewProps; g: string; a: string; v: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.maven.files.queryOptions({ repository: props.repository, groupId: g, artifactId: a, version: v }));
  const files = query.data ?? [];
  return (
    <>
      <SectionTitle
        count={query.data?.length}
        trailing={<CopyButton text={`${g}:${a}:${v}`} label="Copy coordinate" toastText="Coordinate copied" size="icon-sm" />}
      >
        <span className="font-mono normal-case">
          {g}:{a}:{v}
        </span>
      </SectionTitle>
      {query.isError ? (
        <p className="text-sm text-destructive">Could not load the files.</p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : files.length === 0 ? (
        <EmptyState title="No files">Nothing is stored for this version.</EmptyState>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">File</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="hidden md:table-cell">SHA-1</TableHead>
                <TableHead className="pr-4 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((f) => (
                <TableRow key={f.path}>
                  <TableCell className="pl-4">
                    <a href={f.url} download className="font-mono text-[13px] hover:underline">
                      {f.name}
                    </a>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatBytes(f.size)}</TableCell>
                  <TableCell className="hidden max-w-0 truncate font-mono text-[11px] text-muted-foreground md:table-cell">{f.sha1}</TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                    <RelativeTime date={f.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </>
  );
}

/**
 * The Maven browse view. The search parameters `g`, `a` and `v` pick the level: all artifacts,
 * the versions of one artifact, or the files of one version. Groups list their members and
 * mirrors without a cache say that nothing is kept to browse; every level shows the client snippets.
 */
export function MavenView(props: MavenViewProps) {
  const params = useSearchParams();
  const g = params.get("g")?.trim() || undefined;
  const a = params.get("a")?.trim() || undefined;
  const v = params.get("v")?.trim() || undefined;
  const { overview } = props;
  const snippet: MavenSnippetInput = {
    url: props.url,
    repo: props.repository,
    isPrivate: props.isPrivate,
    versionPolicy: overview.versionPolicy,
    coordinate: g && a && v ? { groupId: g, artifactId: a, version: v } : undefined,
  };

  return (
    <>
      {overview.kind === "group" && (
        <section className="flex flex-col gap-2">
          <SectionTitle count={overview.members.length}>Members, searched in order</SectionTitle>
          <ol className="flex flex-wrap gap-2">
            {overview.members.map((member, i) => (
              <li key={member} className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{i + 1}</span>
                <Link href={repositoryHref(member)} className="font-mono hover:underline">
                  {member}
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}
      {overview.kind === "mirror" && overview.cacheEnabled === false && (
        <p className="rounded-md border bg-surface px-3 py-2 text-sm text-muted-foreground">
          Caching is off for this mirror, so every request goes to the upstream and nothing is stored here to browse. Turn caching on in the repository settings to
          list what clients fetch.
        </p>
      )}
      {g && a && v ? (
        <>
          <Link href={levelHref(props.repository, g, a)} className="text-xs text-muted-foreground hover:underline">
            All versions of {a}
          </Link>
          <FileList props={props} g={g} a={a} v={v} />
        </>
      ) : g && a ? (
        <>
          <Link href={levelHref(props.repository)} className="text-xs text-muted-foreground hover:underline">
            All artifacts
          </Link>
          <VersionList props={props} g={g} a={a} />
        </>
      ) : (
        <ArtifactList props={props} />
      )}
      <Snippets input={snippet} />
    </>
  );
}

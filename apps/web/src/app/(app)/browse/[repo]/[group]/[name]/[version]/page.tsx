import type { Metadata } from "next";
import Link from "next/link";
import { cache, type ReactNode } from "react";
import { DownloadIcon } from "lucide-react";
import { isSnapshot } from "@weaver/core/coordinates";
import { Button } from "@weaver/ui/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@weaver/ui/components/tabs";
import { KindBadge, PageContainer, PageHeader, Panel, RelativeTime } from "@/components/browse-ui";
import { CopyButton } from "@/components/copy-button";
import { DeleteVersionDialog } from "@/components/delete-version-dialog";
import { FileTree } from "@/components/file-tree";
import { ProtoViewer } from "@/components/proto-viewer";
import { UsageSnippet } from "@/components/usage-snippet";
import { VersionActions } from "@/components/version-actions";
import { env } from "@/env";
import { archiveHref, artifactHref, artifactMetadataInput, buildFileTree, firstFile, formatBytes, formatTimestamp, gradleSnippet, repositoryHref } from "@/lib/browse";
import { pageMetadata } from "@/lib/seo";
import { orNotFound } from "@/server/page-data";
import { requirePageAccess } from "@/server/session";
import { api } from "@/trpc/server";

type Params = { repo: string; group: string; name: string; version: string };

/** The version as `browse.version` returns it, loaded once per request for metadata and page. */
const loadVersion = cache((repository: string, coordinate: string) => api.browse.version({ repository, coordinate }));

/**
 * Title, description, canonical URL and share card. Public artifacts are indexable with the
 * artifact OG image; private ones (or ones the visitor can't see) get `noindex` and the generic card.
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { repo, group, name, version } = await params;
  let input: ReturnType<typeof artifactMetadataInput>;
  try {
    const [info, repositories] = await Promise.all([loadVersion(repo, `${group}:${name}:${version}`), api.browse.repositories()]);
    input = artifactMetadataInput({
      repository: repo,
      group,
      name,
      version,
      visibility: repositories.find((r) => r.name === repo)?.visibility ?? null,
      fileCount: info.files.length,
      dependencyCount: info.dependencies.length,
    });
  } catch {
    input = artifactMetadataInput({ repository: repo, group, name, version, visibility: null });
  }
  return pageMetadata(input);
}

/** A coordinate string split into its parts. */
function parts(coordinate: string): [string, string, string] {
  return coordinate.split(":") as [string, string, string];
}

/**
 * Where each dependency can be browsed: the first readable repository that holds the artifact
 * (dependencies are coordinates without a repository). `null` when the visitor can't see one.
 */
async function locateDependencies(dependencies: string[]): Promise<Map<string, string | null>> {
  const located = await Promise.all(
    dependencies.map(async (dep) => {
      const [group, name] = parts(dep);
      const { hits } = await api.search.query({ q: `${group}:${name}`, format: "proto", limit: 20 }).catch(() => ({ hits: [] }));
      // Only a hosted repository the visitor reads directly has an artifact page of its own.
      const hit = hits.find((h) => h.namespace === group && h.name === name && h.via === null && h.kind === "hosted");
      return [dep, hit?.repository ?? null] as const;
    }),
  );
  return new Map(located);
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-4 py-2.5 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{n}</span>;
}

/**
 * A version of an artifact: files with the proto viewer, dependencies, dependents, snapshot
 * builds, details and usage snippets. Maintainers and admins can delete it.
 */
export default async function VersionPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ file?: string | string[] }>;
}) {
  const [{ repo, group, name, version }, query] = await Promise.all([params, searchParams]);
  const path = artifactHref(repo, group, name, version);
  const { user } = await requirePageAccess(path);
  const coordinate = `${group}:${name}:${version}`;
  const info = await orNotFound(loadVersion(repo, coordinate), path);

  const tree = buildFileTree(info.files);
  const requested = Array.isArray(query.file) ? query.file[0] : query.file;
  const selected = requested && info.files.includes(requested) ? requested : firstFile(tree);
  const canDelete = user !== null && user.role !== "viewer";
  const [file, dependencyRepos, versionCount] = await Promise.all([
    selected ? api.browse.file({ repository: repo, coordinate, path: selected }) : null,
    locateDependencies(info.dependencies),
    // Only needed to know where to go after deleting the last version.
    canDelete ? api.browse.versions({ repository: repo, group, name }).then((v) => v.length) : 0,
  ]);

  const snapshot = isSnapshot(version);
  const snippet = { url: env.BETTER_AUTH_URL, repository: repo, coordinate };
  const archiveUrl = archiveHref(repo, group, name, version);
  const fileHref = (filePath: string) => `${path}?file=${encodeURIComponent(filePath)}`;

  return (
    <PageContainer>
      <PageHeader
        crumbs={[
          { label: "Browse", href: "/browse" },
          { label: repo, href: repositoryHref(repo), mono: true },
          { label: `${group}:${name}`, href: artifactHref(repo, group, name), mono: true },
          { label: version, mono: true },
        ]}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono">
              <span className="text-muted-foreground">{group}:</span>
              {name}
              <span className="text-muted-foreground">:</span>
              {version}
            </span>
            <KindBadge version={version} />
          </span>
        }
        meta={
          <>
            <span>
              in{" "}
              <Link href={repositoryHref(repo)} className="font-mono text-foreground hover:underline">
                {repo}
              </Link>
            </span>
            {snapshot && <span className="font-mono">build #{info.buildNumber}</span>}
            <span>
              published <RelativeTime date={info.createdAt} />
              {info.publishedBy && <> by {info.publishedBy}</>}
            </span>
            <span className="font-mono">{formatBytes(info.sizeBytes)}</span>
            <span className="font-mono">
              {info.downloadCount.toLocaleString("en")} {info.downloadCount === 1 ? "download" : "downloads"}
            </span>
          </>
        }
        actions={
          <>
            <VersionActions coordinate={coordinate} gradle={gradleSnippet(snippet)} />
            <Button asChild variant="outline" size="sm">
              <a href={archiveUrl} download>
                <DownloadIcon />
                Archive
              </a>
            </Button>
            {canDelete && (
              <DeleteVersionDialog
                repository={repo}
                coordinate={coordinate}
                buildCount={info.builds.length}
                isAdmin={user.role === "admin"}
                lastVersion={versionCount === 1}
              />
            )}
          </>
        }
      />

      <Tabs defaultValue="files" className="gap-4">
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <TabsList variant="line" className="w-max border-b-0">
            <TabsTrigger value="files">
              Files <Count n={info.files.length} />
            </TabsTrigger>
            <TabsTrigger value="dependencies">
              Dependencies <Count n={info.dependencies.length} />
            </TabsTrigger>
            <TabsTrigger value="dependents">
              Dependents <Count n={info.dependents.length} />
            </TabsTrigger>
            {snapshot && (
              <TabsTrigger value="builds">
                Builds <Count n={info.builds.length} />
              </TabsTrigger>
            )}
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="files">
          <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
            <Panel className="max-h-72 self-start overflow-y-auto md:sticky md:top-4 md:max-h-[calc(100svh-8rem)]">
              <FileTree nodes={tree} selected={selected ?? ""} hrefFor={fileHref} />
            </Panel>
            {file ? (
              <ProtoViewer repository={repo} coordinate={coordinate} sha256={info.sha256} path={file.path} content={file.content} />
            ) : (
              <Panel className="px-4 py-8 text-center text-sm text-muted-foreground">This version has no files.</Panel>
            )}
          </div>
        </TabsContent>

        <TabsContent value="dependencies">
          <Panel>
            {info.dependencies.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No dependencies.</p>
            ) : (
              <ul className="divide-y">
                {info.dependencies.map((dep) => {
                  const where = dependencyRepos.get(dep) ?? null;
                  const [g, n, v] = parts(dep);
                  return (
                    <li key={dep} className="flex items-center gap-3 px-4 py-2">
                      {where ? (
                        <Link href={artifactHref(where, g, n, v)} className="min-w-0 flex-1 truncate font-mono text-[13px] text-link hover:underline">
                          {dep}
                        </Link>
                      ) : (
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{dep}</span>
                      )}
                      <KindBadge version={v} />
                      <span className="w-28 truncate text-right font-mono text-xs text-muted-foreground">{where ?? "not visible"}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="dependents">
          <Panel>
            {info.dependents.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing you can see depends on this version.</p>
            ) : (
              <ul className="divide-y">
                {info.dependents.map((d) => {
                  const [g, n, v] = parts(d.coordinate);
                  return (
                    <li key={`${d.repository}/${d.coordinate}`} className="flex items-center gap-3 px-4 py-2">
                      <Link href={artifactHref(d.repository, g, n, v)} className="min-w-0 flex-1 truncate font-mono text-[13px] text-link hover:underline">
                        {d.coordinate}
                      </Link>
                      <KindBadge version={v} />
                      <span className="w-28 truncate text-right font-mono text-xs text-muted-foreground">{d.repository}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </TabsContent>

        {snapshot && (
          <TabsContent value="builds">
            <Panel>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Build</TableHead>
                    <TableHead>sha256</TableHead>
                    <TableHead className="pr-4 text-right">Published</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...info.builds]
                    .sort((a, b) => b.buildNumber - a.buildNumber)
                    .map((b) => (
                      <TableRow key={b.buildNumber}>
                        <TableCell className="pl-4 font-mono">
                          #{b.buildNumber}
                          {b.buildNumber === info.buildNumber && <span className="ml-2 text-[11px] text-muted-foreground">latest</span>}
                        </TableCell>
                        <TableCell className="max-w-0">
                          <div className="flex min-w-0 items-center gap-1">
                            <span className="truncate font-mono text-xs text-muted-foreground" title={b.sha256}>
                              {b.sha256}
                            </span>
                            <CopyButton text={b.sha256} label={`Copy sha256 of build ${b.buildNumber}`} />
                          </div>
                        </TableCell>
                        <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                          <RelativeTime date={b.createdAt} />
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </Panel>
          </TabsContent>
        )}

        <TabsContent value="details">
          <Panel>
            <dl className="divide-y">
              <DetailRow label="Coordinate">
                <span className="flex items-center gap-1">
                  <code className="truncate text-[13px]">{coordinate}</code>
                  <CopyButton text={coordinate} label="Copy coordinate" />
                </span>
              </DetailRow>
              <DetailRow label="Repository">
                <Link href={repositoryHref(repo)} className="font-mono text-[13px] text-link hover:underline">
                  {repo}
                </Link>
              </DetailRow>
              <DetailRow label="sha256">
                <span className="flex items-center gap-1">
                  <code className="min-w-0 text-xs break-all text-muted-foreground">{info.sha256}</code>
                  <CopyButton text={info.sha256} label="Copy sha256" />
                </span>
              </DetailRow>
              <DetailRow label="Size">
                <span className="font-mono text-[13px]">
                  {formatBytes(info.sizeBytes)} · {info.files.length} {info.files.length === 1 ? "file" : "files"}
                </span>
              </DetailRow>
              {snapshot && (
                <DetailRow label="Build">
                  <span className="font-mono text-[13px]">
                    #{info.buildNumber} of {info.builds.length}
                  </span>
                </DetailRow>
              )}
              <DetailRow label="Publisher">{info.publishedBy ?? <span className="text-muted-foreground">unknown</span>}</DetailRow>
              <DetailRow label="Downloads">
                <span className="font-mono text-[13px] tabular-nums">{info.downloadCount.toLocaleString("en")}</span>
              </DetailRow>
              <DetailRow label="Created">
                <span className="font-mono text-[13px]">{formatTimestamp(info.createdAt)}</span>
              </DetailRow>
            </dl>
          </Panel>
        </TabsContent>

        <TabsContent value="usage">
          <UsageSnippet repository={repo} coordinate={coordinate} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

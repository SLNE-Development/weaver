import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, BoxesIcon, KeyRoundIcon, PackageIcon, PlusIcon, type LucideIcon } from "lucide-react";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { KindBadge, PageContainer, Panel, RelativeTime, SectionTitle, VisibilityBadge } from "@/components/browse-ui";
import { artifactHref, repositoryHref } from "@/lib/browse";
import { requirePageAccess } from "@/server/session";
import { api } from "@/trpc/server";
import { FormatBadge } from "../repositories/_components/format-badge";

export const metadata: Metadata = { title: "Dashboard" };

function Stat({ label, value, testId, hint }: { label: string; value: number; testId: string; hint?: string }) {
  return (
    <div data-testid={testId} className="flex flex-col gap-1 bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span data-slot="stat-value" className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
        {value.toLocaleString("en")}
      </span>
      {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function QuickLink({ href, icon: Icon, title, text }: { href: string; icon: LucideIcon; title: string; text: string }) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{text}</span>
      </span>
      <ArrowRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

/**
 * Dashboard: totals over the repositories the visitor may browse, the newest publishes, the
 * repositories with their sizes and shortcuts to the common next steps for the visitor's role.
 */
export default async function DashboardPage() {
  const { user } = await requirePageAccess("/dashboard");
  const [stats, repositories] = await Promise.all([api.dashboard.stats(), api.browse.repositories()]);
  const latest = stats.recentPublishes[0];
  const topRepositories = [...repositories].sort((a, b) => b.versionCount - a.versionCount).slice(0, 6);

  return (
    <PageContainer>
      <header className="flex flex-col gap-1 border-b pb-4">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {user ? `Welcome back, ${user.name}.` : "Public repositories of this Weaver."}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border lg:grid-cols-4">
        <Stat label="Repositories" value={stats.repositories} testId="stat-repositories" />
        <Stat label="Artifacts" value={stats.artifacts} testId="stat-artifacts" />
        <Stat label="Versions" value={stats.versions} testId="stat-versions" />
        <div data-testid="stat-latest" className="flex min-w-0 flex-col gap-1 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Last publish</span>
          {latest ? (
            <>
              <RelativeTime date={latest.createdAt} className="text-2xl font-semibold tracking-tight" />
              <span className="truncate font-mono text-[11px] text-muted-foreground">{latest.coordinate}</span>
            </>
          ) : (
            <span className="text-2xl font-semibold tracking-tight text-muted-foreground">—</span>
          )}
        </div>
      </div>

      {stats.repositories === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>No repositories yet</EmptyTitle>
            <EmptyDescription>
              {user?.role === "admin"
                ? "Create a repository, then publish to it from Gradle with an API key."
                : "Nothing you can browse has been published yet."}
            </EmptyDescription>
          </EmptyHeader>
          {user?.role === "admin" && (
            <EmptyContent>
              <Button asChild size="sm">
                <Link href="/repositories?create=1">
                  <PlusIcon />
                  Create repository
                </Link>
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="flex min-w-0 flex-col gap-2">
            <SectionTitle count={stats.recentPublishes.length}>Recent publishes</SectionTitle>
            <Panel data-testid="recent-publishes">
              {stats.recentPublishes.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing has been published yet.</p>
              ) : (
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">Artifact</TableHead>
                      <TableHead className="hidden w-28 sm:table-cell">Repository</TableHead>
                      <TableHead className="hidden w-32 md:table-cell">Published by</TableHead>
                      <TableHead className="w-28 pr-4 text-right">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.recentPublishes.map((publish) => {
                      const [group, name, version] = publish.coordinate.split(":") as [string, string, string];
                      return (
                        <TableRow key={`${publish.repository}/${publish.coordinate}#${publish.buildNumber}`}>
                          <TableCell className="pl-4">
                            <div className="flex min-w-0 items-center gap-2">
                              <Link
                                href={artifactHref(publish.repository, group, name, version)}
                                className="min-w-0 truncate font-mono text-[13px] hover:underline"
                              >
                                {publish.coordinate}
                              </Link>
                              <KindBadge version={version} />
                              {publish.buildNumber > 1 && (
                                <span className="font-mono text-[11px] text-muted-foreground">#{publish.buildNumber}</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                            <Link href={repositoryHref(publish.repository)} className="hover:text-foreground hover:underline">
                              {publish.repository}
                            </Link>
                          </TableCell>
                          <TableCell className="hidden truncate text-xs text-muted-foreground md:table-cell">
                            {publish.publishedBy ?? "—"}
                          </TableCell>
                          <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                            <RelativeTime date={publish.createdAt} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </Panel>
          </section>

          <div className="flex min-w-0 flex-col gap-6">
            <section className="flex flex-col gap-2">
              <SectionTitle
                count={repositories.length}
                trailing={
                  <Link href="/browse" className="text-xs text-link hover:underline">
                    Browse all
                  </Link>
                }
              >
                Repositories
              </SectionTitle>
              <Panel>
                <ul className="divide-y">
                  {topRepositories.map((repo) => (
                    <li key={repo.name}>
                      <Link
                        href={repositoryHref(repo.name)}
                        className="flex items-center gap-2 px-4 py-2 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{repo.name}</span>
                        <FormatBadge format={repo.format} />
                        <VisibilityBadge visibility={repo.visibility} />
                        {/* Artifact and version counts exist for proto repositories only. */}
                        <span className="w-20 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                          {repo.format === "proto" ? `${repo.artifactCount} / ${repo.versionCount}` : "—"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="border-t bg-surface px-4 py-1.5 text-right text-[11px] text-muted-foreground">proto artifacts / versions</p>
              </Panel>
            </section>

            <section className="flex flex-col gap-2">
              <SectionTitle>Quick links</SectionTitle>
              <Panel className="divide-y">
                <QuickLink href="/browse" icon={PackageIcon} title="Browse artifacts" text="Repositories, versions and proto files" />
                {user && (
                  <QuickLink href="/keys?create=1" icon={KeyRoundIcon} title="Create an API key" text="For Gradle and the weaver CLI" />
                )}
                {user?.role === "admin" && (
                  <QuickLink href="/repositories?create=1" icon={PlusIcon} title="Create a repository" text="Hosted, mirror or group, for any format" />
                )}
              </Panel>
            </section>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

import Link from "next/link";
import { LayersIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { SectionTitle, VisibilityBadge } from "@/components/browse-ui";
import { UsageSnippet } from "@/components/usage-snippet";
import { repositoryHref } from "@/lib/browse";
import type { BrowseRepo } from "@/server/trpc/routers/browse";
import { api } from "@/trpc/server";
import { KindLabel } from "@/app/(app)/repositories/_components/format-badge";

/**
 * The browse view of a proto group: its members in the order the group searches them, each linked
 * to its own browse page, and the client setup that resolves through the group.
 */
export async function ProtoGroupView({ repo }: { repo: BrowseRepo }) {
  const members = await api.browse.protoMembers({ repository: repo.name });

  return (
    <>
      <section className="flex flex-col gap-2">
        <SectionTitle count={members.length}>Members, searched in order</SectionTitle>
        {members.length > 0 ? (
          <ol data-testid="group-members" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {members.map((member, i) => (
              <li key={member.name} className="flex min-w-0 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <Link href={repositoryHref(member.name)} className="truncate font-mono hover:underline">
                  {member.name}
                </Link>
                <KindLabel kind={member.kind} />
                <VisibilityBadge visibility={member.visibility} />
              </li>
            ))}
          </ol>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayersIcon />
              </EmptyMedia>
              <EmptyTitle>No members to show</EmptyTitle>
              <EmptyDescription>This group has no members you can browse.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <SectionTitle>Use this group</SectionTitle>
        <UsageSnippet repository={repo.name} />
      </section>
    </>
  );
}

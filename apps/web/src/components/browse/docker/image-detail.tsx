"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { CopyButton } from "@/components/copy-button";
import { Panel, RelativeTime, SectionTitle } from "@/components/browse-ui";
import { formatBytes } from "@/lib/browse";
import { useTRPC } from "@/trpc/client";
import { DockerEmpty, Platforms, ShortDigest, dockerHref } from "./docker-repo-view";

/** The tags of one image: digest, platforms, size, when the tag moved and when it was last pulled. */
export function ImageDetail({ repository, image }: { repository: string; image: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.docker.tags.queryOptions({ repo: repository, image }));
  const tags = query.data ?? [];
  return (
    <>
      <SectionTitle count={query.data?.length} trailing={<CopyButton text={`${repository}/${image}`} label="Copy image name" toastText="Image name copied" size="icon-sm" />}>
        <span className="font-mono normal-case">{image}</span>
      </SectionTitle>
      {query.isError ? (
        <p className="text-sm text-destructive">Could not load the tags.</p>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tags.length === 0 ? (
        <DockerEmpty title="No tags">This image has no tags; untagged manifests can still be pulled by digest.</DockerEmpty>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Tag</TableHead>
                <TableHead>Digest</TableHead>
                <TableHead className="hidden md:table-cell">Platforms</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
                <TableHead className="hidden text-right lg:table-cell">Last pulled</TableHead>
                <TableHead className="pr-4 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tags.map((t) => (
                <TableRow key={t.tag} data-testid="docker-tag-row">
                  <TableCell className="pl-4 font-mono text-[13px] font-medium">{t.tag}</TableCell>
                  <TableCell>
                    <Link href={dockerHref(repository, image, t.digest)} className="hover:underline">
                      <ShortDigest digest={t.digest} />
                    </Link>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Platforms platforms={t.platforms} />
                  </TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular-nums sm:table-cell">{formatBytes(t.totalSize)}</TableCell>
                  <TableCell className="hidden text-right text-xs text-muted-foreground lg:table-cell">
                    {t.lastPulledAt ? <RelativeTime date={t.lastPulledAt} /> : "never"}
                  </TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                    <RelativeTime date={t.updatedAt} />
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

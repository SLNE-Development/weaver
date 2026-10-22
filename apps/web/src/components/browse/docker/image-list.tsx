"use client";

import Link from "next/link";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import type { Kind } from "@weaver/core";
import { Button } from "@weaver/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@weaver/ui/components/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { Panel, RelativeTime } from "@/components/browse-ui";
import { formatBytes } from "@/lib/browse";
import { useTRPC } from "@/trpc/client";
import { DockerEmpty, dockerHref } from "./docker-repo-view";

/** What an empty repository of each kind says. */
const EMPTY_TEXT: Record<Kind, string> = {
  hosted: "Push an image with docker push to see it here.",
  mirror: "Images cached by this mirror aren't listed here; pull them through the mirror.",
  group: "Browse the members to see their images.",
};

/** The images of a docker repository, with a name filter and paging. */
export function ImageList({ repository, kind }: { repository: string; kind: Kind }) {
  const trpc = useTRPC();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const images = useInfiniteQuery(
    trpc.docker.images.infiniteQueryOptions({ repo: repository, query: query || undefined }, { getNextPageParam: (last) => last.next ?? undefined }),
  );
  const items = images.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <form
        className="flex max-w-md gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Filter images" aria-label="Filter images" />
        </InputGroup>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      {images.isError ? (
        <p className="text-sm text-destructive">Could not load the images.</p>
      ) : images.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <DockerEmpty title={query ? "No matching images" : "No images yet"}>{query ? `No image name contains ${query}.` : EMPTY_TEXT[kind]}</DockerEmpty>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Image</TableHead>
                <TableHead className="text-right">Tags</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Manifests</TableHead>
                <TableHead className="hidden text-right md:table-cell">Size</TableHead>
                <TableHead className="pr-4 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.image}>
                  <TableCell className="pl-4">
                    <Link href={dockerHref(repository, i.image)} className="font-mono text-[13px] font-medium hover:underline">
                      {i.image}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{i.tagCount}</TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">{i.manifestCount}</TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular-nums md:table-cell">{formatBytes(i.totalSize)}</TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                    <RelativeTime date={i.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
      {images.hasNextPage && (
        <Button variant="outline" className="self-start" disabled={images.isFetchingNextPage} onClick={() => void images.fetchNextPage()}>
          {images.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </>
  );
}

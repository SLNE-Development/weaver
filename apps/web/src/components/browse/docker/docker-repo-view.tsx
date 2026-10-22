"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { ContainerIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { SectionTitle } from "@/components/browse-ui";
import { repositoryHref } from "@/lib/browse";
import type { RouterOutputs } from "@/trpc/client";
import { DockerSnippets, type DockerSnippetRepo } from "./docker-snippets";
import { ImageDetail } from "./image-detail";
import { ImageList } from "./image-list";
import { ManifestDetail } from "./manifest-detail";

/** The link to a level of the docker browse view (`?image=&digest=`). */
export function dockerHref(repository: string, image?: string, digest?: string): string {
  const params = new URLSearchParams();
  if (image) params.set("image", image);
  if (digest) params.set("digest", digest);
  const query = params.toString();
  return query ? `${repositoryHref(repository)}?${query}` : repositoryHref(repository);
}

/** A platform as docker writes it: `os/architecture[/variant]`. */
export function platformText(p: { os: string; architecture: string; variant?: string }): string {
  return [p.os, p.architecture, p.variant].filter(Boolean).join("/");
}

/** The platforms of a manifest as small mono chips; a dash when none is known. */
export function Platforms({ platforms }: { platforms: Array<{ os: string; architecture: string; variant?: string }> }) {
  if (platforms.length === 0) return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {platforms.map((p) => (
        <span key={platformText(p)} className="rounded border bg-surface px-1.5 font-mono text-[11px]">
          {platformText(p)}
        </span>
      ))}
    </span>
  );
}

/** A digest shortened to its algorithm and first 12 hex characters, with the full digest as tooltip. */
export function ShortDigest({ digest }: { digest: string }) {
  const [alg, hex = ""] = digest.split(":");
  return (
    <span title={digest} className="font-mono text-xs">
      {alg}:{hex.slice(0, 12)}
    </span>
  );
}

/** A centered empty state. */
export function DockerEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ContainerIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** What the docker view receives from its server wrapper. */
export interface DockerRepoViewProps {
  repo: DockerSnippetRepo;
  /** The public base URL of Weaver. */
  url: string;
  overview: RouterOutputs["docker"]["overview"];
}

/**
 * The docker browse view. The search parameters `image` and `digest` pick the level: all images, the tags of
 * one image, or one manifest. Groups list their members' browse links and mirrors say that their content lives
 * upstream; every level shows the client snippets.
 */
export function DockerRepoView({ repo, url, overview }: DockerRepoViewProps) {
  const params = useSearchParams();
  const image = params.get("image")?.trim() || undefined;
  const digest = params.get("digest")?.trim() || undefined;

  if (overview.kind === "group") {
    return (
      <>
        <section className="flex flex-col gap-2">
          <SectionTitle count={overview.members.length}>Members, searched in order</SectionTitle>
          <p className="text-sm text-muted-foreground">A group serves its members&apos; images; browse a member to see them.</p>
          <ol className="flex flex-wrap gap-2">
            {overview.members.map((member, i) => (
              <li key={member} className="flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{i + 1}</span>
                <Link href={dockerHref(member, image)} className="font-mono hover:underline">
                  {member}
                </Link>
              </li>
            ))}
          </ol>
        </section>
        <DockerSnippets url={url} repo={repo} image={image} />
      </>
    );
  }

  return (
    <>
      {overview.kind === "mirror" && (
        <p className="rounded-md border bg-surface px-3 py-2 text-sm text-muted-foreground">
          Content of this repository lives upstream; Weaver shows only what it stores. Cached images aren&apos;t listed here.
        </p>
      )}
      {!(overview.kind === "mirror" && overview.cacheEnabled === false) &&
        (image && digest ? (
          <>
            <Link href={dockerHref(repo.name, image)} className="text-xs text-muted-foreground hover:underline">
              All tags of {image}
            </Link>
            <ManifestDetail repository={repo.name} image={image} digest={digest} />
          </>
        ) : image ? (
          <>
            <Link href={dockerHref(repo.name)} className="text-xs text-muted-foreground hover:underline">
              All images
            </Link>
            <ImageDetail repository={repo.name} image={image} />
          </>
        ) : (
          <ImageList repository={repo.name} kind={overview.kind} />
        ))}
      <DockerSnippets url={url} repo={repo} image={image} tag={digest} />
    </>
  );
}

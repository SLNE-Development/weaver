"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { artifactTypeLabel, isIndexMediaType } from "@weaver/docker/client";
import { Badge } from "@weaver/ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { CopyButton } from "@/components/copy-button";
import { Panel, RelativeTime, SectionTitle } from "@/components/browse-ui";
import { formatBytes } from "@/lib/browse";
import { useTRPC } from "@/trpc/client";
import { DockerEmpty, Platforms, ShortDigest, dockerHref, platformText } from "./docker-repo-view";

/**
 * One manifest: its type, platforms, sizes and tags, then its layers (or the child manifests of an index,
 * linking to each) and the artifacts attached to it (signatures, SBOMs, Helm charts) through the referrers API.
 */
export function ManifestDetail({ repository, image, digest }: { repository: string; image: string; digest: string }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.docker.manifest.queryOptions({ repo: repository, image, digest }));
  if (query.isError) return <p className="text-sm text-destructive">Could not load the manifest.</p>;
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const m = query.data;
  if (!m) return <DockerEmpty title="No such manifest">This image stores no manifest with that digest.</DockerEmpty>;
  const isIndex = isIndexMediaType(m.mediaType);
  return (
    <>
      <SectionTitle trailing={<CopyButton text={m.digest} label="Copy digest" toastText="Digest copied" size="icon-sm" />}>
        <span className="font-mono normal-case">
          {image}@<ShortDigest digest={m.digest} />
        </span>
      </SectionTitle>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Type</dt>
        <dd>
          <Badge variant="outline">{isIndex ? "multi-platform index" : artifactTypeLabel(m.artifactType)}</Badge>
          <span className="ml-2 font-mono text-xs text-muted-foreground">{m.mediaType}</span>
        </dd>
        <dt className="text-muted-foreground">Digest</dt>
        <dd className="font-mono text-xs break-all">{m.digest}</dd>
        {m.platforms.length > 0 && (
          <>
            <dt className="text-muted-foreground">Platforms</dt>
            <dd>
              <Platforms platforms={m.platforms} />
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Size</dt>
        <dd className="font-mono text-xs">
          {formatBytes(m.totalSize)} <span className="text-muted-foreground">(manifest {formatBytes(m.size)})</span>
        </dd>
        <dt className="text-muted-foreground">Tags</dt>
        <dd className="font-mono text-xs">{m.tags.length > 0 ? m.tags.join(", ") : "untagged"}</dd>
        <dt className="text-muted-foreground">Pushed</dt>
        <dd className="text-xs">
          <RelativeTime date={m.createdAt} />
        </dd>
      </dl>

      <SectionTitle count={m.refs.length}>{isIndex ? "Platform manifests" : "Config and layers"}</SectionTitle>
      <Panel>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">{isIndex ? "Platform" : "Media type"}</TableHead>
              <TableHead>Digest</TableHead>
              <TableHead className="pr-4 text-right">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {m.refs.map((r) => (
              <TableRow key={r.digest}>
                <TableCell className="pl-4 font-mono text-xs">{r.kind === "manifest" ? (r.attestation ? "build attestation" : r.platform ? platformText(r.platform) : r.mediaType) : r.mediaType}</TableCell>
                <TableCell>
                  {r.kind === "manifest" ? (
                    <Link href={dockerHref(repository, image, r.digest)} className="hover:underline">
                      <ShortDigest digest={r.digest} />
                    </Link>
                  ) : (
                    <ShortDigest digest={r.digest} />
                  )}
                </TableCell>
                <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">{formatBytes(r.size)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <SectionTitle count={m.referrers.length}>Attached artifacts</SectionTitle>
      {m.referrers.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is attached. Signatures (cosign), SBOMs and other artifacts pushed with this manifest as subject show up here.</p>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Type</TableHead>
                <TableHead>Digest</TableHead>
                <TableHead className="pr-4 text-right">Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.referrers.map((r) => (
                <TableRow key={r.digest}>
                  <TableCell className="pl-4">
                    <Badge variant="outline">{artifactTypeLabel(r.artifactType ?? null)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Link href={dockerHref(repository, image, r.digest)} className="hover:underline">
                      <ShortDigest digest={r.digest} />
                    </Link>
                  </TableCell>
                  <TableCell className="pr-4 text-right font-mono text-xs tabular-nums">{formatBytes(r.size)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
    </>
  );
}

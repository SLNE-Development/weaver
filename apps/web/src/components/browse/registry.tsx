import { Suspense, type ReactNode } from "react";
import type { Format } from "@weaver/core";
import type { BrowseRepo as Repo } from "@/server/trpc/routers/browse";
import { env } from "@/env";
import { api } from "@/trpc/server";
import { DockerRepoView } from "./docker/docker-repo-view";
import { MavenView } from "./maven-view";
import { NpmRepoView } from "./npm/npm-repo-view";
import { ProtoArtifactList } from "./proto-artifact-list";
import { ProtoGroupView } from "./proto-group-view";
import { ProtoMirrorView } from "./proto-mirror-view";

/**
 * The package page link of each format (`BROWSE_LINKS`) and of a search hit (`packageHref`).
 * They live in `./links` so client components can import them without this module's server
 * imports; a format with a package page adds its builder there.
 */
export { BROWSE_LINKS, packageHref } from "./links";

/** The browse view of a hosted proto repository: its artifacts with a `?q=` filter. */
async function ProtoHostedView({ repo }: { repo: Repo }) {
  const artifacts = await api.browse.artifacts({ repository: repo.name });
  return (
    <>
      <p className="-mt-3 font-mono text-xs text-muted-foreground">
        {artifacts.length} artifacts · {artifacts.reduce((sum, a) => sum + a.versionCount, 0)} versions
      </p>
      <Suspense>
        <ProtoArtifactList repository={repo.name} kind={repo.kind} artifacts={artifacts} />
      </Suspense>
    </>
  );
}

/** The proto browse view of each repository kind: artifacts (hosted), the cache (mirror) or the members (group). */
function ProtoRepositoryView({ repo }: { repo: Repo }) {
  switch (repo.kind) {
    case "hosted":
      return <ProtoHostedView repo={repo} />;
    case "mirror":
      return <ProtoMirrorView repo={repo} />;
    case "group":
      return <ProtoGroupView repo={repo} />;
  }
}

/** The Maven browse view: the server fetches the overview, the client view browses by the g, a and v search params. */
async function MavenRepositoryView({ repo }: { repo: Repo }) {
  const overview = await api.maven.overview({ repository: repo.name });
  return (
    <Suspense>
      <MavenView repository={repo.name} url={env.BETTER_AUTH_URL.replace(/\/+$/, "")} isPrivate={repo.visibility === "private"} overview={overview} />
    </Suspense>
  );
}

/** The docker browse view: the server fetches the overview, the client view browses by the image and digest search params. */
async function DockerRepositoryView({ repo }: { repo: Repo }) {
  const overview = await api.docker.overview({ repo: repo.name });
  return (
    <Suspense>
      <DockerRepoView repo={{ name: repo.name, kind: repo.kind, dockerRoot: repo.dockerRoot }} url={env.BETTER_AUTH_URL.replace(/\/+$/, "")} overview={overview} />
    </Suspense>
  );
}

/**
 * The browse view of each format, rendered by `/browse/[repo]` below the common header. A format
 * without an entry shows a "not available yet" empty state; each format plan adds its entry.
 */
export const BROWSE_VIEWS: Partial<Record<Format, (props: { repo: Repo }) => ReactNode>> = {
  docker: DockerRepositoryView,
  maven: MavenRepositoryView,
  npm: NpmRepoView,
  proto: ProtoRepositoryView,
};

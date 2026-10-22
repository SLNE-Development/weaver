import type { BrowseRepo as Repo } from "@/server/trpc/routers/browse";
import { env } from "@/env";
import { npmClientConfig } from "@/lib/npm-config";
import { NpmRepoList } from "./npm-repo-list";

/**
 * The npm browse view of `/browse/[repo]`: the package list with search, the member list of a group, and the
 * `.npmrc`, `.yarnrc.yml` and `bunfig.toml` snippets that point a client at the repository.
 */
export function NpmRepoView({ repo }: { repo: Repo }) {
  const config = npmClientConfig(env.BETTER_AUTH_URL, repo.name);
  return <NpmRepoList repository={repo.name} kind={repo.kind} cacheEnabled={repo.cacheEnabled} config={config} />;
}

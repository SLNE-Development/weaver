import type { Repo, RepoService } from "@weaver/core";
import { DockerError } from "./errors.js";

/** Where a docker request lands: the repository, the image path inside it and the name the client sent. */
export interface Target {
  repo: Repo;
  /** The image name relative to the repository. */
  image: string;
  /** The repository name exactly as the client sent it. */
  name: string;
}

/**
 * Resolves a client image name: a docker repository named by the first segment (the rest is the image),
 * otherwise the docker root mirror with the full name. Null when neither exists (`NAME_UNKNOWN`);
 * throws `NAME_INVALID` when only a repository name is given.
 */
export async function resolveTarget(repos: Pick<RepoService, "get" | "dockerRoot">, name: string): Promise<Target | null> {
  const slash = name.indexOf("/");
  const first = slash < 0 ? name : name.slice(0, slash);
  const repo = await repos.get(first);
  if (repo && repo.format === "docker") {
    if (slash < 0) throw new DockerError(400, "NAME_INVALID", "image name needs a repository prefix and an image", { name });
    return { repo, image: name.slice(slash + 1), name };
  }
  const root = await repos.dockerRoot();
  return root ? { repo: root, image: name, name } : null;
}

import { isValidGroup, isValidName, isValidRepositoryName, isValidVersion, type Registry } from "@weaver/core";
import type { OgCardInput } from "./og";

/** Shown for private, unknown or malformed artifacts: names nothing, so it can't confirm a private artifact exists. */
export const GENERIC_ARTIFACT_CARD: OgCardInput = {
  eyebrow: "Artifact",
  title: "Weaver",
  subtitle: "Maven, npm, Docker and proto repositories in one place.",
};

export interface ArtifactCardParams {
  repo: string;
  group: string;
  name: string;
  /** An exact version, or `latest` for the newest release (newest snapshot if there is none). */
  version: string;
}

const ANONYMOUS = { kind: "anonymous" } as const;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Content of an artifact share card. Reads as an anonymous visitor, so only public repositories
 * are described (the same rule as anonymous REST reads); everything else gets the generic card.
 */
export async function artifactCard(
  registry: Pick<Registry, "listVersions" | "getManifest">,
  params: ArtifactCardParams,
): Promise<OgCardInput> {
  const repo = decode(params.repo);
  const group = decode(params.group);
  const name = decode(params.name);
  const requested = decode(params.version);
  const isLatest = requested === "latest";
  if (
    !isValidRepositoryName(repo) ||
    !isValidGroup(group) ||
    !isValidName(name) ||
    (!isLatest && !isValidVersion(requested))
  ) {
    return GENERIC_ARTIFACT_CARD;
  }
  try {
    let version = requested;
    if (isLatest) {
      const versions = await registry.listVersions(ANONYMOUS, repo, group, name);
      const chosen = versions.find((v) => !v.isSnapshot) ?? versions[0];
      if (!chosen) return GENERIC_ARTIFACT_CARD;
      version = chosen.version;
    }
    const info = await registry.getManifest(ANONYMOUS, repo, { group, name, version });
    const snapshot = version.endsWith("-SNAPSHOT");
    return {
      eyebrow: `${info.repository} · ${group}${isLatest ? " · latest" : ""}`,
      title: name,
      subtitle: `${group}:${name}:${version}`,
      subtitleMono: true,
      badge: snapshot
        ? { label: `Snapshot · build ${info.buildNumber}`, tone: "snapshot" }
        : { label: "Release", tone: "release" },
      meta: [plural(info.files.length, "file", "files"), plural(info.dependencies.length, "dependency", "dependencies")],
    };
  } catch {
    // not_found for private and unknown alike, or the database being down: never explain which.
    return GENERIC_ARTIFACT_CARD;
  }
}

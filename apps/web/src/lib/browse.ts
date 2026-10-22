/** Pure helpers of the artifact browser: paths, usage snippets, the file tree and formatting. */

/** The browse page of a repository. */
export function repositoryHref(repository: string): string {
  return `/browse/${encodeURIComponent(repository)}`;
}

/** The page of an artifact, or of one of its versions when `version` is given. */
export function artifactHref(repository: string, group: string, name: string, version?: string): string {
  const base = `${repositoryHref(repository)}/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
  return version === undefined ? base : `${base}/${encodeURIComponent(version)}`;
}

/** The REST download URL of a version's archive. */
export function archiveHref(repository: string, group: string, name: string, version: string): string {
  const [r, g, n, v] = [repository, group, name, version].map(encodeURIComponent);
  return `/api/v1/repos/${r}/artifacts/${g}/${n}/${v}/archive`;
}

/**
 * What a usage snippet needs: the public base URL, the repository (hosted, mirror or group) and,
 * for a version's snippet, the `group:name:version`. Without a coordinate the snippet sets up the
 * repository only.
 */
export interface SnippetInput {
  url: string;
  repository: string;
  coordinate?: string;
}

/** Gradle (Kotlin DSL) setup with the Weaver plugin: the repository, and the artifact or a commented template. */
export function gradleSnippet({ url, repository, coordinate }: SnippetInput): string {
  return [
    "weaver {",
    `    url = "${url}"`,
    '    token = providers.environmentVariable("WEAVER_TOKEN")',
    `    repositories("${repository}")`,
    "}",
    "",
    "dependencies {",
    coordinate === undefined ? '    // weaver("group:name:version")' : `    weaver("${coordinate}")`,
    "}",
  ].join("\n");
}

/** A `weaver.json` for `weaver fetch` that fetches into `./protos`: the artifact, or no dependencies yet. */
export function weaverJsonSnippet({ url, repository, coordinate }: SnippetInput): string {
  return JSON.stringify({ url, repositories: [repository], dependencies: coordinate === undefined ? [] : [coordinate], outDir: "./protos" }, null, 2);
}

/** A node of a version's file tree. Folder names may span several path segments (collapsed chains). */
export type FileTreeNode =
  | { kind: "file"; name: string; path: string }
  | { kind: "folder"; name: string; path: string; children: FileTreeNode[] };

interface MutableFolder {
  folders: Map<string, MutableFolder>;
  files: string[];
}

function toNodes(folder: MutableFolder, prefix: string): FileTreeNode[] {
  const folders = [...folder.folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([segment, child]): FileTreeNode => {
      // Collapse folders that only hold a single folder ("dev/example/v1" instead of three levels).
      let name = segment;
      let current = child;
      while (current.files.length === 0 && current.folders.size === 1) {
        const [nextName, next] = [...current.folders.entries()][0]!;
        name = `${name}/${nextName}`;
        current = next;
      }
      const path = prefix + name;
      return { kind: "folder", name, path, children: toNodes(current, `${path}/`) };
    });
  const files = [...folder.files]
    .sort((a, b) => a.localeCompare(b))
    .map((name): FileTreeNode => ({ kind: "file", name, path: prefix + name }));
  return [...folders, ...files];
}

/** Turns relative file paths into a tree: folders before files, each sorted by name. */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: MutableFolder = { folders: new Map(), files: [] };
  for (const path of paths) {
    const segments = path.split("/");
    const file = segments.pop()!;
    let folder = root;
    for (const segment of segments) {
      let next = folder.folders.get(segment);
      if (!next) {
        next = { folders: new Map(), files: [] };
        folder.folders.set(segment, next);
      }
      folder = next;
    }
    folder.files.push(file);
  }
  return toNodes(root, "");
}

/** The first file of the tree in display order, or `null` for an empty tree. */
export function firstFile(nodes: FileTreeNode[]): string | null {
  for (const node of nodes) {
    if (node.kind === "file") return node.path;
    const inner = firstFile(node.children);
    if (inner) return inner;
  }
  return null;
}

/** The artifacts whose `group:name` contains `q` (case-insensitive); all of them for an empty `q`. */
export function filterArtifacts<T extends { group: string; name: string }>(artifacts: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (needle === "") return artifacts;
  return artifacts.filter((a) => `${a.group}:${a.name}`.toLowerCase().includes(needle));
}

/** Human-readable size in binary units. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `${(bytes / 1024 ** 4).toFixed(1)} TiB`;
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "5 minutes ago", "yesterday", … relative to `now`; under a minute is "just now". */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** Absolute timestamp for tooltips, in UTC so server and client agree. */
export function formatTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The site-wide share card (the root `opengraph-image`), used where an artifact card would disclose too much. */
export const GENERIC_SHARE_IMAGE = "/opengraph-image";

const GENERIC_DESCRIPTION = "Protobuf artifacts on this Weaver.";
const PRIVATE_DESCRIPTION = "Protobuf artifacts in a private repository.";

/** The `pageMetadata()` input of a browse page. */
export interface ArtifactMetadataInput {
  title: string;
  description: string;
  path: string;
  image?: string;
  noindex?: boolean;
}

/**
 * Metadata of a version page. Public artifacts get an indexable page with the artifact share
 * card; private ones (and versions the visitor can't see, `visibility: null`) stay out of search
 * engines and get the generic card, with a description that names nothing.
 */
export function artifactMetadataInput(input: {
  repository: string;
  group: string;
  name: string;
  version: string;
  visibility: "public" | "private" | null;
  fileCount?: number;
  dependencyCount?: number;
}): ArtifactMetadataInput {
  const { repository, group, name, version, visibility } = input;
  const path = artifactHref(repository, group, name, version);
  if (visibility === null) {
    return { title: "Artifact", description: GENERIC_DESCRIPTION, path, image: GENERIC_SHARE_IMAGE, noindex: true };
  }
  const coordinate = `${group}:${name}:${version}`;
  if (visibility === "private") {
    return { title: coordinate, description: PRIVATE_DESCRIPTION, path, image: GENERIC_SHARE_IMAGE, noindex: true };
  }
  const files = input.fileCount ?? 0;
  const deps = input.dependencyCount ?? 0;
  const parts = [
    `${files} proto ${files === 1 ? "file" : "files"}`,
    deps > 0 ? `${deps} ${deps === 1 ? "dependency" : "dependencies"}` : "no dependencies",
  ];
  return {
    title: coordinate,
    description: `${coordinate} in the ${repository} repository: ${parts.join(", ")}. Fetch it with Gradle or the weaver CLI.`,
    path,
    image: `/og/artifact/${[repository, group, name, version].map(encodeURIComponent).join("/")}`,
  };
}

/**
 * Metadata of a repository page (no `group`/`name`) or an artifact page. Public pages are
 * indexable; private ones and pages the visitor can't see get `noindex` and a description that
 * names nothing. All of them use the generic share card.
 */
export function listingMetadataInput(input: {
  repository: string;
  group?: string;
  name?: string;
  visibility: "public" | "private" | null;
  description?: string | null;
}): ArtifactMetadataInput {
  const { repository, group, name, visibility } = input;
  const artifact = group !== undefined && name !== undefined;
  const path = artifact ? artifactHref(repository, group, name) : repositoryHref(repository);
  const image = GENERIC_SHARE_IMAGE;
  if (visibility === null) {
    return { title: artifact ? "Artifact" : "Repository", description: GENERIC_DESCRIPTION, path, image, noindex: true };
  }
  const title = artifact ? `${group}:${name}` : repository;
  if (visibility === "private") return { title, description: PRIVATE_DESCRIPTION, path, image, noindex: true };
  const description = artifact
    ? `Versions of ${title} in the ${repository} repository, with proto files and usage for Gradle and the weaver CLI.`
    : `${input.description ? `${input.description}. ` : ""}Protobuf artifacts in the ${repository} repository.`;
  return { title, description, path, image };
}

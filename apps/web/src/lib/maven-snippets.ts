/** What the Maven client snippets need to know about a repository (and optionally an artifact). */
export interface MavenSnippetInput {
  /** The public base URL of Weaver, without a trailing slash. */
  url: string;
  repo: string;
  isPrivate: boolean;
  /** The hosted repository's version policy, or null for mirrors and groups (no publishing). */
  versionPolicy: "release" | "snapshot" | "mixed" | null;
  coordinate?: { groupId: string; artifactId: string; version: string };
}

/** The client-facing repository URL, `<url>/maven/<repo>/`. */
function repositoryUrl({ url, repo }: MavenSnippetInput): string {
  return `${url.replace(/\/+$/, "")}/maven/${repo}/`;
}

/** The Gradle repository name of a Weaver repository: `weaver` plus PascalCase of its alphanumeric runs. */
export function gradleRepositoryName(repo: string): string {
  const runs = repo.match(/[A-Za-z0-9]+/g) ?? [];
  return "weaver" + runs.map((run) => run.charAt(0).toUpperCase() + run.slice(1)).join("");
}

/** A `settings.xml` with the `<server>` entry that carries the access token (any username works). */
export function mavenSettingsXml(i: MavenSnippetInput): string {
  return [
    "<settings>",
    "  <servers>",
    "    <server>",
    `      <id>weaver-${i.repo}</id>`,
    "      <username>token</username>",
    "      <password>${env.WEAVER_TOKEN}</password>",
    "    </server>",
    "  </servers>",
    "</settings>",
  ].join("\n");
}

/** `pom.xml` fragments: the `<repositories>` entry, deployment targets for hosted repositories, and the dependency. */
export function mavenPomSnippet(i: MavenSnippetInput): string {
  const id = `weaver-${i.repo}`;
  const url = repositoryUrl(i);
  const lines = ["<repositories>", "  <repository>", `    <id>${id}</id>`, `    <url>${url}</url>`, "  </repository>", "</repositories>"];
  if (i.versionPolicy !== null) {
    lines.push("", "<distributionManagement>");
    if (i.versionPolicy !== "snapshot") lines.push("  <repository>", `    <id>${id}</id>`, `    <url>${url}</url>`, "  </repository>");
    if (i.versionPolicy !== "release") lines.push("  <snapshotRepository>", `    <id>${id}</id>`, `    <url>${url}</url>`, "  </snapshotRepository>");
    lines.push("</distributionManagement>");
  }
  if (i.coordinate) {
    const { groupId, artifactId, version } = i.coordinate;
    lines.push(
      "",
      "<dependency>",
      `  <groupId>${groupId}</groupId>`,
      `  <artifactId>${artifactId}</artifactId>`,
      `  <version>${version}</version>`,
      "</dependency>",
    );
  }
  return lines.join("\n");
}

/** `build.gradle.kts` fragments: the resolving repository, a `publishing` block for hosted repositories, and the dependency. */
export function gradleKotlinSnippet(i: MavenSnippetInput): string {
  const name = gradleRepositoryName(i.repo);
  const url = repositoryUrl(i);
  const lines = ["repositories {", `    maven("${url}") {`, `        name = "${name}"`];
  if (i.isPrivate) lines.push("        credentials(PasswordCredentials::class)");
  lines.push("    }", "}");
  if (i.versionPolicy !== null) {
    lines.push(
      "",
      "publishing {",
      "    repositories {",
      `        maven("${url}") {`,
      `            name = "${name}"`,
      "            credentials(PasswordCredentials::class)",
      "        }",
      "    }",
      "}",
    );
  }
  if (i.coordinate) {
    const { groupId, artifactId, version } = i.coordinate;
    lines.push("", "dependencies {", `    implementation("${groupId}:${artifactId}:${version}")`, "}");
  }
  return lines.join("\n");
}

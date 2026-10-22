import { describe, expect, it } from "vitest";
import { gradleKotlinSnippet, gradleRepositoryName, mavenPomSnippet, mavenSettingsXml, type MavenSnippetInput } from "./maven-snippets";

const base: MavenSnippetInput = { url: "https://weaver.slne.dev", repo: "releases", isPrivate: true, versionPolicy: "release" };

describe("maven snippets", () => {
  it("names the gradle repository after the Weaver repository", () => {
    expect(gradleRepositoryName("my-releases")).toBe("weaverMyReleases");
    expect(gradleRepositoryName("releases")).toBe("weaverReleases");
  });

  it("builds the kotlin snippet with credentials and publishing for a private hosted repo", () => {
    const code = gradleKotlinSnippet(base);
    expect(code).toContain('maven("https://weaver.slne.dev/maven/releases/")');
    expect(code).toContain('name = "weaverReleases"');
    expect(code).toContain("credentials(PasswordCredentials::class)");
    expect(code).toContain("publishing {");
  });

  it("leaves credentials and publishing out for a public mirror or group", () => {
    const code = gradleKotlinSnippet({ ...base, isPrivate: false, versionPolicy: null });
    expect(code).not.toContain("credentials");
    expect(code).not.toContain("publishing");
  });

  it("adds the dependency when a coordinate is given", () => {
    const code = gradleKotlinSnippet({ ...base, coordinate: { groupId: "org.example", artifactId: "lib", version: "1.0" } });
    expect(code).toContain('implementation("org.example:lib:1.0")');
  });

  it("builds settings.xml with the token server", () => {
    const xml = mavenSettingsXml(base);
    expect(xml).toContain("<id>weaver-releases</id>");
    expect(xml).toContain("${env.WEAVER_TOKEN}");
  });

  it("deploys snapshots to the snapshotRepository only for a snapshot policy", () => {
    const pom = mavenPomSnippet({ ...base, versionPolicy: "snapshot", coordinate: { groupId: "org.example", artifactId: "lib", version: "1.0-SNAPSHOT" } });
    const dm = pom.slice(pom.indexOf("<distributionManagement>"), pom.indexOf("</distributionManagement>"));
    expect(dm).toContain("<snapshotRepository>");
    expect(dm).not.toContain("<repository>");
    expect(pom).toContain("<artifactId>lib</artifactId>");
  });

  it("deploys both ways for a mixed policy and not at all for a mirror", () => {
    const mixed = mavenPomSnippet({ ...base, versionPolicy: "mixed" });
    expect(mixed).toContain("<snapshotRepository>");
    expect(mixed.slice(mixed.indexOf("<distributionManagement>"))).toContain("<repository>");
    expect(mavenPomSnippet({ ...base, versionPolicy: null })).not.toContain("distributionManagement");
  });
});

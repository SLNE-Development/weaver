import { describe, expect, it } from "vitest";
// The CLI's own schema, so the snippet can't drift from what `weaver fetch` accepts.
import { configSchema } from "../../../../packages/cli/src/config";
import {
  GENERIC_SHARE_IMAGE,
  archiveHref,
  artifactHref,
  artifactMetadataInput,
  listingMetadataInput,
  buildFileTree,
  firstFile,
  filterArtifacts,
  formatBytes,
  formatRelative,
  gradleSnippet,
  weaverJsonSnippet,
  repositoryHref,
} from "./browse";

describe("hrefs", () => {
  it("builds browse paths for repositories, artifacts and versions", () => {
    expect(repositoryHref("releases")).toBe("/browse/releases");
    expect(artifactHref("releases", "dev.example", "demo")).toBe("/browse/releases/dev.example/demo");
    expect(artifactHref("releases", "dev.example", "demo", "1.0.0-SNAPSHOT")).toBe(
      "/browse/releases/dev.example/demo/1.0.0-SNAPSHOT",
    );
  });

  it("builds the REST archive URL", () => {
    expect(archiveHref("releases", "dev.example", "demo", "1.0.0")).toBe(
      "/api/v1/repos/releases/artifacts/dev.example/demo/1.0.0/archive",
    );
  });

  it("encodes segments", () => {
    expect(artifactHref("r", "g", "a b")).toBe("/browse/r/g/a%20b");
  });
});

describe("usage snippets", () => {
  const input = { url: "https://protos.example.com", repository: "releases", coordinate: "dev.example:demo:1.0.0" };

  it("declares the repository and the dependency for Gradle", () => {
    const snippet = gradleSnippet(input);
    expect(snippet).toContain('url = "https://protos.example.com"');
    expect(snippet).toContain('repositories("releases")');
    expect(snippet).toContain('weaver("dev.example:demo:1.0.0")');
  });

  it("gradleSnippet for a group repository lists the group name", () => {
    const snippet = gradleSnippet({ url: "https://protos.example.com", repository: "all" });
    expect(snippet).toContain('repositories("all")');
    // Without a coordinate the dependency is only a commented template.
    expect(snippet).toContain('// weaver("group:name:version")');
    const parsed = configSchema.safeParse(JSON.parse(weaverJsonSnippet({ url: "https://protos.example.com", repository: "all" })));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ repositories: ["all"], dependencies: [] });
  });

  it("writes a weaver.json the CLI accepts", () => {
    const parsed = configSchema.safeParse(JSON.parse(weaverJsonSnippet(input)));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      url: "https://protos.example.com",
      repositories: ["releases"],
      dependencies: ["dev.example:demo:1.0.0"],
      outDir: "./protos",
    });
  });
});

describe("buildFileTree", () => {
  it("nests files under folders, folders first, sorted by name", () => {
    const tree = buildFileTree(["b.proto", "z/y.proto", "a.proto", "z/x/w.proto"]);
    expect(tree.map((n) => n.name)).toEqual(["z", "a.proto", "b.proto"]);
    const z = tree[0]!;
    expect(z.kind).toBe("folder");
    if (z.kind !== "folder") return;
    expect(z.children.map((n) => n.name)).toEqual(["x", "y.proto"]);
  });

  it("collapses chains of single-folder folders into one node", () => {
    const tree = buildFileTree(["dev/example/money/v1/money.proto", "dev/example/money/v1/currency.proto"]);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root).toMatchObject({ kind: "folder", name: "dev/example/money/v1", path: "dev/example/money/v1" });
    if (root.kind !== "folder") return;
    expect(root.children.map((n) => n.kind === "file" && n.path)).toEqual([
      "dev/example/money/v1/currency.proto",
      "dev/example/money/v1/money.proto",
    ]);
  });

  it("returns the first file in tree order", () => {
    expect(firstFile(buildFileTree(["b.proto", "a/z.proto"]))).toBe("a/z.proto");
    expect(firstFile([])).toBeNull();
  });
});

describe("formatting", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GiB");
    expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TiB");
  });

  it("formats relative times", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    expect(formatRelative(new Date("2026-10-21T11:59:30Z"), now)).toBe("just now");
    expect(formatRelative(new Date("2026-10-21T11:55:00Z"), now)).toBe("5 minutes ago");
    expect(formatRelative(new Date("2026-10-20T12:00:00Z"), now)).toBe("yesterday");
    expect(formatRelative(new Date("2026-08-21T12:00:00Z"), now)).toBe("2 months ago");
  });
});

describe("artifactMetadataInput", () => {
  const base = { repository: "releases", group: "dev.example", name: "demo", version: "1.0.0", fileCount: 2, dependencyCount: 1 };

  it("indexes public artifacts with the artifact share card", () => {
    const meta = artifactMetadataInput({ ...base, visibility: "public" });
    expect(meta.title).toBe("dev.example:demo:1.0.0");
    expect(meta.path).toBe("/browse/releases/dev.example/demo/1.0.0");
    expect(meta.image).toBe("/og/artifact/releases/dev.example/demo/1.0.0");
    expect(meta.noindex).toBeFalsy();
    expect(meta.description).toContain("2 proto files");
    expect(meta.description).toContain("releases");
  });

  it("keeps private artifacts out of search engines and off share cards", () => {
    const meta = artifactMetadataInput({ ...base, visibility: "private" });
    expect(meta.noindex).toBe(true);
    expect(meta.image).toBe(GENERIC_SHARE_IMAGE);
    expect(meta.description).not.toContain("dev.example");
  });

  it("is generic for an artifact the visitor can't see", () => {
    const meta = artifactMetadataInput({ repository: "releases", group: "g", name: "n", version: "1.0.0", visibility: null });
    expect(meta.noindex).toBe(true);
    expect(meta.title).toBe("Artifact");
    expect(meta.image).toBe(GENERIC_SHARE_IMAGE);
  });
});

describe("listingMetadataInput", () => {
  it("describes a public repository page with a canonical path", () => {
    const meta = listingMetadataInput({ repository: "releases", visibility: "public", description: "Released contracts" });
    expect(meta).toMatchObject({ title: "releases", path: "/browse/releases", image: GENERIC_SHARE_IMAGE });
    expect(meta.description).toContain("Released contracts");
    expect(meta.noindex).toBeFalsy();
  });

  it("describes a public artifact page", () => {
    const meta = listingMetadataInput({ repository: "releases", group: "dev.example", name: "demo", visibility: "public" });
    expect(meta).toMatchObject({ title: "dev.example:demo", path: "/browse/releases/dev.example/demo" });
    expect(meta.noindex).toBeFalsy();
  });

  it("keeps private or unknown pages out of search engines without naming anything", () => {
    for (const visibility of ["private", null] as const) {
      const meta = listingMetadataInput({ repository: "internal", group: "acme", name: "secret", visibility, description: "Top secret" });
      expect(meta.noindex).toBe(true);
      expect(meta.description).not.toContain("secret");
      expect(meta.description).not.toContain("Top");
    }
  });
});

describe("filterArtifacts", () => {
  const artifacts = [
    { group: "acme", name: "money" },
    { group: "acme", name: "order" },
    { group: "corp.secret", name: "vault" },
  ];

  it("matches group, name and group:name case-insensitively", () => {
    expect(filterArtifacts(artifacts, "MONEY").map((a) => a.name)).toEqual(["money"]);
    expect(filterArtifacts(artifacts, "acme:ord").map((a) => a.name)).toEqual(["order"]);
    expect(filterArtifacts(artifacts, "corp.SEC").map((a) => a.name)).toEqual(["vault"]);
    expect(filterArtifacts(artifacts, "nothing")).toEqual([]);
  });

  it("returns everything for an empty or blank filter", () => {
    expect(filterArtifacts(artifacts, "  ")).toBe(artifacts);
  });
});

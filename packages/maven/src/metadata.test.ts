import { describe, expect, it } from "vitest";
import {
  formatMavenTimestamp,
  mergeArtifactMetadata,
  parseMetadata,
  renderArtifactMetadata,
  renderPluginMetadata,
  renderSnapshotMetadata,
  type ArtifactMetadata,
  type PluginEntry,
  type SnapshotMetadata,
} from "./metadata.js";

const artifact: ArtifactMetadata = {
  groupId: "org.example",
  artifactId: "lib",
  versions: ["1.0", "1.1-SNAPSHOT", "1.0.1"],
  lastUpdated: "20261022101010",
};

const snapshot: SnapshotMetadata = {
  groupId: "org.example",
  artifactId: "lib",
  version: "1.0-SNAPSHOT",
  latest: { timestamp: "20261022.101010", buildNumber: 3 },
  snapshotVersions: [
    { classifier: null, extension: "jar", value: "1.0-20261022.101010-3", updated: "20261022101010" },
    { classifier: "sources", extension: "jar", value: "1.0-20261022.101010-3", updated: "20261022101010" },
  ],
  lastUpdated: "20261022101010",
};

describe("renderArtifactMetadata", () => {
  it("renders artifact metadata exactly", () => {
    expect(renderArtifactMetadata(artifact)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<metadata modelVersion="1.1.0">',
        "  <groupId>org.example</groupId>",
        "  <artifactId>lib</artifactId>",
        "  <versioning>",
        "    <latest>1.1-SNAPSHOT</latest>",
        "    <release>1.0.1</release>",
        "    <versions>",
        "      <version>1.0</version>",
        "      <version>1.0.1</version>",
        "      <version>1.1-SNAPSHOT</version>",
        "    </versions>",
        "    <lastUpdated>20261022101010</lastUpdated>",
        "  </versioning>",
        "</metadata>",
        "",
      ].join("\n"),
    );
  });

  it("omits release when there is only a snapshot", () => {
    const xml = renderArtifactMetadata({ ...artifact, versions: ["1.0-SNAPSHOT"] });
    expect(xml).toContain("<latest>1.0-SNAPSHOT</latest>");
    expect(xml).not.toContain("<release>");
  });

  it("escapes XML special characters in ids", () => {
    const m = { ...artifact, groupId: `a&b<c>"d'`, artifactId: "x&y" };
    const xml = renderArtifactMetadata(m);
    expect(xml).toContain("<groupId>a&amp;b&lt;c&gt;&quot;d&apos;</groupId>");
    expect(parseMetadata(xml)).toEqual({
      kind: "artifact",
      value: { ...m, versions: ["1.0", "1.0.1", "1.1-SNAPSHOT"] },
    });
  });
});

describe("renderSnapshotMetadata", () => {
  it("renders snapshot metadata", () => {
    const xml = renderSnapshotMetadata(snapshot);
    expect(xml).toContain("<version>1.0-SNAPSHOT</version>");
    expect(xml).toContain(
      "<snapshot>\n      <timestamp>20261022.101010</timestamp>\n      <buildNumber>3</buildNumber>\n    </snapshot>",
    );
    expect(xml.match(/<snapshotVersion>/g)).toHaveLength(2);
    expect(xml.match(/<classifier>/g)).toHaveLength(1);
    expect(xml).toContain("<classifier>sources</classifier>");
    expect(xml).toContain("<value>1.0-20261022.101010-3</value>");
    expect(xml).toContain("<updated>20261022101010</updated>");
    expect(xml.endsWith("</metadata>\n")).toBe(true);
  });
});

describe("parseMetadata", () => {
  it("round-trips artifact, snapshot and plugin metadata", () => {
    expect(parseMetadata(renderArtifactMetadata(artifact))).toEqual({
      kind: "artifact",
      value: { ...artifact, versions: ["1.0", "1.0.1", "1.1-SNAPSHOT"] },
    });
    expect(parseMetadata(renderSnapshotMetadata(snapshot))).toEqual({ kind: "snapshot", value: snapshot });
    const plugins: PluginEntry[] = [
      { name: "Compiler", prefix: "compiler", artifactId: "maven-compiler-plugin" },
      { name: null, prefix: "x", artifactId: "x-maven-plugin" },
    ];
    expect(parseMetadata(renderPluginMetadata(plugins))).toEqual({ kind: "plugins", plugins });
  });

  it("round-trips snapshot metadata without a latest stamp", () => {
    const m = { ...snapshot, latest: null, snapshotVersions: [] };
    expect(parseMetadata(renderSnapshotMetadata(m))).toEqual({ kind: "snapshot", value: m });
  });

  it("parses Maven Central style metadata without modelVersion and with a single version element", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>junit</groupId>
  <artifactId>junit</artifactId>
  <versioning>
    <latest>4.13</latest>
    <release>4.13</release>
    <versions>
      <version>4.13</version>
    </versions>
    <lastUpdated>20200101000000</lastUpdated>
  </versioning>
</metadata>`;
    expect(parseMetadata(xml)).toEqual({
      kind: "artifact",
      value: { groupId: "junit", artifactId: "junit", versions: ["4.13"], lastUpdated: "20200101000000" },
    });
  });

  it("returns null for non-metadata XML and for garbage", () => {
    expect(parseMetadata("<html/>")).toBeNull();
    expect(parseMetadata("not xml")).toBeNull();
    expect(parseMetadata("")).toBeNull();
  });
});

describe("hardening", () => {
  it("rejects a billion-laughs DOCTYPE", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE metadata [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>
<metadata><groupId>&c;</groupId><artifactId>x</artifactId><versioning><versions><version>1.0</version></versions></versioning></metadata>`;
    expect(parseMetadata(xml)).toBeNull();
  });

  it("omits lastUpdated when empty", () => {
    expect(renderArtifactMetadata({ ...artifact, lastUpdated: "" })).not.toContain("lastUpdated");
    expect(renderSnapshotMetadata({ ...snapshot, lastUpdated: "", snapshotVersions: [{ classifier: null, extension: "jar", value: "v", updated: "" }] })).not.toMatch(/lastUpdated|updated/);
  });

  it("returns null for a non-numeric buildNumber", () => {
    const xml = renderSnapshotMetadata(snapshot).replace("<buildNumber>3<", "<buildNumber>abc<");
    expect(parseMetadata(xml)).toBeNull();
  });
});

describe("mergeArtifactMetadata", () => {
  it("unions and recomputes", () => {
    const merged = mergeArtifactMetadata([
      { groupId: "g", artifactId: "a", versions: ["1.0", "2.0"], lastUpdated: "20260101000000" },
      { groupId: "g", artifactId: "a", versions: ["1.5", "2.0", "3.0-SNAPSHOT"], lastUpdated: "20260201000000" },
    ]);
    expect(merged.versions).toEqual(["1.0", "1.5", "2.0", "3.0-SNAPSHOT"]);
    expect(merged.lastUpdated).toBe("20260201000000");
    const xml = renderArtifactMetadata(merged);
    expect(xml).toContain("<release>2.0</release>");
    expect(xml).toContain("<latest>3.0-SNAPSHOT</latest>");
  });
});

describe("formatMavenTimestamp", () => {
  it("formats UTC as yyyyMMddHHmmss", () => {
    expect(formatMavenTimestamp(new Date("2026-10-22T10:10:10.999Z"))).toBe("20261022101010");
  });
});

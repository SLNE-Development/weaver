import { describe, expect, it } from "vitest";
import { CLEANUP_KINDS_BY_FORMAT } from "@weaver/core/cleanup-kinds";
import { describePolicy, policyFormSchema, policyKindInfo, toPolicyInput } from "./cleanup-policies";

describe("describePolicy", () => {
  it("phrases the proto and maven kinds with their value", () => {
    for (const format of ["proto", "maven"] as const) {
      expect(describePolicy(format, { kind: "keep_last_snapshot_builds", value: 5 })).toBe("Keep the last 5 builds of each snapshot");
      expect(describePolicy(format, { kind: "keep_last_snapshot_builds", value: 1 })).toBe("Keep the last build of each snapshot");
      expect(describePolicy(format, { kind: "delete_stale_snapshots", value: 30 })).toBe(
        "Delete snapshots not published to for 30 days",
      );
      expect(describePolicy(format, { kind: "delete_not_downloaded", value: 1, includeReleases: false })).toBe(
        "Delete snapshots not downloaded for 1 day",
      );
      expect(describePolicy(format, { kind: "delete_not_downloaded", value: 90, includeReleases: true })).toBe(
        "Delete snapshots and releases not downloaded for 90 days",
      );
    }
  });

  it("phrases the docker kinds", () => {
    expect(describePolicy("docker", { kind: "keep_last_tags", value: 5, pattern: "v*" })).toBe("Keep the last 5 tags matching v*");
    expect(describePolicy("docker", { kind: "keep_last_tags", value: 1, pattern: "*" })).toBe("Keep the last tag matching *");
    expect(describePolicy("docker", { kind: "delete_not_downloaded", value: 30 })).toBe("Delete tags not pulled for 30 days");
    expect(describePolicy("docker", { kind: "delete_untagged_manifests", value: 7 })).toBe(
      "Delete untagged manifests older than 7 days",
    );
  });

  it("phrases the npm kinds", () => {
    expect(describePolicy("npm", { kind: "keep_last_versions", value: 1 })).toBe("Keep the last version of each package");
    expect(describePolicy("npm", { kind: "keep_last_versions", value: 4 })).toBe("Keep the last 4 versions of each package");
    expect(describePolicy("npm", { kind: "delete_not_downloaded", value: 60 })).toBe("Delete versions not downloaded for 60 days");
  });
});

describe("policyKindInfo", () => {
  it("names the scope per format and the unit per kind", () => {
    expect(policyKindInfo("proto", "delete_stale_snapshots").scopeLabel).toBe("Group prefix");
    expect(policyKindInfo("maven", "delete_stale_snapshots").scopeLabel).toBe("groupId prefix");
    expect(policyKindInfo("npm", "keep_last_versions")).toMatchObject({ scopeLabel: "Package prefix", unit: "versions" });
    expect(policyKindInfo("docker", "keep_last_tags")).toMatchObject({ scopeLabel: "Image prefix", unit: "tags", title: "Keep last N tags" });
    expect(policyKindInfo("docker", "delete_not_downloaded").title).toBe("Delete tags not pulled");
    expect(policyKindInfo("maven", "keep_last_snapshot_builds").unit).toBe("builds");
    expect(policyKindInfo("docker", "delete_untagged_manifests").unit).toBe("days");
  });

  it("has a title and description for every kind of every format", () => {
    for (const [format, kinds] of Object.entries(CLEANUP_KINDS_BY_FORMAT)) {
      for (const kind of kinds) {
        const info = policyKindInfo(format as keyof typeof CLEANUP_KINDS_BY_FORMAT, kind);
        expect(info.title.length).toBeGreaterThan(0);
        expect(info.description.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("policyFormSchema", () => {
  const valid = { kind: "delete_stale_snapshots", value: 30, groupPrefix: "", pattern: "", includeReleases: false, enabled: true } as const;

  it("accepts an empty group prefix and a valid one", () => {
    expect(policyFormSchema("proto").safeParse(valid).success).toBe(true);
    expect(policyFormSchema("proto").safeParse({ ...valid, groupPrefix: "com.acme" }).success).toBe(true);
  });

  it("rejects an invalid group prefix, a missing value and values out of range", () => {
    const schema = policyFormSchema("proto");
    expect(schema.safeParse({ ...valid, groupPrefix: "Com..acme" }).success).toBe(false);
    expect(schema.safeParse({ ...valid, value: Number.NaN }).success).toBe(false);
    expect(schema.safeParse({ ...valid, value: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, value: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...valid, value: 36_501 }).success).toBe(false);
  });

  it("accepts only the format's kinds", () => {
    expect(policyFormSchema("npm").safeParse(valid).success).toBe(false);
    expect(policyFormSchema("npm").safeParse({ ...valid, kind: "keep_last_versions" }).success).toBe(true);
  });

  it("takes plain prefixes outside proto and needs a pattern for keep_last_tags", () => {
    expect(policyFormSchema("npm").safeParse({ ...valid, kind: "keep_last_versions", groupPrefix: "@acme/" }).success).toBe(true);
    expect(policyFormSchema("npm").safeParse({ ...valid, kind: "keep_last_versions", groupPrefix: "a b" }).success).toBe(false);
    const docker = policyFormSchema("docker");
    expect(docker.safeParse({ ...valid, kind: "keep_last_tags", groupPrefix: "team/" }).success).toBe(false);
    expect(docker.safeParse({ ...valid, kind: "keep_last_tags", pattern: "v*" }).success).toBe(true);
  });
});

describe("toPolicyInput", () => {
  it("maps an empty prefix to null and drops includeReleases and pattern for kinds that ignore them", () => {
    expect(
      toPolicyInput("proto", "main", "7d5a3b7e-8f1c-4c55-9a51-111111111111", {
        kind: "keep_last_snapshot_builds",
        value: 3,
        groupPrefix: " ",
        pattern: "v*",
        includeReleases: true,
        enabled: false,
      }),
    ).toEqual({
      repository: "main",
      id: "7d5a3b7e-8f1c-4c55-9a51-111111111111",
      kind: "keep_last_snapshot_builds",
      value: 3,
      groupPrefix: null,
      pattern: null,
      includeReleases: false,
      enabled: false,
    });
    expect(
      toPolicyInput("proto", "main", undefined, {
        kind: "delete_not_downloaded",
        value: 90,
        groupPrefix: "com.acme",
        pattern: "",
        includeReleases: true,
        enabled: true,
      }),
    ).toEqual({
      repository: "main",
      kind: "delete_not_downloaded",
      value: 90,
      groupPrefix: "com.acme",
      pattern: null,
      includeReleases: true,
      enabled: true,
    });
  });

  it("keeps the pattern of keep_last_tags and never sends includeReleases for docker or npm", () => {
    expect(
      toPolicyInput("docker", "images", undefined, {
        kind: "keep_last_tags",
        value: 5,
        groupPrefix: "team/",
        pattern: " v* ",
        includeReleases: true,
        enabled: true,
      }),
    ).toMatchObject({ kind: "keep_last_tags", pattern: "v*", groupPrefix: "team/", includeReleases: false });
    expect(
      toPolicyInput("npm", "pkgs", undefined, {
        kind: "delete_not_downloaded",
        value: 5,
        groupPrefix: "",
        pattern: "",
        includeReleases: true,
        enabled: true,
      }),
    ).toMatchObject({ includeReleases: false, pattern: null });
  });
});

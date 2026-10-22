import { describe, expect, it } from "vitest";
import { compareMavenVersions, isSnapshotVersion } from "./version.js";

describe("compareMavenVersions", () => {
  it("sorts ascending", () => {
    const input = ["1.0", "1.0-SNAPSHOT", "1.0-rc1", "1.0-alpha-1", "1.10", "1.9", "1.0-sp1", "1.0-beta", "1.0.1"];
    expect([...input].sort(compareMavenVersions)).toEqual([
      "1.0-alpha-1", "1.0-beta", "1.0-rc1", "1.0-SNAPSHOT", "1.0", "1.0-sp1", "1.0.1", "1.9", "1.10",
    ]);
  });

  it("treats equivalent versions as equal", () => {
    expect(compareMavenVersions("1.0.0", "1")).toBe(0);
    expect(compareMavenVersions("1.0-RC1", "1.0-cr1")).toBe(0);
    expect(compareMavenVersions("1.0-ga", "1.0")).toBe(0);
  });
});

describe("isSnapshotVersion", () => {
  it("detects the SNAPSHOT suffix", () => {
    expect(isSnapshotVersion("1.0-SNAPSHOT")).toBe(true);
    expect(isSnapshotVersion("1.0")).toBe(false);
  });
});

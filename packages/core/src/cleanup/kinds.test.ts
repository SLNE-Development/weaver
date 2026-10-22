import { describe, expect, it } from "vitest";
import { cleanupKindEnum } from "@weaver/db";
import { FORMATS } from "../repos/config.js";
import { CLEANUP_KINDS, CLEANUP_KINDS_BY_FORMAT, kindUsesPattern } from "./kinds.js";

describe("cleanup kinds", () => {
  it("lists the kinds of each format in order", () => {
    expect(CLEANUP_KINDS_BY_FORMAT.docker).toEqual(["delete_untagged_manifests", "keep_last_tags", "delete_not_downloaded"]);
    expect(CLEANUP_KINDS_BY_FORMAT.npm).toEqual(["delete_not_downloaded", "keep_last_versions"]);
    expect(CLEANUP_KINDS_BY_FORMAT.maven).toEqual(["keep_last_snapshot_builds", "delete_stale_snapshots", "delete_not_downloaded"]);
    expect(CLEANUP_KINDS_BY_FORMAT.proto).toEqual(["keep_last_snapshot_builds", "delete_stale_snapshots", "delete_not_downloaded"]);
  });

  it("uses every kind for at least one format", () => {
    for (const kind of CLEANUP_KINDS) {
      expect(FORMATS.some((f) => CLEANUP_KINDS_BY_FORMAT[f].includes(kind))).toBe(true);
    }
  });

  it("matches the database enum", () => {
    expect([...CLEANUP_KINDS]).toEqual(cleanupKindEnum.enumValues);
  });

  it("uses a pattern only for keep_last_tags", () => {
    expect(kindUsesPattern("keep_last_tags")).toBe(true);
    for (const kind of CLEANUP_KINDS.filter((k) => k !== "keep_last_tags")) expect(kindUsesPattern(kind)).toBe(false);
  });
});

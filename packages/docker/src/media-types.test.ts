import { describe, expect, it } from "vitest";
import { MANIFEST_MEDIA_TYPES, isDigest } from "./media-types.js";

describe("MANIFEST_MEDIA_TYPES", () => {
  it("lists the four accepted manifest types", () => {
    expect([...MANIFEST_MEDIA_TYPES].sort()).toEqual([
      "application/vnd.docker.distribution.manifest.list.v2+json",
      "application/vnd.docker.distribution.manifest.v2+json",
      "application/vnd.oci.image.index.v1+json",
      "application/vnd.oci.image.manifest.v1+json",
    ]);
  });
});

describe("isDigest", () => {
  it("accepts sha256 with 64 hex", () => expect(isDigest(`sha256:${"0f".repeat(32)}`)).toBe(true));
  it("accepts sha512 with 128 hex", () => expect(isDigest(`sha512:${"a".repeat(128)}`)).toBe(true));
  it("rejects wrong length, case, algorithm and junk", () => {
    expect(isDigest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isDigest(`md5:${"a".repeat(32)}`)).toBe(false);
    expect(isDigest("latest")).toBe(false);
    expect(isDigest("")).toBe(false);
  });
});

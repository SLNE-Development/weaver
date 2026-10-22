import { describe, expect, it } from "vitest";
import { DockerError } from "./errors.js";
import { parseRoute } from "./route.js";

const hex = "a".repeat(64);

describe("parseRoute", () => {
  it("'' is base", () => expect(parseRoute("")).toEqual({ kind: "base" }));
  it("'token' is token", () => expect(parseRoute("token")).toEqual({ kind: "token" }));
  it("parses a manifest by tag", () =>
    expect(parseRoute("hosted/app/manifests/latest")).toEqual({ kind: "manifest", name: "hosted/app", reference: "latest" }));
  it("parses a manifest by digest", () =>
    expect(parseRoute(`hosted/app/manifests/sha256:${hex}`)).toEqual({ kind: "manifest", name: "hosted/app", reference: `sha256:${hex}` }));
  it("parses upload-start", () =>
    expect(parseRoute("hosted/a/b/blobs/uploads/")).toEqual({ kind: "upload-start", name: "hosted/a/b" }));
  it("parses an upload", () =>
    expect(parseRoute("hosted/a/blobs/uploads/1234-uuid")).toEqual({ kind: "upload", name: "hosted/a", uploadId: "1234-uuid" }));
  it("parses a blob", () =>
    expect(parseRoute(`hosted/a/blobs/sha256:${hex}`)).toEqual({ kind: "blob", name: "hosted/a", digest: `sha256:${hex}` }));
  it("parses tags", () =>
    expect(parseRoute("m/library/nginx/tags/list")).toEqual({ kind: "tags", name: "m/library/nginx" }));
  it("parses referrers", () =>
    expect(parseRoute(`hosted/a/referrers/sha256:${hex}`)).toEqual({ kind: "referrers", name: "hosted/a", digest: `sha256:${hex}` }));
  it("throws NAME_INVALID for uppercase names", () => {
    try {
      parseRoute("Hosted/App/manifests/x");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DockerError);
      expect((e as DockerError).code).toBe("NAME_INVALID");
    }
  });
  it("throws NAME_INVALID for empty components", () => {
    expect(() => parseRoute("a//b/manifests/x")).toThrow(DockerError);
  });
  it("returns null for an empty reference", () => expect(parseRoute("a/manifests/")).toBeNull());
  it("returns null for an invalid tag", () => expect(parseRoute("a/manifests/-bad")).toBeNull());
  it("returns null for a trailing slash on a manifest path", () => expect(parseRoute("a/manifests/latest/")).toBeNull());
  it("returns null for a 129-char tag", () => expect(parseRoute(`a/manifests/${"t".repeat(129)}`)).toBeNull());
  it("accepts a 128-char tag", () => expect(parseRoute(`a/manifests/${"t".repeat(128)}`)).not.toBeNull());
  it("parses a sha512 manifest reference", () => {
    const ref = `sha512:${"b".repeat(128)}`;
    expect(parseRoute(`a/manifests/${ref}`)).toEqual({ kind: "manifest", name: "a", reference: ref });
  });
  it("starts an upload without a trailing slash", () =>
    expect(parseRoute("hosted/a/blobs/uploads")).toEqual({ kind: "upload-start", name: "hosted/a" }));
  it("returns null for unknown paths", () => expect(parseRoute("nothing/here")).toBeNull());
});

import { describe, expect, it } from "vitest";
import { abbreviate, mergePackuments, rewriteTarballs, wantsAbbreviated, type Packument } from "./packument.js";

function make(over: Partial<Packument> & { versions: Packument["versions"] }): Packument {
  return { _id: "@acme/ui", name: "@acme/ui", "dist-tags": {}, time: {}, ...over };
}
const v = (version: string, tarball = `https://registry.npmjs.org/@acme/ui/-/ui-${version}.tgz`) => ({
  name: "@acme/ui",
  version,
  dist: { tarball, shasum: "abc", integrity: "sha512-x" },
});

describe("wantsAbbreviated", () => {
  it("detects the install media type", () => {
    expect(wantsAbbreviated("application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*")).toBe(true);
    expect(wantsAbbreviated("application/json")).toBe(false);
    expect(wantsAbbreviated(null)).toBe(false);
    expect(wantsAbbreviated("application/vnd.npm.install-v1+json;q=0")).toBe(false);
  });
});

describe("abbreviate", () => {
  it("keeps install fields only", () => {
    const p = make({
      readme: "hi",
      "dist-tags": { latest: "1.0.0" },
      time: { modified: "2026-01-01T00:00:00.000Z" },
      versions: { "1.0.0": { ...v("1.0.0"), scripts: { a: "b" }, maintainers: [], deprecated: "old", dependencies: { x: "1" } } },
    });
    const a = abbreviate(p);
    expect(a.modified).toBe("2026-01-01T00:00:00.000Z");
    expect(a).not.toHaveProperty("readme");
    const m = a.versions["1.0.0"]!;
    expect(m).not.toHaveProperty("scripts");
    expect(m).not.toHaveProperty("maintainers");
    expect(m.deprecated).toBe("old");
    expect(m.dist?.integrity).toBe("sha512-x");
    expect(m.dependencies).toEqual({ x: "1" });
  });
});

describe("rewriteTarballs", () => {
  const base = "https://weaver.slne.dev/npm/grp";
  const want = "https://weaver.slne.dev/npm/grp/@acme/ui/-/ui-1.0.0.tgz";
  it("rewrites absolute and relative tarballs", () => {
    const p = make({ versions: { "1.0.0": v("1.0.0"), "1.0.1": v("1.0.1", "@acme/ui/-/ui-1.0.1.tgz") } });
    const out = rewriteTarballs(p, base);
    expect(out.versions["1.0.0"]!.dist.tarball).toBe(want);
    expect(out.versions["1.0.1"]!.dist.tarball).toBe("https://weaver.slne.dev/npm/grp/@acme/ui/-/ui-1.0.1.tgz");
    expect(p.versions["1.0.0"]!.dist.tarball).not.toBe(want);
  });

  it("builds the url from the packument's name, not the manifest's", () => {
    const p = make({ versions: { "1.0.0": { ...v("1.0.0"), name: "../evil" } } });
    expect(rewriteTarballs(p, base).versions["1.0.0"]!.dist.tarball).toBe(want);
  });
});

describe("mergePackuments", () => {
  it("first wins per version and dist-tag", () => {
    const a = make({ "dist-tags": { latest: "1.0.0" }, time: { modified: "2026-01-01", "1.0.0": "t1" }, versions: { "1.0.0": { ...v("1.0.0"), marker: "a" } } });
    const b = make({
      readme: "from b",
      "dist-tags": { latest: "2.0.0", next: "2.0.0" },
      time: { modified: "2026-02-01", "1.0.0": "t2", "2.0.0": "t3" },
      versions: { "1.0.0": { ...v("1.0.0"), marker: "b" }, "2.0.0": v("2.0.0") },
    });
    const m = mergePackuments([a, b]);
    expect(Object.keys(m.versions).sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(m.versions["1.0.0"]!.marker).toBe("a");
    expect(m["dist-tags"]).toEqual({ latest: "1.0.0", next: "2.0.0" });
    expect(m.time).toMatchObject({ "1.0.0": "t1", "2.0.0": "t3", modified: "2026-02-01" });
    expect(m.readme).toBe("from b");
  });
});

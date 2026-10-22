import { describe, expect, it } from "vitest";
import { parsePackageName, upstreamPackagePath } from "./names.js";
import { abbreviate, mergePackuments, rewriteTarballs, type Packument } from "./packument.js";
import { parseNpmPath } from "./route.js";

const route = (p: string) => parseNpmPath(p)?.route;
const UNSUPPORTED = { kind: "unsupported" };

function make(over: Partial<Packument> & { versions: Packument["versions"] }): Packument {
  return { _id: "x", name: "x", "dist-tags": {}, time: {}, ...over };
}

describe("name hardening", () => {
  it("rejects dangerous names", () => {
    for (const bad of ["..", ".", "foo?x=1", "a#b", "a%2fb", "a\\b", "a b", "a\nb", "@acme/..", "@../x", "@acme/-"]) {
      expect(parsePackageName(bad), bad).toBeNull();
    }
  });
  it("encodes upstream path parts", () => {
    expect(upstreamPackagePath({ full: "@a/b", scope: "a", bare: "b" })).toBe("@a%2fb");
    expect(upstreamPackagePath({ full: "@a/b+c", scope: "a", bare: "b+c" })).toBe("@a%2fb%2Bc");
  });
});

describe("route hardening", () => {
  it("rejects traversal and malformed segments", () => {
    expect(parseNpmPath("r/%2e%2e")).toBeNull();
    expect(route("r/foo%3Fx=1")).toEqual(UNSUPPORTED);
    expect(route("r/left-pad/-/..%2fx.tgz")).toEqual(UNSUPPORTED);
    expect(route("r/left-pad/-/left-pad-1.0.0.zip")).toEqual(UNSUPPORTED);
    expect(route("r/-/package/left-pad/dist-tags/a%2fb")).toEqual(UNSUPPORTED);
    expect(route("r/-/user/a%2f..%2fb")).toEqual(UNSUPPORTED);
    expect(route("r/-/v1/login/done/a%5Cb")).toEqual(UNSUPPORTED);
    expect(route("r/-/npm/v1/security/a%2fb")).toEqual(UNSUPPORTED);
    expect(route("r/@acme/-/x.tgz")).toEqual(UNSUPPORTED);
  });
});

describe("untrusted upstream data", () => {
  it("keeps dist-tags named like Object.prototype members", () => {
    const a = make({ "dist-tags": { constructor: "1.0.0", toString: "1.0.0" }, versions: {} });
    const m = mergePackuments([a, make({ versions: {} })]);
    expect(Object.hasOwn(m["dist-tags"], "constructor")).toBe(true);
    expect(m["dist-tags"]["toString"]).toBe("1.0.0");
  });
  it("does not let a __proto__ version key set the prototype", () => {
    const evil = JSON.parse(
      '{"_id":"x","name":"x","dist-tags":{},"time":{},"versions":{"__proto__":{"name":"x","version":"9","dist":{"tarball":"a/-/x-9.tgz","shasum":"s"}}}}',
    ) as Packument;
    const m = mergePackuments([evil]);
    expect(Object.getPrototypeOf(m.versions)).toBe(Object.prototype);
    expect(Object.hasOwn(m.versions, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(abbreviate(evil).versions)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(rewriteTarballs(evil, "https://h/npm/r").versions)).toBe(Object.prototype);
  });
  it("falls back to the packument name when a manifest lacks name or tarball", () => {
    const p = { name: "@acme/ui", versions: { "1.0.0": { version: "1.0.0", dist: {} }, "1.1.0": { name: "@acme/ui" } } } as unknown as Packument;
    const out = rewriteTarballs(p, "https://h/npm/r");
    expect(out.versions["1.0.0"]!.dist.tarball).toBe("https://h/npm/r/@acme/ui/-/ui-1.0.0.tgz");
    expect(out.versions["1.1.0"]!.dist.tarball).toBe("https://h/npm/r/@acme/ui/-/ui-1.1.0.tgz");
  });
  it("tolerates missing time and dist-tags", () => {
    const bare = { _id: "x", name: "x", versions: {} } as unknown as Packument;
    expect(() => abbreviate(bare)).not.toThrow();
    expect(() => mergePackuments([bare, bare])).not.toThrow();
    const timed = make({ time: { created: "2026-01-01", "1.0.0": "2026-03-01" }, versions: {} });
    expect(abbreviate(timed).modified).toBe("2026-03-01");
    expect(mergePackuments([timed]).time["modified"]).toBe("2026-03-01");
  });
  it("drops _rev from merged packuments", () => {
    expect(mergePackuments([make({ _rev: "3-a", versions: {} })])._rev).toBeUndefined();
  });
});

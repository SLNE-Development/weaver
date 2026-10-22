import { describe, expect, it } from "vitest";
import type { RegistryError } from "../errors.js";
import { componentLabel } from "./labels.js";
import { parseSearchQuery } from "./query.js";

describe("parseSearchQuery", () => {
  it("normalises maven coordinates and drops the version for the alternative", () => {
    const parsed = parseSearchQuery("Org.Apache:Commons-Lang3:3.14");
    expect(parsed.terms).toEqual(["org.apache", "commons-lang3", "3.14"]);
    expect(parsed.altTerms).toEqual(["org.apache", "commons-lang3"]);
    expect(parsed.normalized).toBe("org.apache commons-lang3 3.14");
  });

  it("drops an npm version after a scoped name", () => {
    expect(parseSearchQuery("@acme/ui@1.2.0").altTerms).toEqual(["@acme", "ui"]);
  });

  it("drops a docker tag", () => {
    expect(parseSearchQuery("library/nginx:1.27").altTerms).toEqual(["library", "nginx"]);
  });

  it("has no alternative without a version segment", () => {
    expect(parseSearchQuery("nginx").altTerms).toBeNull();
    expect(parseSearchQuery("@acme/ui").altTerms).toBeNull();
  });

  it("rejects queries shorter than two characters after normalising", () => {
    for (const raw of ["a", "  ", ":/", " b/", "@ @", "a b", "@a"]) {
      let error: unknown;
      try {
        parseSearchQuery(raw);
      } catch (e) {
        error = e;
      }
      expect((error as RegistryError | undefined)?.code).toBe("invalid_request");
    }
  });

  it("collapses repeated whitespace", () => {
    const parsed = parseSearchQuery("  org.x   ::  lib ");
    expect(parsed.normalized).toBe("org.x lib");
    expect(parsed.terms).toEqual(["org.x", "lib"]);
  });

  it("drops an alternative without a usable term", () => {
    expect(parseSearchQuery("ab:1.0").altTerms).toEqual(["ab"]);
    expect(parseSearchQuery("a:lib").altTerms).toBeNull();
  });

  it("keeps the first five terms", () => {
    expect(parseSearchQuery("a1 b2 c3 d4 e5 f6 g7").terms).toEqual(["a1", "b2", "c3", "d4", "e5"]);
  });
});

describe("componentLabel", () => {
  it("joins maven and proto coordinates with a colon", () => {
    expect(componentLabel("maven", "org.x", "lib")).toBe("org.x:lib");
    expect(componentLabel("proto", "dev.slne", "money")).toBe("dev.slne:money");
  });

  it("writes npm names with their scope", () => {
    expect(componentLabel("npm", "@acme", "ui")).toBe("@acme/ui");
    expect(componentLabel("npm", "acme", "ui")).toBe("@acme/ui");
    expect(componentLabel("npm", "", "left-pad")).toBe("left-pad");
  });

  it("writes docker image names as stored", () => {
    expect(componentLabel("docker", "", "team/app")).toBe("team/app");
  });
});

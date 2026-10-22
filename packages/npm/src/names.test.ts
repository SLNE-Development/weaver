import { describe, expect, it } from "vitest";
import { isValidNewPackageName, parsePackageName, tarballFile, upstreamPackagePath, versionFromTarball } from "./names.js";

describe("package names", () => {
  const ui = parsePackageName("@acme/ui")!;
  it("validates new names", () => {
    expect(isValidNewPackageName("Foo")).toBe(false);
    expect(isValidNewPackageName("@acme/ui")).toBe(true);
    expect(isValidNewPackageName(".x")).toBe(false);
    expect(isValidNewPackageName("a".repeat(215))).toBe(false);
  });
  it("parses names", () => {
    expect(ui).toEqual({ full: "@acme/ui", scope: "acme", bare: "ui" });
    expect(parsePackageName("left-pad")).toEqual({ full: "left-pad", scope: "", bare: "left-pad" });
    expect(parsePackageName("")).toBeNull();
    expect(parsePackageName("@acme")).toBeNull();
  });
  it("maps tarball files", () => {
    expect(tarballFile(ui, "1.0.0")).toBe("ui-1.0.0.tgz");
    expect(versionFromTarball(ui, "ui-1.0.0-beta.1.tgz")).toBe("1.0.0-beta.1");
    expect(versionFromTarball(ui, "other-1.0.0.tgz")).toBeNull();
  });
  it("builds upstream paths", () => {
    expect(upstreamPackagePath(ui)).toBe("@acme%2fui");
    expect(upstreamPackagePath(parsePackageName("left-pad")!)).toBe("left-pad");
  });
});

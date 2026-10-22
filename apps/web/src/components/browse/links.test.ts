import { describe, expect, it } from "vitest";
import type { SearchHit } from "@weaver/core";
import { BROWSE_LINKS, packageHref } from "./links";

function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    repository: "repo",
    via: null,
    format: "maven",
    kind: "hosted",
    namespace: "",
    name: "x",
    label: "x",
    latestVersion: "1.0",
    versionCount: 1,
    downloads: 0,
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("package links", () => {
  it("has a builder for every format", () => {
    expect(Object.keys(BROWSE_LINKS).sort()).toEqual(["docker", "maven", "npm", "proto"]);
  });

  it("links each format to its package page", () => {
    expect(packageHref(hit({ format: "maven", namespace: "org.x", name: "lib" }))).toBe("/browse/repo?g=org.x&a=lib");
    expect(packageHref(hit({ format: "proto", namespace: "dev.slne", name: "money" }))).toBe("/browse/repo/dev.slne/money");
    expect(packageHref(hit({ format: "npm", namespace: "acme", name: "ui" }))).toBe("/browse/repo/-/npm/@acme/ui");
    expect(packageHref(hit({ format: "npm", namespace: "", name: "left-pad" }))).toBe("/browse/repo/-/npm/left-pad");
    expect(packageHref(hit({ format: "docker", name: "team/app" }))).toBe("/browse/repo");
  });

  it("has no link for proto packages of mirrors or read through a group", () => {
    expect(packageHref(hit({ format: "proto", kind: "mirror", namespace: "a", name: "b" }))).toBeNull();
    expect(packageHref(hit({ format: "proto", via: "all", namespace: "a", name: "b" }))).toBeNull();
  });

  it("links a package read through a group into the group", () => {
    expect(packageHref(hit({ repository: "member", via: "all", namespace: "org.x", name: "lib" }))).toBe("/browse/all?g=org.x&a=lib");
  });
});

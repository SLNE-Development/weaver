import { describe, expect, it } from "vitest";
import { parseNpmPath } from "./route.js";

const route = (p: string) => parseNpmPath(p)?.route;

describe("parseNpmPath", () => {
  it("routes ping and the repo name", () => {
    expect(parseNpmPath("r/-/ping")).toEqual({ repo: "r", route: { kind: "ping" } });
  });
  it.each(["r/@acme%2fui", "r/@acme%2Fui", "r/@acme/ui"])("parses scoped packument %s", (p) => {
    expect(route(p)).toMatchObject({ kind: "packument", rev: null, name: { full: "@acme/ui", scope: "acme", bare: "ui" } });
  });
  it.each(["r/@acme/ui/-/ui-1.0.0.tgz", "r/@acme%2fui/-/ui-1.0.0.tgz"])("parses scoped tarball %s", (p) => {
    expect(route(p)).toMatchObject({ kind: "tarball", file: "ui-1.0.0.tgz", rev: null, name: { full: "@acme/ui" } });
  });
  it("parses revisions", () => {
    expect(route("r/left-pad/-rev/3-abc")).toMatchObject({ kind: "packument", rev: "3-abc" });
    expect(route("r/left-pad/-/left-pad-1.0.0.tgz/-rev/3-abc")).toMatchObject({ kind: "tarball", rev: "3-abc" });
  });
  it("parses dist-tags", () => {
    expect(route("r/-/package/@acme%2fui/dist-tags/beta")).toMatchObject({ kind: "distTags", tag: "beta", name: { full: "@acme/ui" } });
    expect(route("r/-/package/left-pad/dist-tags")).toMatchObject({ kind: "distTags", tag: null });
  });
  it("parses version specs", () => {
    expect(route("r/left-pad/latest")).toMatchObject({ kind: "version", spec: "latest" });
  });
  it("parses auth, user, security and search routes", () => {
    expect(route("r/-/whoami")).toEqual({ kind: "whoami" });
    expect(route("r/-/v1/login")).toEqual({ kind: "login" });
    expect(route("r/-/v1/login/done/s3cr3t")).toEqual({ kind: "loginDone", secret: "s3cr3t" });
    expect(route("r/-/user/org.couchdb.user:bob")).toEqual({ kind: "couchUser", user: "org.couchdb.user:bob" });
    expect(route("r/-/user/org.couchdb.user%3Abob")).toEqual({ kind: "couchUser", user: "org.couchdb.user:bob" });
    expect(route("r/-/npm/v1/security/advisories/bulk")).toEqual({ kind: "security", path: "advisories/bulk" });
    expect(route("r/-/v1/search")).toEqual({ kind: "search" });
  });
  it("marks unknown routes unsupported and empty paths null", () => {
    expect(route("r/-/org/x/user")).toEqual({ kind: "unsupported" });
    expect(parseNpmPath("")).toBeNull();
    expect(parseNpmPath("r")).toBeNull();
  });
});

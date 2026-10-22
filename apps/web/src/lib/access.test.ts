import { describe, expect, it } from "vitest";
import { decideAccess, decideRoleAccess, loginPath, safeNextPath } from "./access";

describe("decideAccess", () => {
  it("sends anonymous visitors to the login page when anonymous view is off", () => {
    expect(decideAccess({ path: "/dashboard", role: null, anonymousView: false })).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fdashboard",
    });
    expect(decideAccess({ path: "/browse/main?tab=files", role: null, anonymousView: false })).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fbrowse%2Fmain%3Ftab%3Dfiles",
    });
  });

  it("lets anonymous visitors see the dashboard and browse pages when anonymous view is on", () => {
    for (const path of ["/dashboard", "/browse", "/browse/main/dev.example/demo/1.0.0", "/search?q=lib"]) {
      expect(decideAccess({ path, role: null, anonymousView: true })).toEqual({ kind: "allow" });
    }
  });

  it("keeps everything else behind the login even with anonymous view on", () => {
    for (const path of ["/keys", "/repositories", "/account", "/admin/users", "/browsers", "/dashboards", "/searches"]) {
      expect(decideAccess({ path, role: null, anonymousView: true })).toEqual({
        kind: "redirect",
        to: loginPath(path),
      });
    }
  });

  it("lets signed-in users in regardless of anonymous view", () => {
    expect(decideAccess({ path: "/keys", role: "viewer", anonymousView: false })).toEqual({ kind: "allow" });
  });

  it("reserves admin pages for admins", () => {
    expect(decideAccess({ path: "/admin/users", role: "maintainer", anonymousView: false })).toEqual({
      kind: "redirect",
      to: "/dashboard",
    });
    expect(decideAccess({ path: "/admin", role: "viewer", anonymousView: false })).toEqual({
      kind: "redirect",
      to: "/dashboard",
    });
    expect(decideAccess({ path: "/admin/users", role: "admin", anonymousView: false })).toEqual({ kind: "allow" });
    expect(decideAccess({ path: "/administrator", role: "viewer", anonymousView: false })).toEqual({ kind: "allow" });
  });
});

describe("decideRoleAccess", () => {
  it("sends anonymous visitors to the login page, returning to the page", () => {
    expect(decideRoleAccess({ path: "/keys", role: null, required: "viewer" })).toEqual({
      kind: "redirect",
      to: "/login?next=%2Fkeys",
    });
  });

  it("lets users with the required role or higher in", () => {
    expect(decideRoleAccess({ path: "/x", role: "viewer", required: "viewer" })).toEqual({ kind: "allow" });
    expect(decideRoleAccess({ path: "/x", role: "admin", required: "maintainer" })).toEqual({ kind: "allow" });
  });

  it("sends users below the required role to the dashboard", () => {
    expect(decideRoleAccess({ path: "/x", role: "maintainer", required: "admin" })).toEqual({
      kind: "redirect",
      to: "/dashboard",
    });
    expect(decideRoleAccess({ path: "/x", role: "viewer", required: "maintainer" })).toEqual({
      kind: "redirect",
      to: "/dashboard",
    });
  });
});

describe("safeNextPath", () => {
  it("keeps local absolute paths", () => {
    expect(safeNextPath("/browse/main?x=1")).toBe("/browse/main?x=1");
  });

  it("falls back to the dashboard for missing, external or protocol-relative targets", () => {
    for (const value of [undefined, null, "", "https://evil.example", "//evil.example", "/\\evil.example", "browse"]) {
      expect(safeNextPath(value)).toBe("/dashboard");
    }
  });

  it("keeps the query and fragment of a local path", () => {
    expect(safeNextPath("/browse?x=1#y")).toBe("/browse?x=1#y");
  });

  it("rejects paths that browsers would turn into another host", () => {
    for (const value of [
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/%09/evil.example",
      "/%5C/evil.example",
      "/ /evil.example",
      "https://evil",
      "//evil",
      "/\\evil",
      "\t//evil",
      "/.//evil",
      "/..//evil",
      "/%2e%2e//evil",
      "/%2E%2E/%2F/evil",
      "/a/../..//evil",
      "/%2F%2Fevil",
    ]) {
      expect(safeNextPath(value), JSON.stringify(value)).toBe("/dashboard");
    }
  });

  it("never sends a signed-in user back to the login page", () => {
    expect(safeNextPath("/login?next=/")).toBe("/dashboard");
  });
});

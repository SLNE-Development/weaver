import { describe, expect, it } from "vitest";
import { isNavActive, navItemsFor } from "./navigation";

const titles = (role: Parameters<typeof navItemsFor>[0]) => navItemsFor(role).map((item) => item.title);

describe("navItemsFor", () => {
  it("shows anonymous visitors only Dashboard and Browse", () => {
    expect(titles(null)).toEqual(["Dashboard", "Browse"]);
  });

  it("hides the admin section from viewers and maintainers", () => {
    const expected = ["Dashboard", "Browse", "Repositories", "API keys"];
    expect(titles("viewer")).toEqual(expected);
    expect(titles("maintainer")).toEqual(expected);
  });

  it("shows the Usage page to admins only", () => {
    expect(navItemsFor("admin").map((item) => item.id)).toContain("usage");
    expect(navItemsFor("maintainer").map((item) => item.id)).not.toContain("usage");
  });

  it("links the dashboard at /dashboard", () => {
    expect(navItemsFor(null)[0]?.href).toBe("/dashboard");
  });

  it("shows admins every item, admin pages in the admin section", () => {
    const items = navItemsFor("admin");
    expect(items.map((item) => item.title)).toEqual([
      "Dashboard",
      "Browse",
      "Repositories",
      "API keys",
      "Users",
      "Settings",
      "Usage",
      "Audit log",
    ]);
    expect(items.filter((item) => item.section === "admin").map((item) => item.href)).toEqual([
      "/admin/users",
      "/admin/settings",
      "/admin/stats",
      "/admin/audit",
    ]);
  });
});

describe("isNavActive", () => {
  it("matches a page exactly", () => {
    expect(isNavActive("/dashboard", "/dashboard")).toBe(true);
    expect(isNavActive("/browse/main", "/dashboard")).toBe(false);
  });

  it("matches a section and its sub pages but not lookalike prefixes", () => {
    expect(isNavActive("/browse", "/browse")).toBe(true);
    expect(isNavActive("/browse/main/dev.example/demo", "/browse")).toBe(true);
    expect(isNavActive("/browsers", "/browse")).toBe(false);
  });
});

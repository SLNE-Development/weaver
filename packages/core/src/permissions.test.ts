import { describe, expect, it } from "vitest";
import {
  canAccess,
  canDeleteVersions,
  canForce,
  canReadThroughGroup,
  groupMatches,
  isAdmin,
  maxKeyAccess,
  type Access,
  type Principal,
  type RepoRef,
  type Role,
} from "./permissions.js";

const priv: RepoRef = { id: "id-private", name: "private", visibility: "private" };
const pub: RepoRef = { id: "id-public", name: "public", visibility: "public" };

const user = (role: Role): Principal => ({ kind: "user", userId: "u1", role });
const key = (role: Role, access: Access = "write"): Principal => ({
  kind: "apikey",
  keyId: "k1",
  userId: "u1",
  role,
  permissions: [{ repositoryId: "id-private", repository: "private", groupPrefix: "dev.surf", access }],
});
const anon: Principal = { kind: "anonymous" };

describe("groupMatches", () => {
  it.each([
    [null, "anything.at.all", true],
    ["dev.surf", "dev.surf", true],
    ["dev.surf", "dev.surf.economy", true],
    ["dev.surf", "dev.surfboard", false],
    ["dev.surf", "dev", false],
    ["dev.surf", "dev.surf_x", false],
  ])("prefix %s vs %s -> %s", (prefix, group, expected) => {
    expect(groupMatches(prefix, group)).toBe(expected);
  });
});

describe("maxKeyAccess", () => {
  it("caps viewers at read", () => {
    expect(maxKeyAccess("viewer")).toBe("read");
    expect(maxKeyAccess("maintainer")).toBe("write");
    expect(maxKeyAccess("admin")).toBe("write");
  });
});

describe("canAccess", () => {
  it.each<[string, Principal, RepoRef, string, Access, boolean]>([
    ["anonymous reads public", anon, pub, "dev.surf", "read", true],
    ["anonymous cannot read private", anon, priv, "dev.surf", "read", false],
    ["anonymous never writes public", anon, pub, "dev.surf", "write", false],
    ["anonymous never writes private", anon, priv, "dev.surf", "write", false],
    ["viewer reads private", user("viewer"), priv, "x", "read", true],
    ["maintainer reads private", user("maintainer"), priv, "x", "read", true],
    ["admin reads private", user("admin"), priv, "x", "read", true],
    ["viewer user cannot write", user("viewer"), pub, "x", "write", false],
    ["maintainer user cannot write", user("maintainer"), priv, "x", "write", false],
    ["admin user cannot write", user("admin"), priv, "x", "write", false],
    ["key writes exact group", key("maintainer"), priv, "dev.surf", "write", true],
    ["key writes subgroup", key("maintainer"), priv, "dev.surf.economy", "write", true],
    ["key cannot write sibling group", key("maintainer"), priv, "dev.surfboard", "write", false],
    ["key cannot write other repository", key("maintainer"), pub, "dev.surf", "write", false],
    ["key reads public anywhere", key("maintainer"), pub, "other", "read", true],
    ["key reads scoped private group", key("maintainer"), priv, "dev.surf.x", "read", true],
    ["key cannot read private outside group", key("maintainer"), priv, "dev.surfboard", "read", false],
    ["demoted viewer key reads", key("viewer"), priv, "dev.surf", "read", true],
    ["demoted viewer key cannot write", key("viewer"), priv, "dev.surf", "write", false],
    ["read entry grants read", key("maintainer", "read"), priv, "dev.surf", "read", true],
    ["read entry never grants write", key("maintainer", "read"), priv, "dev.surf", "write", false],
    ["admin key writes", key("admin"), priv, "dev.surf", "write", true],
  ])("%s", (_name, p, repo, group, access, expected) => {
    expect(canAccess(p, repo, group, access)).toBe(expected);
  });

  it("null groupPrefix covers every group of the repository", () => {
    const p: Principal = {
      kind: "apikey",
      keyId: "k",
      userId: "u",
      role: "maintainer",
      permissions: [{ repositoryId: "id-private", repository: "private", groupPrefix: null, access: "write" }],
    };
    expect(canAccess(p, priv, "any.group", "write")).toBe(true);
  });
});

describe("canDeleteVersions", () => {
  it.each<[string, Principal, boolean]>([
    ["maintainer user", user("maintainer"), true],
    ["admin user", user("admin"), true],
    ["viewer user", user("viewer"), false],
    ["maintainer key with write", key("maintainer"), true],
    ["viewer-owned key", key("viewer"), false],
    ["read-only key", key("maintainer", "read"), false],
    ["anonymous", anon, false],
  ])("%s -> %s", (_name, p, expected) => {
    expect(canDeleteVersions(p, priv, "dev.surf")).toBe(expected);
  });

  it("key without write access to the group cannot delete", () => {
    expect(canDeleteVersions(key("maintainer"), priv, "dev.surfboard")).toBe(false);
  });
});

describe("canForce / isAdmin", () => {
  it("only admins and admin keys may force", () => {
    expect(canForce(user("admin"))).toBe(true);
    expect(canForce(key("admin"))).toBe(true);
    expect(canForce(user("maintainer"))).toBe(false);
    expect(canForce(key("maintainer"))).toBe(false);
    expect(canForce(anon)).toBe(false);
    expect(isAdmin(user("admin"))).toBe(true);
    expect(isAdmin(user("viewer"))).toBe(false);
  });
});

describe("groups", () => {
  const grp: RepoRef = { id: "id-group", name: "all", visibility: "private", kind: "group" };
  const withEntry = (access: Access, prefix: string | null = null): Principal => ({
    kind: "apikey",
    keyId: "k2",
    userId: "u1",
    role: "maintainer",
    permissions: [{ repositoryId: "id-group", repository: "all", groupPrefix: prefix, access }],
  });

  it("denies writes on a group even with a write entry for it", () => {
    expect(canAccess(withEntry("write"), grp, "", "write")).toBe(false);
    expect(canAccess(withEntry("write"), { ...grp, visibility: "public" }, "", "write")).toBe(false);
    expect(canDeleteVersions(withEntry("write"), grp, "")).toBe(false);
  });

  it("lets a read entry on the group read through it", () => {
    expect(canReadThroughGroup(withEntry("read"), grp)).toBe(true);
    expect(canReadThroughGroup(withEntry("write"), grp)).toBe(true);
  });

  it("does not let read on a member grant read through the group", () => {
    expect(canReadThroughGroup(key("maintainer", "read"), grp)).toBe(false);
    expect(canReadThroughGroup(anon, grp)).toBe(false);
    expect(canReadThroughGroup(anon, { ...grp, visibility: "public" })).toBe(true);
  });

  it("matches entries by repository id, not name", () => {
    expect(canAccess(key("maintainer"), { ...priv, id: "other" }, "dev.surf", "write")).toBe(false);
  });
});

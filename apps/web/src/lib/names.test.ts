import { describe, expect, it } from "vitest";
import * as core from "@weaver/core";
import { isValidGroupPrefix, isValidRepositoryName } from "./names";

const repositoryNames = ["main", "team-private", "a", "0abc", "-lead", "Upper", "with_underscore", "a".repeat(63), "a".repeat(64), ""];
const groups = ["com.acme", "com", "com.acme.orders-v2", "com_acme", "Com.acme", "com..acme", ".com", "com.", "com.-x", ""];

describe("client-side name rules", () => {
  it("accept exactly the repository names core accepts", () => {
    for (const name of repositoryNames) expect(isValidRepositoryName(name), name).toBe(core.isValidRepositoryName(name));
  });

  it("accept exactly the group prefixes core accepts", () => {
    for (const group of groups) expect(isValidGroupPrefix(group), group).toBe(core.isValidGroup(group));
  });
});

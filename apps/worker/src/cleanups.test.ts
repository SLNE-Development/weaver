import { describe, expect, it } from "vitest";
import { dockerCleanup } from "@weaver/docker";
import { cleanupRegistry } from "./cleanups.js";

describe("cleanupRegistry", () => {
  it("registers the docker cleanup beside maven, npm and proto", () => {
    const registry = cleanupRegistry();
    expect(Object.keys(registry).sort()).toEqual(["docker", "maven", "npm", "proto"]);
    expect(registry.docker).toBe(dockerCleanup);
  });
});

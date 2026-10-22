import { describe, expect, it } from "vitest";
import type { RegistryError } from "../errors.js";
import { defaultRepositoryConfig, parseRepositoryConfig, salvageRepositoryConfig, type Format, type Kind } from "./config.js";

const formats: Format[] = ["maven", "npm", "docker", "proto"];

const mirrorDefaults = {
  cache: { enabled: false, store: null, metadataTtlSeconds: 1800, maxAgeDays: null, maxSizeBytes: null },
  offline: false,
  rules: { allow: [], deny: [] },
};

const expected: Record<Format, Record<Kind, unknown>> = {
  maven: { hosted: { versionPolicy: "mixed", redeploy: false }, mirror: mirrorDefaults, group: {} },
  npm: { hosted: { redeploy: false }, mirror: mirrorDefaults, group: {} },
  docker: { hosted: { tagImmutable: false }, mirror: { ...mirrorDefaults, dockerHub: false }, group: {} },
  proto: {
    hosted: { allowRedeploy: false, allowReleases: true, allowSnapshots: true, resolutionPriority: 100 },
    mirror: mirrorDefaults,
    group: {},
  },
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as RegistryError).code;
  }
  return undefined;
}

describe("repository config", () => {
  it("defaults for every format×kind", () => {
    for (const format of formats) {
      for (const kind of ["hosted", "mirror", "group"] as const) {
        expect(defaultRepositoryConfig(format, kind)).toEqual(expected[format][kind]);
        expect(parseRepositoryConfig(format, kind, {})).toEqual(expected[format][kind]);
        expect(parseRepositoryConfig(format, kind, undefined)).toEqual(expected[format][kind]);
      }
    }
  });

  it("mirror cache disabled by default", () => {
    const config = parseRepositoryConfig("maven", "mirror", { cache: { metadataTtlSeconds: 60 } });
    expect(config.cache).toEqual({ enabled: false, store: null, metadataTtlSeconds: 60, maxAgeDays: null, maxSizeBytes: null });
  });

  it("fills missing keys and keeps given ones", () => {
    expect(parseRepositoryConfig("proto", "hosted", { allowRedeploy: true })).toEqual({
      allowRedeploy: true,
      allowReleases: true,
      allowSnapshots: true,
      resolutionPriority: 100,
    });
    expect(parseRepositoryConfig("maven", "hosted", { versionPolicy: "snapshot" })).toEqual({
      versionPolicy: "snapshot",
      redeploy: false,
    });
  });

  it("rejects unknown keys and negative ttl with invalid_request", () => {
    expect(codeOf(() => parseRepositoryConfig("maven", "hosted", { bogus: true }))).toBe("invalid_request");
    expect(codeOf(() => parseRepositoryConfig("maven", "mirror", { cache: { bogus: 1 } }))).toBe("invalid_request");
    expect(codeOf(() => parseRepositoryConfig("npm", "mirror", { cache: { metadataTtlSeconds: -1 } }))).toBe("invalid_request");
    expect(codeOf(() => parseRepositoryConfig("npm", "group", { offline: true }))).toBe("invalid_request");
    expect(codeOf(() => parseRepositoryConfig("npm", "hosted", { redeploy: true }))).toBe("invalid_request");
    expect(codeOf(() => parseRepositoryConfig("proto", "hosted", "nope"))).toBe("invalid_request");
  });

  it("salvages stale stored configs: drops unknown keys and replaces invalid values with defaults", () => {
    expect(salvageRepositoryConfig("proto", "hosted", { allowRedeploy: true, resolutionPriority: 5 })).toEqual({
      config: { allowRedeploy: true, allowReleases: true, allowSnapshots: true, resolutionPriority: 5 },
      repaired: false,
    });
    expect(salvageRepositoryConfig("proto", "hosted", { allowRedeploy: true, resolutionPriority: -3, legacy: 1 })).toEqual({
      config: { allowRedeploy: true, allowReleases: true, allowSnapshots: true, resolutionPriority: 100 },
      repaired: true,
    });
    expect(salvageRepositoryConfig("npm", "mirror", "garbage").config).toEqual(expected.npm.mirror);
    expect(
      salvageRepositoryConfig("docker", "mirror", { dockerHub: true, rules: { allow: ["x*"], deny: [""] }, cache: 7 }).config,
    ).toEqual({ ...mirrorDefaults, dockerHub: true, rules: { allow: ["x*"], deny: [] } });
  });

  it("dockerHub only accepted for docker mirrors", () => {
    expect(parseRepositoryConfig("docker", "mirror", { dockerHub: true }).dockerHub).toBe(true);
    for (const format of ["maven", "npm", "proto"] as const) {
      expect(codeOf(() => parseRepositoryConfig(format, "mirror", { dockerHub: true }))).toBe("invalid_request");
    }
    expect(codeOf(() => parseRepositoryConfig("docker", "hosted", { dockerHub: true }))).toBe("invalid_request");
  });
});

import { describe, expect, it } from "vitest";
import { npmClientConfig, npmPackageHref } from "./npm-config";

describe("npmPackageHref", () => {
  it("encodes the scope but keeps the separating slash", () => {
    expect(npmPackageHref("npm-hosted", "@acme/ui")).toBe("/browse/npm-hosted/-/npm/%40acme/ui");
    expect(npmPackageHref("r", "left-pad")).toBe("/browse/r/-/npm/left-pad");
  });
});

describe("npmClientConfig", () => {
  it("writes the registry and token lines of .npmrc", () => {
    expect(npmClientConfig("https://weaver.slne.dev", "npm-group").npmrc).toBe(
      "registry=https://weaver.slne.dev/npm/npm-group/\n//weaver.slne.dev/npm/npm-group/:_authToken=${WEAVER_TOKEN}",
    );
  });

  it("scopes the registry line when a scope is given", () => {
    const { npmrc } = npmClientConfig("https://weaver.slne.dev/", "npm-group", "acme");
    expect(npmrc.startsWith("@acme:registry=https://weaver.slne.dev/npm/npm-group/\n")).toBe(true);
    expect(npmrc).toContain("//weaver.slne.dev/npm/npm-group/:_authToken=${WEAVER_TOKEN}");
  });

  it("writes .yarnrc.yml for the default and a scoped registry", () => {
    expect(npmClientConfig("https://weaver.slne.dev", "r").yarnrc).toBe(
      'npmRegistryServer: "https://weaver.slne.dev/npm/r/"\nnpmAuthToken: "${WEAVER_TOKEN}"\nnpmAlwaysAuth: true',
    );
    expect(npmClientConfig("https://weaver.slne.dev", "r", "acme").yarnrc).toBe(
      'npmScopes:\n  acme:\n    npmRegistryServer: "https://weaver.slne.dev/npm/r/"\n    npmAuthToken: "${WEAVER_TOKEN}"\n    npmAlwaysAuth: true',
    );
  });

  // yarn berry sends npmAuthToken for unscoped packages only with npmAlwaysAuth, so with the old snippet every
  // unscoped install from a private repository failed with "Invalid authentication (as an anonymous user)".
  it("makes yarn berry send the token for unscoped packages too", () => {
    expect(npmClientConfig("https://weaver.slne.dev", "r").yarnrc).toMatch(/^npmAlwaysAuth: true$/m);
  });

  it("writes bunfig.toml for the default and a scoped registry", () => {
    expect(npmClientConfig("https://weaver.slne.dev", "r").bunfig).toBe(
      '[install]\nregistry = { url = "https://weaver.slne.dev/npm/r/", token = "$WEAVER_TOKEN" }',
    );
    expect(npmClientConfig("https://weaver.slne.dev", "r", "acme").bunfig).toBe(
      '[install.scopes]\nacme = { url = "https://weaver.slne.dev/npm/r/", token = "$WEAVER_TOKEN" }',
    );
  });
});

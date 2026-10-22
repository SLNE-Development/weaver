/** Client configuration files that point npm, pnpm, yarn and bun at one Weaver npm repository. */
export interface NpmClientConfig {
  /** `.npmrc` (npm, pnpm, yarn classic). */
  npmrc: string;
  /** `.yarnrc.yml` (yarn berry). */
  yarnrc: string;
  /** `bunfig.toml` (bun). */
  bunfig: string;
}

/**
 * The client configuration for `repo` on the Weaver instance at `publicUrl`: the registry (for `scope` only when one
 * is given, without the leading `@`) plus a token read from the `WEAVER_TOKEN` environment variable.
 */
export function npmClientConfig(publicUrl: string, repo: string, scope?: string): NpmClientConfig {
  const registry = `${publicUrl.replace(/\/+$/, "")}/npm/${repo}/`;
  const hostPath = registry.replace(/^https?:/, "");
  const token = "${WEAVER_TOKEN}";
  const npmrc = [`${scope ? `@${scope}:registry` : "registry"}=${registry}`, `${hostPath}:_authToken=${token}`].join("\n");
  // yarn berry sends the token for unscoped packages only with npmAlwaysAuth; a private repository needs it.
  const yarnrc = scope
    ? ["npmScopes:", `  ${scope}:`, `    npmRegistryServer: "${registry}"`, `    npmAuthToken: "${token}"`, "    npmAlwaysAuth: true"].join("\n")
    : [`npmRegistryServer: "${registry}"`, `npmAuthToken: "${token}"`, "npmAlwaysAuth: true"].join("\n");
  const entry = `{ url = "${registry}", token = "$WEAVER_TOKEN" }`;
  const bunfig = scope ? ["[install.scopes]", `${scope} = ${entry}`].join("\n") : ["[install]", `registry = ${entry}`].join("\n");
  return { npmrc, yarnrc, bunfig };
}

/** The browse page of an npm package, e.g. `/browse/npm-hosted/-/npm/%40acme/ui`. */
export function npmPackageHref(repository: string, name: string): string {
  return `/browse/${encodeURIComponent(repository)}/-/npm/${name.split("/").map(encodeURIComponent).join("/")}`;
}

import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

const monorepoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Secrets live only in the repo-root `.env`. Load it before anything reads the environment;
// `src/env.ts` validates it when the server starts (instrumentation) and refuses to boot if invalid.
// forceReload: Next has already loaded (and cached) the env files of apps/web by the time this runs.
loadEnvConfig(monorepoRoot, process.env.NODE_ENV !== "production", undefined, true);

const config: NextConfig = {
  output: "standalone",
  // Protocol clients (Maven, npm, Docker) address `/v2/` and `/maven/x/` exactly; never redirect them.
  skipTrailingSlashRedirect: true,
  outputFileTracingRoot: monorepoRoot,
  transpilePackages: ["@weaver/ui"],
  serverExternalPackages: ["pg"],
  // `next build` type-checks the app only; tests (some import other workspaces' sources, which the
  // Docker build prunes away) are checked by the `typecheck` script against tsconfig.json.
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // Workspace packages are bundled but read files at runtime that the tracer cannot see:
  // @weaver/db its SQL migrations, @weaver/core the buf binary of the installed platform package.
  outputFileTracingIncludes: {
    "/*": [
      "../../packages/db/drizzle/**/*",
      "../../packages/core/node_modules/@bufbuild/buf/package.json",
      "../../node_modules/.pnpm/@bufbuild+buf*/node_modules/@bufbuild/*/package.json",
      "../../node_modules/.pnpm/@bufbuild+buf*/node_modules/@bufbuild/*/bin/**/*",
    ],
    // Share cards (any route's opengraph-image, /og/**) read these fonts through apps/web/node_modules.
    "/**": [
      "./node_modules/@fontsource/geist/files/geist-latin-{400,600}-normal.woff",
      "./node_modules/@fontsource/geist-mono/files/geist-mono-latin-{400,500}-normal.woff",
    ],
    // The sitemap lists the docs pages by reading content/docs at request time.
    "/sitemap.xml": ["./content/docs/**/*.md"],
    // The docs read their Markdown at request time, and their share cards read WOFF fonts.
    "/docs/**/*": ["./content/docs/**/*"],
    "/og/docs/**/*": [
      "./content/docs/**/*",
      "./node_modules/@fontsource/geist/files/geist-latin-*-normal.woff",
      "./node_modules/@fontsource/geist-mono/files/geist-mono-latin-*-normal.woff",
    ],
  },
};

export default config;

import { fileURLToPath } from "node:url";

/**
 * Port of the Next.js server the e2e tests run against: 3100 (not 3000, so a dev server can keep
 * running), or `E2E_PORT` to run several checkouts' e2e suites side by side.
 */
export const PORT = Number(process.env.E2E_PORT || 3100);

export const BASE_URL = `http://localhost:${PORT}`;

/** Dummy auth secret of the e2e server; real secrets never reach the tests. */
export const AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123456";

/** Where the server script records the test database URL for the global setup. */
export const STATE_FILE = fileURLToPath(new URL("../.e2e/state.json", import.meta.url));

/**
 * Session cookie of Better Auth on a plain-http base URL (on https it carries the `__Secure-`
 * prefix).
 */
export const SESSION_COOKIE = "better-auth.session_token";

/** Users the global setup seeds, each with a ready session. */
export const USERS = {
  admin: { id: "e2e-admin", name: "Ada Admin", email: "admin@e2e.test", role: "admin" },
  maintainer: { id: "e2e-maintainer", name: "Max Maintainer", email: "maintainer@e2e.test", role: "maintainer" },
  viewer: { id: "e2e-viewer", name: "Vera Viewer", email: "viewer@e2e.test", role: "viewer" },
  /** A viewer whose only sign-in method is a connected GitHub account. */
  githubViewer: { id: "e2e-github-viewer", name: "Gil Hub", email: "github@e2e.test", role: "viewer" },
} as const;

/** Invite tokens the global setup seeds. */
export const INVITES = {
  viewer: "e2e-invite-viewer-token",
  expired: "e2e-invite-expired-token",
} as const;

/** Repositories the browse fixtures are published to (see `seed-artifacts.ts`). */
export const ARTIFACTS = {
  releases: "releases",
  snapshots: "snapshots",
  /** A public proto mirror with caching off. */
  mirror: "upstream-protos",
  /** A public proto group of `releases` and the mirror. */
  group: "all-protos",
} as const;

/** The upstream URL of the seeded proto mirror; nothing listens there. */
export const MIRROR_UPSTREAM = "https://protos.example.invalid/api/v1";

/** The seeded session token of `userId`. */
export function sessionToken(userId: string): string {
  return `e2e-session-${userId}`;
}

/**
 * The environment of the e2e server. Every variable `src/env.ts` knows is set explicitly (empty
 * means unset), so nothing from a local `.env` (which `next.config.ts` loads without overriding
 * existing variables) leaks into the tests. GitHub is the only OAuth provider. `DATABASE_URL` is
 * added by `serve.ts` once the test database runs.
 */
export function serverEnv(): Record<string, string> {
  return {
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_PATH: fileURLToPath(new URL("../.e2e/storage", import.meta.url)),
    S3_ENDPOINT: "",
    S3_BUCKET: "",
    S3_REGION: "",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
    VALKEY_URL: "",
    BETTER_AUTH_SECRET: AUTH_SECRET,
    BETTER_AUTH_URL: BASE_URL,
    INITIAL_ADMIN: "",
    GITHUB_CLIENT_ID: "e2e-github-client-id",
    GITHUB_CLIENT_SECRET: "e2e-github-client-secret",
    DISCORD_CLIENT_ID: "",
    DISCORD_CLIENT_SECRET: "",
    SKIP_ENV_VALIDATION: "",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

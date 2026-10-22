import type { Db } from "@weaver/db";
import type { AssetService } from "./content/assets.js";
import type { UsageInput } from "./content/usage.js";
import type { MirrorEngine } from "./mirror/index.js";
import type { Principal } from "./permissions.js";
import type { RepoService } from "./repos/index.js";
import type { ServerSettings } from "./settings.js";
import type { StoreSet } from "./storage/index.js";

/** Everything a package-format protocol handler (Maven, npm, Docker) works with. */
export interface FormatDeps {
  db: Db;
  stores: StoreSet;
  repos: RepoService;
  assets: AssetService;
  mirror: MirrorEngine;
  /** Resolves who makes the request; throws `RegistryError("unauthorized")` for a bad token. */
  principal(req: Request): Promise<Principal>;
  /** The current server settings. */
  settings(): Promise<ServerSettings>;
  /** The public base URL (`BETTER_AUTH_URL`) without a trailing slash. */
  publicUrl: string;
  /** AES key for upstream credentials, derived from `BETTER_AUTH_SECRET`. */
  secretKey: Buffer;
  /** Records a download, upload or delete; never throws. */
  usage(input: UsageInput): Promise<void>;
}

/**
 * Serves one format mount. `rest` is the raw, still percent-encoded path after the mount prefix,
 * without a leading slash ("" for the prefix itself).
 */
export type FormatHandler = (req: Request, rest: string) => Promise<Response>;

/** Builds a format's handler from the shared dependencies. */
export type FormatFactory = (deps: FormatDeps) => FormatHandler;

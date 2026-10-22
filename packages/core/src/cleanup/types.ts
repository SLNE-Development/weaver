import type { cleanupPolicy, Db } from "@weaver/db";
import type { AssetService } from "../content/assets.js";
import type { Format } from "../repos/config.js";
import type { Repo, RepoService } from "../repos/service.js";
import type { StoreSet } from "../storage/index.js";

/** A stored cleanup policy row. */
export type CleanupPolicyRow = typeof cleanupPolicy.$inferSelect;

/** What a format cleanup works with. */
export interface CleanupDeps {
  db: Db;
  stores: StoreSet;
  assets: AssetService;
  repos: RepoService;
}

/** One deletion: `key` is stable per item (e.g. "maven:g:a:1.0-SNAPSHOT#3"), `label` is shown in previews. */
export interface CleanupCandidate {
  repository: string;
  key: string;
  label: string;
  reason: string;
}

/** The cleanup of one format: plans and applies that format's policy kinds on a hosted repository. */
export interface FormatCleanup {
  format: Format;
  /** Plans with the enabled policies; when !dryRun re-plans under the format's own locking and deletes, returning what was deleted. */
  run(
    deps: CleanupDeps,
    repo: Repo,
    policies: CleanupPolicyRow[],
    now: Date,
    opts: { dryRun: boolean },
  ): Promise<CleanupCandidate[]>;
}

/** The installed format cleanups by format; a format without an entry has no cleanup. */
export type CleanupRegistry = Partial<Record<Format, FormatCleanup>>;

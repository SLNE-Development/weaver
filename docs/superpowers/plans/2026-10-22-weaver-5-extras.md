# Weaver Extras Implementation Plan (search, usage stats, cleanup policies)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the cross-format v1 extras on top of the core and the four format plans: cleanup policies for every
format, permission-filtered search across all readable repositories, and usage statistics (downloads over time,
storage, mirror cache hit rate, per-token activity).

**Architecture:** Each format package exposes a `FormatCleanup` (defined in `@weaver/core`) that plans and applies
its own policy kinds; a core runner dispatches by `repo.format` and only touches hosted repos. Search runs on the
core `component` table with a `pg_trgm`-indexed generated `search_text` column. Stats are rolled up hourly by a
`stats:rollup` job on `MAINTENANCE_QUEUE` from `usage_event` into daily tables; raw events are kept 90 days.

**Tech Stack:** TypeScript 6, Drizzle ORM 0.45 on PostgreSQL 17 (`pg_trgm`), BullMQ on Valkey, tRPC 11, Next.js 16,
React 19, `@weaver/ui` chart (Recharts 3.8.0), Vitest 5 with Testcontainers, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-weaver-design.md` (sections "Extras", "Auth and permissions")
**Depends on:** `2026-10-22-weaver-0-core.md` and plans 1-4 (proto, maven, npm, docker), all executed first.

## Global Constraints

- Product name **Weaver**; workspace scope `@weaver/*`, env vars `WEAVER_*`, log prefix `weaver:`.
- Mirror caches are governed by eviction settings, not cleanup policies: cleanup never touches mirror or group repos.
- Browse and search show only what Weaver stores: hosted content and mirror caches.
- Read permission on a group grants read of everything served through it.
- Admin UI stays minimal: format-specific options appear only for the format they apply to.
- Commit messages: Conventional Commits in English, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every exported function, type and component gets a doc comment saying what it does (repo convention).
- Pin new dependencies to exact versions, like the existing `package.json` files.
- Migrations are generated with `pnpm --filter @weaver/db db:generate`; take the next free number after plans 1-4.

## Review Focus

1. **Untagged but referenced Docker manifests** — child manifests of a multi-arch index and referrers (cosign
   signatures, SBOMs with an OCI `subject`) are untagged by nature; `delete_untagged_manifests` must keep them while
   their index/subject exists. Pinned in Task 5 (`keeps index children and live referrers`).
2. **npm cleanup removing a dist-tagged version** — deleting the version `latest` points to breaks `npm install pkg`;
   versions targeted by any dist-tag are never deleted. Pinned in Task 4 (`never deletes a dist-tagged version`).
3. **Docker images pulled by digest** — Kubernetes pins `image@sha256:…`; such pulls count as pulls of every tag
   pointing at that digest for `delete_not_downloaded`. Pinned in Task 5 (`digest pulls keep the tag`).
4. **Search leaking private repos** — a caller must never see packages of repos they cannot read, a proto key with a
   group prefix sees only that prefix, and packages reached only through a readable group are attributed to the group.
   Pinned in Task 6 (`permission filtering`).
5. **Rollup after worker downtime or re-runs** — re-running the rollup must not double count, a gap of several days is
   back-filled, and retention never deletes events of a day that is not rolled up. Pinned in Task 8.

## Decisions

- **Cleanup kinds** (enum `cleanup_kind` gains three values): maven/proto `keep_last_snapshot_builds`,
  `delete_stale_snapshots`, `delete_not_downloaded` (+ `includeReleases`); npm `delete_not_downloaded`,
  `keep_last_versions`; docker `delete_untagged_manifests`, `keep_last_tags`, `delete_not_downloaded` (labelled
  "Delete tags not pulled"). `delete_not_downloaded` is reused across formats; `includeReleases` only means something
  for maven/proto. New nullable column `pattern` (glob, `*` only, same semantics as `matchesRules`) is required for
  `keep_last_tags` and rejected for every other kind. `groupPrefix` is the scope for every format (proto group, Maven
  groupId, npm package name prefix incl. `@scope/`, docker image prefix); a plain string prefix except for proto,
  which keeps `isValidGroup`. `delete_untagged_manifests.value` is a grace period in days (min 1) so an in-flight
  multi-step push is never swept.
- **Docker tag deletion** also deletes the manifest when it is left untagged and unreferenced, then the run calls
  docker GC once if anything was deleted. Preview never deletes or collects.
- **Days rules** keep today's guard: values below 1 day are treated as 1 (`cutoff()`); "not downloaded" uses
  `lastDownloadedAt ?? createdAt`.
- **Search** matches on `component.search_text = btrim(lower(translate(namespace || ' ' || name, ':/', '  ')))`
  (stored generated column, GIN `gin_trgm_ops`). The query is normalised the same way and split into terms (max 5);
  every term must be contained (`LIKE`). Pasted coordinates work: a trailing version segment (`g:a:1.0`,
  `group:name:1.0`, `pkg@1.2.3`, `@s/p@1.2.3`, `image:tag`) is tried both with and without the last segment. Ranking:
  exact `search_text` match, then prefix match, then `similarity()` desc, then lifetime downloads desc, then label.
  Results are one row per package (repo + namespace + name); `latestVersion` is the most recently created component.
  Mirror components appear only when they have at least one asset.
- **Stats granularity:** UTC days. Rollup runs hourly (`stats-hourly`, `41 * * * *`), recomputing every day from the
  newest rolled-up day through today. Raw `usage_event` rows are kept **90 days**; daily rollups forever; daily storage
  snapshots 400 days. Downloads are rolled up per package (namespace + name), not per version (lifetime per-version
  counts stay on `component.downloadCount`).
- **Cache hit rate** = (`hit` + `stale`) / (`hit` + `stale` + `miss`); `bypass` (caching off) is shown separately and
  excluded; `null` when the denominator is 0.
- **Visibility of stats:** admin overview at `/admin/stats` (nav "Usage", admins only); per-repo stats at
  `/browse/[repo]/stats` for anyone who can read the repo (group stats aggregate their members); token activity at
  `/keys/[id]/activity` for the token owner and admins only. Session and anonymous traffic is counted in downloads but
  has no token activity.
- **Storage per repo** = sum of `asset.size` by origin, plus `proto_build.size_bytes` for proto repos, plus the docker
  hook for docker repos (logical size: every blob referenced by the repo's manifests counted once per repo, even though
  blobs are deduplicated in the store). Computed by the rollup job into `storage_snapshot`; pages show the latest
  snapshot and its time.

---

### Task 1: Cleanup contract, kinds and runner

**Files:**
- Create: `packages/core/src/cleanup/types.ts`, `packages/core/src/cleanup/kinds.ts`, `packages/core/src/cleanup/runner.ts`, `packages/core/src/cleanup/index.ts`
- Move: `packages/core/src/cleanup.ts` → `packages/core/src/cleanup/proto.ts` (and its test to `packages/core/src/cleanup/proto.test.ts`)
- Modify: `packages/core/src/index.ts`, `packages/core/package.json` (subpath export `./cleanup-kinds` → `dist/cleanup/kinds.js`)
- Modify: `packages/db/src/schema/repository.ts` (`cleanupKindEnum`, `cleanupPolicy.pattern`); Create: `packages/db/drizzle/00NN_cleanup_kinds.sql` (generated)
- Modify: `apps/worker/src/worker.ts`, `apps/worker/src/index.ts`; Create: `apps/worker/src/cleanups.ts`, `apps/web/src/server/cleanups.ts`
- Test: `packages/core/src/cleanup/runner.test.ts`, `packages/core/src/cleanup/kinds.test.ts`, `apps/worker/src/worker.test.ts`

**Interfaces:**
- Consumes: core `Repo`, `RepoService`, `AssetService`, `StoreSet`, `Db`, `Format`, `MaintenanceJobData`; existing proto planning in `cleanup.ts`.
- Produces:
  ```ts
  // @weaver/core/cleanup-kinds (pure, safe for client bundles)
  const CLEANUP_KINDS = ["keep_last_snapshot_builds","delete_stale_snapshots","delete_not_downloaded","keep_last_versions","delete_untagged_manifests","keep_last_tags"] as const;
  type CleanupKind = (typeof CLEANUP_KINDS)[number];
  const CLEANUP_KINDS_BY_FORMAT: Record<Format, readonly CleanupKind[]>; // per Decisions, in that order
  /** Whether `pattern` is required (keep_last_tags), forbidden (others). */
  function kindUsesPattern(kind: CleanupKind): boolean;
  // @weaver/core
  type CleanupPolicyRow = typeof cleanupPolicy.$inferSelect; // id, repositoryId, kind, value, includeReleases, groupPrefix, pattern, enabled, createdAt
  interface CleanupDeps { db: Db; stores: StoreSet; assets: AssetService; repos: RepoService }
  /** One deletion: `key` is stable per item (e.g. "maven:g:a:1.0-SNAPSHOT#3"), `label` is shown in previews. */
  interface CleanupCandidate { repository: string; key: string; label: string; reason: string }
  interface FormatCleanup {
    format: Format;
    /** Plans with the enabled policies; when !dryRun re-plans under the format's own locking and deletes, returning what was deleted. */
    run(deps: CleanupDeps, repo: Repo, policies: CleanupPolicyRow[], now: Date, opts: { dryRun: boolean }): Promise<CleanupCandidate[]>;
  }
  type CleanupRegistry = Partial<Record<Format, FormatCleanup>>;
  /** not_found for an unknown repo; [] for mirror/group repos, repos without enabled policies, or formats not in the registry. Records audit "cleanup.run" when something was deleted. */
  function runRepoCleanup(deps: CleanupDeps, registry: CleanupRegistry, repoName: string, now: Date, opts: { dryRun: boolean }): Promise<CleanupCandidate[]>;
  /** Every hosted repo under advisory lock 727001 (skips with 0 when held); returns the number deleted. */
  function runAllCleanups(deps: CleanupDeps, registry: CleanupRegistry, now: Date): Promise<number>;
  const protoCleanup: FormatCleanup; // the existing proto planner/applier, behaviour unchanged
  // apps/worker/src/cleanups.ts and apps/web/src/server/cleanups.ts
  function cleanupRegistry(): CleanupRegistry; // proto now; Tasks 3-5 add maven, npm, docker
  ```
  `planCleanup`/`applyCleanup`/old `runAllCleanups(db, blobs, now)` are removed from the public API.
- Worker: `cleanup:all` → `runAllCleanups`, `cleanup:repo` → `runRepoCleanup(..., {dryRun:false})` (not_found stays `UnrecoverableError`); job result `{ deleted: number }` unchanged.

- [ ] **Step 1: Write failing tests**
  - kinds: `CLEANUP_KINDS_BY_FORMAT.docker` equals `["delete_untagged_manifests","keep_last_tags","delete_not_downloaded"]`; `npm` equals `["delete_not_downloaded","keep_last_versions"]`; `maven` and `proto` equal `["keep_last_snapshot_builds","delete_stale_snapshots","delete_not_downloaded"]`; every kind appears for at least one format; `kindUsesPattern("keep_last_tags") === true`, all others false.
  - runner (Testcontainers DB, fake `FormatCleanup` that records calls): `skips mirror and group repos` (fake never called, result `[]`); `passes only enabled policies in createdAt order`; `dryRun true is forwarded and nothing is audited`; `records cleanup.run audit with the deleted count`; `unknown repo throws not_found`; `runAllCleanups returns 0 while the advisory lock is held`.
  - moved proto tests keep passing unchanged except for the new call shape (`protoCleanup.run`).
  - migration: inserting a policy with kind `keep_last_tags` and `pattern = 'v*'` succeeds.
  - worker: a `cleanup:repo` job for a proto repo with `keep_last_snapshot_builds = 1` and 3 builds completes with `{ deleted: 2 }`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/core test -- cleanup` → FAIL (missing `runRepoCleanup`).
- [ ] **Step 3:** Implement. Add the three enum values and `pattern text null` to the schema, run `pnpm --filter @weaver/db db:generate` (emits `ALTER TYPE "cleanup_kind" ADD VALUE ...` and `ALTER TABLE ... ADD COLUMN "pattern"`). Port `cleanup.ts` into `protoCleanup.run`, keeping its lock/re-check logic; its candidate `key` is `proto:<coordinate>#<build|all>` and `label` `<group>:<name>:<version>` plus ` build <n>` for builds.
- [ ] **Step 4:** Run `pnpm --filter @weaver/db test && pnpm --filter @weaver/core test && pnpm --filter @weaver/worker test` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add packages/core packages/db apps/worker apps/web/src/server/cleanups.ts
  git commit -m "feat(core): add per-format cleanup contract and runner" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Task 2: Policy API and UI per format

**Files:**
- Modify: `apps/web/src/server/trpc/routers/policies.ts`, `apps/web/src/lib/cleanup-policies.ts`
- Modify: `apps/web/src/app/(app)/repositories/[repo]/settings/{cleanup-policies,policy-dialog,repository-settings}.tsx`
- Test: `apps/web/src/server/trpc/routers.test.ts`, `apps/web/src/lib/cleanup-policies.test.ts`, `apps/web/e2e/manage-repos-keys.spec.ts`

**Interfaces:**
- Consumes: Task 1 `CLEANUP_KINDS`, `CLEANUP_KINDS_BY_FORMAT`, `kindUsesPattern`, `runRepoCleanup`, `cleanupRegistry()` (web).
- Produces: `CleanupPolicy` gains `pattern: string | null` and `kind: CleanupKind`; `policies.upsert` input gains `pattern?: string | null`; `CleanupPreviewItem` becomes `{ repository: string; key: string; label: string; reason: string }`; new query `policies.kinds({ repository }) → CleanupKind[]`. `lib/cleanup-policies.ts` exports `policyKindInfo(format: Format, kind: CleanupKind): { title: string; description: string; unit: "builds" | "versions" | "tags" | "days"; scopeLabel: string }` and `describePolicy(format, policy)`.

- [ ] **Step 1: Write failing tests**
  - router: `upsert rejects a kind of another format` (npm repo + `keep_last_snapshot_builds` → `BAD_REQUEST` "keep_last_snapshot_builds is not a cleanup kind for npm repositories"); `upsert on a mirror or group repo` → `BAD_REQUEST` with message exactly `Cleanup policies apply to hosted repositories; mirror caches are governed by eviction settings`; `keep_last_tags without pattern` → `BAD_REQUEST`; `pattern on another kind` → `BAD_REQUEST`; `includeReleases true on npm or docker` → `BAD_REQUEST`; `preview returns label and reason from the format cleanup`; `kinds returns the format's kinds`.
  - lib: `describePolicy("docker", {kind:"keep_last_tags", value:5, pattern:"v*"})` → `"Keep the last 5 tags matching v*"`; `describePolicy("docker", {kind:"delete_not_downloaded", value:30})` → `"Delete tags not pulled for 30 days"`; `describePolicy("npm", {kind:"keep_last_versions", value:1})` → `"Keep the last version of each package"`; `describePolicy("docker", {kind:"delete_untagged_manifests", value:7})` → `"Delete untagged manifests older than 7 days"`.
  - Playwright: on a docker hosted repo's settings page the kind select lists exactly the three docker kinds, the pattern field appears only for "Keep last N tags", "Include releases" is absent; a mirror repo's settings page has no cleanup section and shows `Mirror caches are cleaned up by the eviction settings above.`
- [ ] **Step 2:** Run `pnpm --filter web test -- policies cleanup-policies` → FAIL.
- [ ] **Step 3:** Implement. Scope labels: proto "Group prefix", maven "groupId prefix", npm "Package prefix", docker "Image prefix". Preview table shows `label` and `reason`.
- [ ] **Step 4:** Run `pnpm --filter web test && pnpm --filter web e2e -- manage-repos-keys` → PASS.
- [ ] **Step 5:** Commit `feat(web): show and validate cleanup policy kinds per format` (with the Co-Authored-By trailer).

### Task 3: Maven cleanup

**Files:**
- Create: `packages/maven/src/cleanup.ts`; Modify: `packages/maven/src/index.ts` (export `mavenCleanup`, and `regenerateMetadata` if plan 2 does not export it)
- Modify: `apps/worker/src/cleanups.ts`, `apps/web/src/server/cleanups.ts`, `apps/worker/package.json` (`"@weaver/maven": "workspace:*"` if missing)
- Test: `packages/maven/src/cleanup.test.ts`

**Interfaces:**
- Consumes: Task 1 `FormatCleanup`, `CleanupDeps`; plan 2's maven `FormatFactory` (to publish in tests) and its metadata generator.
- Required maven primitive (add as a thin wrapper over plan 2's generator if it is named differently):
  ```ts
  /** Rewrites artifact-level maven-metadata.xml (+ checksums) from the remaining assets and each remaining SNAPSHOT version's version-level metadata; deletes them when no version remains. */
  function regenerateMetadata(deps: { db: Db; assets: AssetService }, repo: Repo, groupId: string, artifactId: string): Promise<void>;
  ```
- Component contract (asserted, not changed): one `component` per `(namespace = groupId, name = artifactId, version)`; snapshot = version ends with `-SNAPSHOT`; snapshot build = the `<timestamp>-<buildNumber>` in a file name under a SNAPSHOT version directory.
- Produces: `mavenCleanup: FormatCleanup` (format `"maven"`). Candidate keys `maven:<g>:<a>:<v>#<buildNumber>` and `maven:<g>:<a>:<v>#all`.

- [ ] **Step 1: Write failing tests** (Testcontainers DB + local store; publish with plain `PUT` Requests against the maven handler):
  - `publish registers one component per groupId, artifactId and version` (asserts the contract).
  - `keep_last_snapshot_builds 2 deletes all files of older builds and their checksums` — 4 timestamped builds of `1.0-SNAPSHOT` (jar + pom + `.sha1`); after the run only builds 3 and 4 remain; `GET .../1.0-SNAPSHOT/maven-metadata.xml` lists only builds 3 and 4 and `<buildNumber>4</buildNumber>`.
  - `delete_stale_snapshots 30 deletes a snapshot version not published to for 30 days` (fake clock) and keeps releases; artifact-level metadata no longer lists it.
  - `delete_not_downloaded 30 without includeReleases spares releases`; `with includeReleases deletes an unused release`; a version downloaded 5 days ago survives.
  - `groupPrefix limits the scope` (`org.example` touches `org.example.lib`, not `com.other`).
  - `dryRun returns candidates and deletes nothing`; `deleting the last version removes artifact metadata` (GET → 404).
- [ ] **Step 2:** Run `pnpm --filter @weaver/maven test -- cleanup` → FAIL.
- [ ] **Step 3:** Implement on `component`/`asset` rows via `AssetService.delete` (component row deleted when its last asset goes), serialising per artifact with `pg_advisory_xact_lock(hashtext('maven:' || repoId || ':' || g || ':' || a))`, which plan 2's publish path also takes (add the lock there if missing). Register in both `cleanupRegistry()` files.
- [ ] **Step 4:** Run `pnpm --filter @weaver/maven test && pnpm --filter @weaver/worker test` → PASS.
- [ ] **Step 5:** Commit `feat(maven): add snapshot and download based cleanup` (with the trailer).

### Task 4: npm cleanup

**Files:**
- Create: `packages/npm/src/cleanup.ts`; Modify: `packages/npm/src/index.ts`
- Modify: `apps/worker/src/cleanups.ts`, `apps/web/src/server/cleanups.ts`, `apps/worker/package.json`
- Test: `packages/npm/src/cleanup.test.ts`

**Interfaces:**
- Consumes: Task 1 contract; plan 3's npm handler (publish via `PUT /<repo>/<pkg>` Requests) and its unpublish code.
- Required npm primitives (wrap plan 3's unpublish/dist-tag code if named differently):
  ```ts
  /** Removes the versions (tarballs, packument entries, components); deletes the whole package when none remain. Never touches dist-tags' targets — callers exclude them. */
  function removeVersions(deps: { db: Db; assets: AssetService }, repo: Repo, packageName: string, versions: string[]): Promise<void>;
  function distTags(deps: { db: Db }, repo: Repo, packageName: string): Promise<Record<string, string>>;
  ```
- Component contract: `namespace = "@scope"` or `""`, `name` without scope, `version`; label `@scope/name` or `name`.
- Produces: `npmCleanup: FormatCleanup` (format `"npm"`); keys `npm:<package>@<version>`.

- [ ] **Step 1: Write failing tests:**
  - `publish registers a component per version with the scope as namespace` (contract).
  - `keep_last_versions 2 keeps the two newest by publish time` — 4 versions, `latest` → newest; after run versions 3 and 4 remain and `GET /<repo>/<pkg>` packument has exactly those in `versions` and `time`.
  - `never deletes a dist-tagged version` — 4 versions, `latest` → 1.0.0, `keep_last_versions 1` leaves 1.0.0 and 4.0.0.
  - `delete_not_downloaded 30 removes versions not downloaded for 30 days` (fake clock; one version downloaded 2 days ago survives); tarball GET → 404 for removed ones.
  - `scoped package with groupPrefix "@acme/" is in scope, "other" is not`.
  - `dryRun deletes nothing`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/npm test -- cleanup` → FAIL.
- [ ] **Step 3:** Implement; version order is component `createdAt` (publish time), ties by semver. Use the same per-package lock as plan 3's publish (`pg_advisory_xact_lock(hashtext('npm:' || repoId || ':' || package))`; add to publish if missing). Register in both registries.
- [ ] **Step 4:** Run `pnpm --filter @weaver/npm test && pnpm --filter @weaver/worker test` → PASS.
- [ ] **Step 5:** Commit `feat(npm): add version cleanup that keeps dist-tagged versions` (with the trailer).

### Task 5: Docker cleanup with garbage collection

**Files:**
- Create: `packages/docker/src/cleanup.ts`; Modify: `packages/docker/src/index.ts`
- Modify: `apps/worker/src/cleanups.ts`, `apps/web/src/server/cleanups.ts`, `apps/worker/package.json`
- Test: `packages/docker/src/cleanup.test.ts`

**Interfaces:**
- Consumes: Task 1 contract, core `matchesRules` (pattern glob: `matchesRules({allow:[pattern],deny:[]}, tag)`); plan 4's handler, tag/manifest store and GC.
- Required docker primitives (wrap plan 4's functions if named differently):
  ```ts
  interface DockerTagInfo { image: string; tag: string; digest: string; pushedAt: Date; /** latest pull by this tag OR by its digest */ lastPulledAt: Date | null }
  interface DockerManifestInfo { image: string; digest: string; createdAt: Date }
  function listTags(deps: { db: Db }, repo: Repo): Promise<DockerTagInfo[]>;
  /** Manifests with no tag, not a child of any remaining index, and not a referrer whose subject still exists. */
  function listOrphanManifests(deps: { db: Db }, repo: Repo): Promise<DockerManifestInfo[]>;
  function deleteTag(deps: { db: Db; assets: AssetService }, repo: Repo, image: string, tag: string): Promise<void>;
  function deleteManifest(deps: { db: Db; assets: AssetService }, repo: Repo, image: string, digest: string): Promise<void>;
  /** Removes blobs no manifest references (plan 4's GC, also run by its { kind: "docker:gc" } job). */
  function collectGarbage(deps: { db: Db; stores: StoreSet }): Promise<{ blobsDeleted: number; bytesFreed: number }>;
  /** Logical bytes per repo: each blob referenced by the repo's manifests once, plus manifests. Used by Task 8. */
  function repositoryStorageBytes(deps: { db: Db }, repo: Repo): Promise<{ hostedBytes: number; cacheBytes: number }>;
  ```
- Produces: `dockerCleanup: FormatCleanup` (format `"docker"`); keys `docker:<image>:<tag>` and `docker:<image>@<digest>`. Order of application: tag kinds first, then orphan manifests (recomputed after tag deletions), then `collectGarbage` once when anything was deleted and `!dryRun`.

- [ ] **Step 1: Write failing tests** (push with plain Requests: blob `POST ...?digest=` monolithic uploads, `PUT /v2/<repo>/<image>/manifests/<ref>`):
  - `keep_last_tags 2 with pattern "v*" keeps the two newest v-tags and ignores others` — tags `v1,v2,v3,latest`; after run `v2,v3,latest` remain (`GET /v2/<repo>/<image>/tags/list`).
  - `delete_not_downloaded 30 deletes tags not pulled for 30 days`; `digest pulls keep the tag` (a `GET manifests/sha256:…` 3 days ago keeps the tag pointing at it).
  - `deleting a tag also removes its now orphaned manifest` (`GET manifests/<digest>` → 404) but `a manifest still tagged elsewhere survives`.
  - `delete_untagged_manifests 7 keeps index children and live referrers` — push a 2-platform index tagged `multi`, a cosign-style referrer with `subject` → index, and an untagged single manifest 10 days old; only the single one is deleted; then untag `multi` and run again: index, children and referrer go.
  - `grace period: an untagged manifest 2 days old survives value 7`.
  - `garbage collection runs once after deletions and frees unreferenced blobs` (blob GET → 404, a blob shared with a kept manifest stays); `dryRun deletes nothing and does not collect`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test -- cleanup` → FAIL.
- [ ] **Step 3:** Implement; `groupPrefix` matches the image name prefix. Register in both registries.
- [ ] **Step 4:** Run `pnpm --filter @weaver/docker test && pnpm --filter @weaver/worker test` → PASS.
- [ ] **Step 5:** Commit `feat(docker): add tag and manifest cleanup followed by garbage collection` (with the trailer).

### Task 6: Search index and core search

**Files:**
- Modify: `packages/db/src/schema/content.ts` (`component.searchText` generated column + GIN index); Create: `packages/db/drizzle/00NN_component_search.sql` (generated, hand-prepended with `CREATE EXTENSION IF NOT EXISTS pg_trgm;`)
- Create: `packages/core/src/search/query.ts`, `packages/core/src/search/search.ts`, `packages/core/src/search/index.ts`, `packages/core/src/search/labels.ts`
- Modify: `packages/core/src/index.ts`; Modify (only if plan 1 did not): proto publish/delete/download paths in `packages/core/src/registry/*.ts`
- Test: `packages/core/src/search/query.test.ts`, `packages/core/src/search/search.test.ts`, `packages/core/src/registry/components.test.ts`

**Interfaces:**
- Consumes: core `component`, `asset`, `repository`, `groupMember`, `RepoService.list/members`, `canAccess`, `canReadThroughGroup`, `Principal`, `Format`.
- Produces:
  ```ts
  /** "org.apache.commons:commons-lang3" (maven, proto), "@scope/name" or "name" (npm), "team/app" (docker). */
  function componentLabel(format: Format, namespace: string, name: string): string;
  interface ParsedSearch { terms: string[]; altTerms: string[] | null; normalized: string }
  /** Normalises like search_text; altTerms drops a trailing version segment (":x" with >=1 colon, or "@x" not at index 0). Throws invalid_request for < 2 chars after normalising. */
  function parseSearchQuery(raw: string): ParsedSearch;
  interface SearchHit { repository: string; /** group name when the caller reads the package only through this group */ via: string | null; format: Format; kind: Kind; namespace: string; name: string; label: string; latestVersion: string; versionCount: number; downloads: number; updatedAt: Date }
  interface SearchOptions { text: string; format?: Format; limit: number /* 1..50 */; offset: number /* 0..1000 */ }
  /** Packages the principal may read (direct read, or read through a group), ranked per Decisions; `hasMore` via limit+1. */
  function searchComponents(deps: { db: Db; repos: RepoService }, p: Principal, opts: SearchOptions): Promise<{ hits: SearchHit[]; hasMore: boolean }>;
  ```
  Schema: `searchText: text("search_text").generatedAlwaysAs(sql\`btrim(lower(translate(namespace || ' ' || name, ':/', '  ')))\`)`, index `component_search_text_trgm` `.using("gin", sql\`search_text gin_trgm_ops\`)`.
- Proto component contract: publish upserts `component(namespace = group, name, version)`, version/build deletion removes it when no build remains, downloads call `recordUsage` with that `componentId`.

- [ ] **Step 1: Write failing tests**
  - query: `parseSearchQuery("Org.Apache:Commons-Lang3:3.14")` → terms `["org.apache","commons-lang3","3.14"]`, altTerms `["org.apache","commons-lang3"]`; `"@acme/ui@1.2.0"` → altTerms `["@acme","ui"]`; `"library/nginx:1.27"` → altTerms `["library","nginx"]`; `"nginx"` → altTerms `null`; `"a"` throws `invalid_request`; more than 5 terms keeps the first 5.
  - labels: maven `componentLabel("maven","org.x","lib") === "org.x:lib"`; npm `("npm","@acme","ui") === "@acme/ui"`, `("npm","","left-pad") === "left-pad"`; docker `("docker","","team/app") === "team/app"`.
  - components (proto): `publishing a proto bundle upserts its component`; `deleting the last build removes it`; `a download increments component.downloadCount` (skip implementation if these already pass after plan 1).
  - search (Testcontainers, seeded component/asset rows in maven, npm, docker, proto hosted repos, a cached and an uncached mirror, a group):
    - `finds by maven coordinates with and without version`, `by npm scoped name`, `by docker image name with tag`, `by proto group:name`.
    - `ranks exact before prefix before fuzzy` (`"lib"` → `lib` before `libfoo` before `my-lib`).
    - `format filter` returns only that format; `one hit per package with latestVersion and versionCount`.
    - `mirror components without assets are not returned`.
    - permission filtering: `anonymous sees only public repos`; `a key with read on repo A never sees repo B packages`; `a proto key with groupPrefix "dev.slne" sees dev.slne.* only`; `a key with read on a group sees member packages with via = group name and repository = member name`; `a key with read on the member itself gets via = null`.
    - `uses the trigram index`: `EXPLAIN` of the generated SQL on 5 000 seeded rows mentions `component_search_text_trgm` (with `SET enable_seqscan = off`).
- [ ] **Step 2:** Run `pnpm --filter @weaver/core test -- search components` → FAIL.
- [ ] **Step 3:** Implement. Compute readable repo ids first (direct `canAccess(p, repo, "", "read")` plus members of groups passing `canReadThroughGroup`), then one SQL query over `component` grouped by `(repository_id, namespace, name)`; apply proto prefix narrowing with `canAccess(p, repo, namespace, "read")` on the scanned rows (scan cap 500, like today's `SEARCH_SCAN`). Escape `%`, `_`, `\` in terms.
- [ ] **Step 4:** Run `pnpm --filter @weaver/db test && pnpm --filter @weaver/core test` → PASS.
- [ ] **Step 5:** Commit `feat(core): add trigram search over components of readable repositories` (with the trailer).

### Task 7: Search API and UI

**Files:**
- Create: `apps/web/src/server/trpc/routers/search.ts`, `apps/web/src/app/(app)/search/page.tsx`, `apps/web/src/components/search-results.tsx`, `apps/web/src/components/header-search.tsx`
- Modify: `apps/web/src/server/trpc/root.ts`, `apps/web/src/server/trpc/routers/browse.ts` (remove `search` and `searchArtifacts`), `apps/web/src/components/artifact-search.tsx` (rename to `package-search.tsx`), `apps/web/src/components/command-menu.tsx`, `apps/web/src/components/app-shell.tsx`
- Modify (core file): `apps/web/src/components/browse/registry.tsx` — add `BROWSE_LINKS`
- Test: `apps/web/src/server/trpc/routers.test.ts`, `apps/web/e2e/browse.spec.ts`

**Interfaces:**
- Consumes: Task 6 `searchComponents`, `SearchHit`, `parseSearchQuery`.
- Produces: tRPC `search.query({ q: string (trim, 2..200), format?: Format, limit?: number = 20, offset?: number = 0 }) → { hits: SearchHit[]; hasMore: boolean }` on `browseProcedure` (anonymous allowed when `anonymousView` is on). Core interface change: `BROWSE_LINKS: Partial<Record<Format, (repo: string, namespace: string, name: string) => string>>` in `registry.tsx`, filled for every format with the package page route plans 1-4 created; `packageHref(hit: SearchHit): string` falls back to `/browse/<repo>`; for `via` hits it links into the group's browse page with the same builder.
- UI: header search box (input, placeholder `Search packages`, Enter → `/search?q=`), `/search?q=&format=` page with format filter chips (All, Maven, npm, Docker, Proto), result rows (format badge, label, repository and "via <group>" when set, latest version, downloads), "Load more" while `hasMore`, empty state `No packages match "<q>"`. The command menu group is renamed "Packages" and uses `search.query` with `limit: 8`.

- [ ] **Step 1: Write failing tests:** router: `search.query returns only readable packages for a key-less session viewer`; `anonymous with anonymousView off → UNAUTHORIZED`; `q of one character → BAD_REQUEST`. Playwright: typing `lib` in the header box and pressing Enter shows `/search?q=lib` with a maven and an npm result; clicking the Docker chip leaves only docker results; ⌘K → typing the npm package name lists it under "Packages" and Enter opens its package page.
- [ ] **Step 2:** Run `pnpm --filter web test -- routers` → FAIL.
- [ ] **Step 3:** Implement with existing `@weaver/ui` `input-group`, `badge`, `toggle-group`, `empty` components.
- [ ] **Step 4:** Run `pnpm --filter web test && pnpm --filter web e2e -- browse` → PASS.
- [ ] **Step 5:** Commit `feat(web): add cross-repository package search page and header search` (with the trailer).

### Task 8: Usage rollup, storage snapshots and retention

**Files:**
- Create: `packages/db/src/schema/stats.ts`; Modify: `packages/db/src/schema/index.ts`; Create: `packages/db/drizzle/00NN_usage_rollups.sql` (generated)
- Create: `packages/core/src/stats/rollup.ts`, `packages/core/src/stats/index.ts`
- Modify: `packages/jobs/src/index.ts` (union + scheduler), `apps/worker/src/worker.ts`
- Test: `packages/core/src/stats/rollup.test.ts`, `apps/worker/src/worker.test.ts`, `packages/jobs/src/jobs.test.ts`

**Interfaces:**
- Consumes: core `usageEvent`, `component`, `asset`, `repository`, `protoBuild`, `MAINTENANCE_QUEUE`, `MaintenanceJobData`, `scheduleRepeating`; Task 5 `repositoryStorageBytes`.
- Produces:
  - Tables: `usageDaily` (`day date`, `repositoryId → repository cascade`, `namespace text not null default ''`, `name text not null default ''`, `action usage_action`, `count bigint`, `bytes bigint`, `cacheHit`, `cacheMiss`, `cacheStale`, `cacheBypass` bigint default 0; pk `(day, repositoryId, namespace, name, action)`; index `(day)`); `usageDailyToken` (`day`, `apiKeyId text` (no FK, history outlives keys), `userId text null`, `repositoryId → repository cascade`, `action`, `count`, `bytes`; pk `(day, apiKeyId, repositoryId, action)`; index `(apiKeyId, day)`); `storageSnapshot` (`day`, `repositoryId → repository cascade`, `hostedBytes bigint`, `cacheBytes bigint`, `assetCount bigint`, `takenAt timestamptz`; pk `(day, repositoryId)`).
  - ```ts
    // @weaver/jobs: MaintenanceJobData gains { kind: "stats:rollup" }
    const STATS_SCHEDULER_ID = "stats-hourly"; const STATS_ROLLUP_PATTERN = "41 * * * *";
    // @weaver/core
    const USAGE_RETENTION_DAYS = 90; const STORAGE_SNAPSHOT_RETENTION_DAYS = 400;
    interface RollupResult { daysRolled: number; eventsDeleted: number; repositoriesMeasured: number }
    type StorageProbe = (repo: Repo) => Promise<{ hostedBytes: number; cacheBytes: number } | null>; // null = use the generic asset sum
    /** Under advisory lock 727002: recomputes usage_daily and usage_daily_token for every UTC day from the newest rolled-up day (or the oldest event) through today, upserts today's storage_snapshot per repo, then deletes events older than 90 days (batches of 10 000) and snapshots older than 400 days. */
    function rollupUsage(deps: { db: Db; repos: RepoService; storageProbes?: Partial<Record<Format, StorageProbe>> }, now?: Date): Promise<RollupResult>;
    ```
  - Worker: `stats:rollup` → `rollupUsage` with `storageProbes.docker` from `repositoryStorageBytes`; `startWorker` schedules `stats-hourly`.

- [ ] **Step 1: Write failing tests** (seed `usage_event` rows directly, fake `now`):
  - `rolls downloads per package and day in UTC` — events at 23:59 and 00:01 UTC land on two days.
  - `counts cache results` — 3 hit, 1 stale, 2 miss, 4 bypass → `cacheHit 3, cacheStale 1, cacheMiss 2, cacheBypass 4`.
  - `events without a component roll up under namespace '' and name ''`.
  - `token rollup only includes events with an apiKeyId`.
  - `re-running is idempotent` (two runs → identical rows, no doubled counts).
  - `back-fills a gap` — newest rolled day is 5 days ago, events on each day since; one run rolls all 6 days.
  - `retention deletes events older than 90 days only after their day is rolled up` — an event 100 days old on a day not in `usage_daily` is rolled up first, then deleted; the rollup row survives.
  - `storage snapshot sums hosted and cache assets per repo, adds proto build sizes, and uses the docker probe for docker repos`.
  - `skips with daysRolled 0 while the lock is held`.
  - worker: `a stats:rollup job completes and writes usage_daily`; jobs: `startWorker upserts the stats-hourly scheduler with pattern 41 * * * *`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/core test -- rollup` → FAIL.
- [ ] **Step 3:** Implement; per day `DELETE` then `INSERT … SELECT … GROUP BY` inside one transaction per day, `LEFT JOIN component` for namespace/name. Run `pnpm --filter @weaver/db db:generate`.
- [ ] **Step 4:** Run `pnpm --filter @weaver/db test && pnpm --filter @weaver/core test && pnpm --filter @weaver/jobs test && pnpm --filter @weaver/worker test` → PASS.
- [ ] **Step 5:** Commit `feat(worker): roll up usage events into daily stats with 90 day retention` (with the trailer).

### Task 9: Stats queries and API

**Files:**
- Create: `packages/core/src/stats/queries.ts`; Modify: `packages/core/src/stats/index.ts`
- Create: `apps/web/src/server/trpc/routers/stats.ts`; Modify: `apps/web/src/server/trpc/root.ts`
- Test: `packages/core/src/stats/queries.test.ts`, `apps/web/src/server/trpc/routers.test.ts`

**Interfaces:**
- Consumes: Task 8 tables; core `canAccess`, `canReadThroughGroup`, `RepoService.members`; `apikey.referenceId` (owner user id).
- Produces:
  ```ts
  interface DayRange { from: string; to: string } // inclusive "YYYY-MM-DD" UTC
  interface SeriesPoint { day: string; downloads: number; uploads: number; bytes: number }
  function downloadsSeries(db: Db, range: DayRange, repositoryIds?: string[]): Promise<SeriesPoint[]>; // zero-filled, one point per day
  function topPackages(db: Db, range: DayRange, opts: { repositoryIds?: string[]; limit: number }): Promise<Array<{ repositoryId: string; namespace: string; name: string; downloads: number }>>; // excludes name ''
  function latestStorage(db: Db, repositoryIds?: string[]): Promise<Array<{ repositoryId: string; hostedBytes: number; cacheBytes: number; assetCount: number; takenAt: Date }>>;
  function cacheHitRates(db: Db, range: DayRange, repositoryIds?: string[]): Promise<Array<{ repositoryId: string; hits: number; stale: number; misses: number; bypass: number; hitRate: number | null }>>;
  function tokenSummaries(db: Db, range: DayRange, limit: number): Promise<Array<{ apiKeyId: string; userId: string | null; downloads: number; uploads: number; deletes: number; lastDay: string }>>;
  function tokenSeries(db: Db, apiKeyId: string, range: DayRange): Promise<SeriesPoint[]>;
  function tokenEvents(db: Db, apiKeyId: string, opts: { before?: number; limit: number }): Promise<Array<{ id: number; at: Date; action: "download" | "upload" | "delete"; repository: string | null; label: string | null; path: string; bytes: number }>>; // newest first, from raw events
  ```
  tRPC `stats` router (input `days: 7 | 30 | 90 | 365`, default 30, range ends today UTC):
  - `stats.overview({ days })` admin → `{ series, topPackages (limit 20, with repository name and label), storage (all repos, with name/format/kind), hitRates (mirrors only), tokens (limit 20, with key name and owner name; deleted keys shown as "Deleted key") }`.
  - `stats.repository({ repository, days })` browseProcedure → `{ series, topPackages (limit 10), storage, hitRate | null }`; `NOT_FOUND` unless the caller can read the repo; for a group, ids = its members.
  - `stats.tokenActivity({ keyId, days, before?, limit = 50 })` authedProcedure → `{ key: { id, name }, series, events, nextBefore: number | null }`; `NOT_FOUND` unless `apikey.referenceId === principal.userId` or the caller is admin.

- [ ] **Step 1: Write failing tests:** queries: `series is zero-filled for days without rows`; `hit rate counts stale as hit and excludes bypass` (3 hit, 1 stale, 4 miss, 9 bypass → 0.5); `hit rate is null without hits or misses`; `tokenEvents pages with before`. Router: `overview is admin only` (maintainer → `FORBIDDEN`); `repository stats of a private repo the viewer cannot read → NOT_FOUND`; `group stats aggregate member downloads`; `tokenActivity: owner gets it, another maintainer gets NOT_FOUND, admin gets it`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/core test -- queries && pnpm --filter web test -- routers` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same commands → PASS.
- [ ] **Step 5:** Commit `feat(web): add usage stats api for admins, repositories and tokens` (with the trailer).

### Task 10: Stats pages

**Files:**
- Create: `apps/web/src/app/(app)/admin/stats/page.tsx`, `apps/web/src/app/(app)/browse/[repo]/stats/page.tsx`, `apps/web/src/app/(app)/keys/[id]/activity/page.tsx`
- Create: `apps/web/src/components/stats/{downloads-chart,storage-table,hit-rate-table,top-packages,token-table,range-select}.tsx`
- Modify: `apps/web/src/lib/navigation.ts` (+ `navigation.test.ts`), `apps/web/src/components/nav-icons.ts`, `apps/web/src/app/(app)/keys/keys-manager.tsx` (an "Activity" link per key), the browse repo header (a "Stats" link)
- Test: `apps/web/src/lib/navigation.test.ts`, `apps/web/e2e/admin.spec.ts`

**Interfaces:**
- Consumes: Task 9 procedures; `@weaver/ui/components/chart`, `table`, `card`, `select`; `apps/web/src/app/(app)/admin/_components/format.ts` byte formatting.
- Produces: nav item `{ id: "usage", title: "Usage", href: "/admin/stats", section: "admin", audience: "admin" }` (icon `BarChart3Icon`). Range select options "7 days", "30 days", "90 days", "1 year", kept in the `?days=` query param. Token activity page notes `Detailed activity is kept for 90 days.` Storage tables show the snapshot time (`Measured <relative time>`). A mirror with caching off shows `Caching is off; nothing is stored for this mirror.` instead of storage and hit rate.

- [ ] **Step 1: Write failing tests:** navigation: `navItemsFor("admin")` includes `usage`, `navItemsFor("maintainer")` does not. Playwright (seed usage via the rollup with seeded events): an admin opens Usage and sees the downloads chart, the storage table with a mirror's cache size, the mirror hit rate as `50%`, and a token row linking to its activity page listing the seeded pull; a maintainer opening `/admin/stats` gets the not-found page; a maintainer opens their own key's activity page and sees their events.
- [ ] **Step 2:** Run `pnpm --filter web test -- navigation` → FAIL.
- [ ] **Step 3:** Implement following the `dataviz` conventions already used by the dashboard (one series per chart, no dual axes).
- [ ] **Step 4:** Run `pnpm --filter web test && pnpm --filter web e2e -- admin` → PASS.
- [ ] **Step 5:** Commit `feat(web): add usage, repository stats and token activity pages` (with the trailer).

### Task order and final verification

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. After Task 10 run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
(all PASS) and `scripts/e2e-smoke.sh` (proto still publishes and resolves end to end).

### Real-client flows for plan 6 (e2e)

Plan 6 must cover, with real clients against a running stack:
- `mvn deploy` of three SNAPSHOT builds, `keep_last_snapshot_builds 1` run via "Run now", then `mvn dependency:get` and Gradle resolve the newest build.
- `npm publish` of three versions with `latest` on the oldest, `keep_last_versions 1`, then `npm install pkg` and `pnpm add pkg` still succeed and `npm view pkg versions` lists the tagged and newest versions only.
- `docker buildx` push of a multi-arch image plus `cosign sign`, `delete_untagged_manifests` + GC, then `docker pull --platform linux/amd64` and `linux/arm64` and `cosign verify` succeed.
- A `docker pull` by digest, rollup, then a `delete_not_downloaded` run keeps the tag.
- Playwright search finds packages pushed by `mvn`, `npm`, `docker` and the Weaver CLI; a token without read on a repo does not see it.
- After pulls through a caching mirror and a manual `stats:rollup` job, the Usage page shows non-zero downloads, cache size and hit rate, and the pulling token's activity lists those pulls.

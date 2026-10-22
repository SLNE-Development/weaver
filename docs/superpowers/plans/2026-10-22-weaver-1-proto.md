# Weaver Proto Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the proto registry onto the Weaver repository model so that `format = "proto"` repositories
come in all three kinds: hosted (today's registry, unchanged in substance), mirror (another Weaver
instance's `/api/v1` proto API as upstream, through the core `MirrorEngine`) and group (ordered members).

**Architecture:** The hosted registry (publish, buf validation, snapshots, tombstones, delete, cleanup) stays
in `@weaver/core` (`packages/core/src/registry`) and learns the new `Repo` model. A new workspace package
`@weaver/proto` owns everything that crosses repository kinds: the mirror source (talks to an upstream
Weaver through `MirrorEngine`), the kind-aware proto service (client resolution over the client's ordered
`repositories`, version lists, manifests, archives) and the HTTP `FormatHandler` for `/api/v1/*`, which a
single Next.js catch-all route mounts in place of today's four route files.

**Tech Stack:** TypeScript 6, Next.js 16 route handlers (Node runtime), Drizzle ORM 0.45 on PostgreSQL 17,
Vitest 5 with Testcontainers (`@weaver/db/testing`), zod, `node:http` for the upstream fixture, Kotlin/Gradle
for the plugin, React 19 for the browse view.

**Spec:** `docs/superpowers/specs/2026-10-22-weaver-design.md` (sections "Repository model", "Mirror caching",
"Format behaviour → Proto", "Auth and permissions", "Extras → Browse UI per format").
**Depends on:** `docs/superpowers/plans/2026-10-22-weaver-0-core.md` (all tasks). Runs before plans 2-4.

## Global Constraints

- Product name **Weaver**; no `protoloom` string survives outside `docs/superpowers/**` and git history.
- Identifiers: Gradle plugin id `dev.slne.weaver`, CLI npm package `@slne/weaver-cli` (binary `weaver`), CLI config
  `weaver.json`, workspace scope `@weaver/*`, env vars `WEAVER_*`, headers `x-weaver-*`, log prefix `weaver:`.
- No compatibility aliases for old names.
- Repository names are globally unique across formats.
- Mirror caching is **disabled by default**. Default metadata TTL **1800 s**; max age and max size default to unlimited.
- Groups are read-only; members are hosted or mirror repos of the same format (no nested groups).
- Read permission on a group grants read of everything served through it. Writes are never possible through a group.
- Storage reads and writes stream; proto bundles alone may be buffered whole (10 MB archive cap stays: `LIMITS.archiveBytes`).
- Proto behaviour is ported unchanged in substance: coordinates, server-side transitive resolution with
  highest-version-wins, snapshots, buf validation on publish, deleted-release tombstones, the Gradle plugin and CLI.
- Client resolution uses the client's ordered `repositories` list (hosted, mirror or group entries); no global
  `resolutionPriority` search for clients.
- Publish-time dependency checks resolve only in local proto repos readable by the publisher, target repo first, then
  `resolutionPriority`; publish never contacts a mirror upstream.
- Commit messages: Conventional Commits in English, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every exported function, type and component gets a doc comment saying what it does (repo convention).
- Pin new dependencies to exact versions, like the existing `package.json` files.

## Review Focus

1. **Mirror loop** — a mirror whose upstream URL points back at itself (or two instances mirroring each other) must
   end with `404 not_found`, not recurse until timeouts; covered by Task 4 `handler.test.ts` "mirror loop stops at the hop limit".
2. **Upstream answers 200 with something that is not a Weaver proto API** (an HTML login page, an older/foreign
   server) — must surface as `502 upstream_unavailable`, never a 500 or a bogus resolution; covered by Task 2
   "non-JSON or schema-invalid upstream body is upstream_unavailable".
3. **Group with a mirror member whose upstream is down** — later members must still be tried; only when no member has
   the coordinate does the request fail, with `502 upstream_unavailable` rather than a misleading `404`; covered by
   Task 3 "group skips a failing mirror member" and "group reports upstream_unavailable when nothing else has it".
4. **Snapshot build pinned in a resolve answer disappears upstream before download** (upstream cleanup) — the archive
   request answers `404 not_found` (or the cached copy when caching is on), never 500; covered by Task 3
   "pinned mirror snapshot build gone upstream is not_found".
5. **`repositories` naming a non-proto repo or an unreadable group** — ignored exactly like an unknown name (no
   disclosure, no 500); covered by Task 3 "non-proto and unreadable entries are skipped".

## Decisions

- **Package layout.** New package `@weaver/proto` (`packages/proto`) holds the mirror source, the kind-aware
  `ProtoService` and the `FormatHandler`. The hosted registry stays in `@weaver/core` because publish, delete,
  cleanup and the browse tRPC router already depend on it there.
- **Mount.** `/api/v1/*` is served by one catch-all route `apps/web/src/app/api/v1/[...path]/route.ts` calling
  `getFormatHandler("proto")`. This widens core's `getFormatHandler` mount union (core interface change, Task 4).
- **Groups and mirrors reject writes** with a new core error code `method_not_allowed` (HTTP 405) on publish (`PUT`)
  and delete (`DELETE`) — core interface change to `ErrorCode` in `packages/core/src/errors.ts` (Task 1).
- **Mirror upstream URL** is the base URL of one remote proto repository: `https://<host>/api/v1/repos/<repo>`.
  Upstream paths relative to it: `artifacts/<g>/<n>` (version list), `artifacts/<g>/<n>/<v>` (manifest),
  `artifacts/<g>/<n>/<v>/archive?build=<b>` (archive). Segments are `encodeURIComponent`-encoded. Credentials are the
  remote instance's access token (bearer) or Basic with the token as password, both handled by `MirrorEngine`.
- **Content classes.** Release archives are `immutable`. Version lists, manifests and snapshot archives are `metadata`
  (TTL), as the task statement fixes. Cache asset paths equal the upstream relative paths, query included.
- **Rules subject** for proto mirrors is `<group>:<name>`, so an allow rule `dev.surf.*` admits every group under `dev.surf`.
- **Addressed name wins.** Everything served through a mirror or group reports the repository the client addressed:
  resolve's `repository` and `archiveUrl`, and a manifest's `repository` field, name the listed entry (group or
  mirror), never the member or the remote repo. The resolve wire format is otherwise unchanged.
- **Group lookup** takes the first member, in order, that has the exact version; for a snapshot that member's newest
  build (members are not compared). Group version lists are the union across members, first member's summary wins
  per version, sorted newest first.
- **Group read permission** for proto uses `canAccess(p, groupRef, c.group, "read")` so a key's group-prefix narrowing
  on a group entry still applies; members are then read without their own permission checks (spec: Nexus behaviour).
- **Failing mirror members.** A member throwing `upstream_unavailable` is skipped; if no later member has the item,
  the request throws that `upstream_unavailable` instead of `not_found`.
- **Entries that are unknown, not `format = "proto"`, or unreadable** are skipped silently, as today for unknown names.
- **Publish dependency order** = target repo, then every other `kind = "hosted"` proto repo by
  `config.resolutionPriority` ascending, then name. A hosted repo counts as readable for the publisher when
  `canAccess` grants it directly or through a group containing it that the publisher can read ("groups over hosted"
  add access, not order). Mirrors are never consulted. Locks and dependency rows keep naming the hosted repo.
- **Loop guard.** Requests the mirror source sends upstream carry `x-weaver-hops: <incoming + 1>` (incoming default 0).
  The handler answers `404 not_found` ("Mirror loop detected") to any request with `x-weaver-hops > 4`
  (`MAX_MIRROR_HOPS = 4`) before doing any work.
- **No CLI or plugin wire change.** Requests and responses keep their shapes; both clients already ignore unknown
  fields and print the server's `error.message`, so `405`/`502` need no client code. The CLI and plugin change only in
  tests and docs (Task 6).
- **No new tables, no migration.** Proto tables (`proto_*`) and the generic `asset`/`component` tables come from core
  Task 3; mirror caches use `AssetService` rows.
- **Browse.** Hosted: today's views. Mirror: cached archives (components with cache assets) or, with caching off, the
  note "This mirror does not cache; its content lives upstream at <first upstream url>". Group: ordered members with
  links. File views exist only for hosted repos. Dependents (`listDependents`) stay hosted-only.

---

### Task 1: Hosted registry on the repository model

**Files:**
- Modify: `packages/core/src/errors.ts` (add `method_not_allowed`)
- Modify: `packages/core/src/registry/index.ts`, `lookup.ts`, `read.ts`, `publish.ts`, `delete.ts`
- Modify: `apps/web/src/server/context.ts` (`createRegistry` deps), `apps/web/src/server/trpc/routers/browse.ts` (no more `registry.resolve`)
- Test: `packages/core/src/registry/registry.test.ts`, `packages/core/src/errors.test.ts`

**Interfaces:**
- Consumes (core): `Repo`, `ProtoHostedConfig`, `RepoService.list/get/members/groupsContaining`, `canAccess(p, repo: RepoRef, scope, access)`, `canReadThroughGroup`, `StoreSet`, `putBuffer`/`getBuffer`, `ObjectStore`.
- Produces (exported from `@weaver/core`):
  ```ts
  // errors.ts: ErrorCode gains "method_not_allowed" → 405
  /** Unchecked reads of one hosted proto repo; the caller has already authorised the read. */
  interface HostedReader {
    node(repo: Repo, c: Coordinate, buildNumber?: number): Promise<ResolvedNode | null>; // node.repository = repo.name
    versions(repo: Repo, group: string, name: string): Promise<VersionSummary[]>;        // [] when the artifact is absent
    manifest(repo: Repo, c: Coordinate, select?: BuildSelector): Promise<VersionInfo | null>;
    /** Archive bytes of the newest build or `select.buildNumber`; counts a download on the build. */
    archive(repo: Repo, c: Coordinate, select?: BuildSelector): Promise<{ data: Buffer; sha256: string; filename: string; buildId: string } | null>;
  }
  interface Registry {           // unchanged members keep their signatures, minus `resolve`
    publish(p: Principal, input: PublishInput): Promise<PublishResult>;
    listVersions(p, repository, group, name): Promise<VersionSummary[]>;
    getManifest(p, repository, c, select?): Promise<VersionInfo>;
    download(p, repository, c, select?): Promise<{ data: Buffer; sha256: string; filename: string }>;
    getFile(p, repository, c, path): Promise<string>;
    listDependents(c: Coordinate): Promise<Dependent[]>;
    deleteVersion(p, repository, c, opts?): Promise<void>;
    hosted: HostedReader;
  }
  function createRegistry(deps: { db: Db; stores: StoreSet; repos: RepoService; validate?: typeof validateProtos }): Registry;
  /** Hosted proto repos consulted for a publish's dependencies, in order (see Decisions). */
  function publishRepositoryOrder(db: Queryable, repos: RepoService, p: Principal, target: Repo): Promise<Repo[]>;
  ```
- `Registry.resolve` is removed; client resolution moves to `ProtoService.resolve` (Task 3). `RepositoryRow` uses in
  the registry are replaced by `Repo`; settings come from `repo.config as ProtoHostedConfig`.

- [ ] **Step 1: Write failing tests** in `registry.test.ts` (existing Testcontainers setup; repos created via `RepoService.create`):
  - `publish to a group is method_not_allowed` — `expect(err.code).toBe("method_not_allowed"); expect(err.status).toBe(405)`.
  - `publish to a proto mirror is method_not_allowed`; `deleteVersion on a group is method_not_allowed`.
  - `hosted reads of a non-proto repo are not_found` — `registry.listVersions(admin, "npm-hosted", "g", "n")` rejects `not_found`.
  - `publish resolves dependencies from hosted repos by resolutionPriority` — dep `acme:money:1.0.0` in `low` (priority 5) and `high` (priority 10) with different files; published build's dependency resolves to `low` (validate stub receives `low`'s files).
  - `publish ignores mirrors` — the dependency exists only behind a mirror whose `fetchImpl` spy is passed to the engine; publish fails `validation_failed` with message `Dependency not found: acme:money:1.0.0` and the spy was called `0` times.
  - `publish sees a hosted repo through a readable group` — key with read on group `all` (members `[private-hosted]`) and write on `target`; dependency in `private-hosted` resolves.
  - `publish skips hosted repos the publisher cannot read` — same without the group entry → `validation_failed`.
  - `hosted.node returns the newest snapshot build without permission checks`; `hosted.archive counts one download`.
  - Existing tests (redeploy, tombstones, snapshots, dependents, collisions) keep passing with `config` instead of columns.
- [ ] **Step 2:** Run `pnpm --filter @weaver/core test -- registry` → FAIL (`method_not_allowed` unknown, `hosted` missing).
- [ ] **Step 3: Implement.** `readableRepository` loads via `RepoService.get`, requires `format === "proto"` (else `not_found`), and for write paths throws `method_not_allowed` ("Repository <name> is a <kind>; publish to a hosted repository") when `kind !== "hosted"`. `publishRepositoryOrder` queries `repository` where `format = 'proto' and kind = 'hosted' and id <> target.id` ordered by `(config->>'resolutionPriority')::int, name`, then filters by `canAccess(p, repo, "", "read") || groups.some(g => canReadThroughGroup(p, g))` using `repos.groupsContaining(repo.id)`; `createLookup` then applies the per-group `canAccess` only to repos without group-granted access. Archive I/O uses `putBuffer(stores.primary, …)`/`getBuffer`.
- [ ] **Step 4:** Run `pnpm --filter @weaver/core test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add packages/core apps/web/src/server
  git commit -m "feat(core): run the hosted proto registry on the repository model" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Task 2: `@weaver/proto` package and mirror source

**Files:**
- Create: `packages/proto/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts,eslint.config.js}` (copied from `packages/jobs`, deps `@weaver/core`, `@weaver/db`, `zod` at the versions used in `packages/core/package.json`; devDeps as in `packages/core`)
- Create: `packages/proto/src/index.ts`, `packages/proto/src/wire.ts`, `packages/proto/src/mirror-source.ts`
- Create: `packages/proto/src/testing/upstream.ts` (test helper: serves a `FormatHandler` on `node:http`)
- Modify: `pnpm-lock.yaml` (via `pnpm install`), `apps/web/package.json` (add `"@weaver/proto": "workspace:*"`), `apps/web/next.config.ts` (`transpilePackages`/`serverExternalPackages` like `@weaver/core`, if listed there)
- Test: `packages/proto/src/mirror-source.test.ts`

**Interfaces:**
- Consumes: `MirrorEngine.fetch(MirrorFetch)`, `MirrorResponse`, `Repo`, `RegistryError("upstream_unavailable")`, `ResolvedNode`, `VersionSummary`, `VersionInfo`, `parseCoordinate`, `isSnapshot`.
- Produces:
  ```ts
  // wire.ts — the /api/v1 JSON shapes, shared by handler and mirror source
  const versionsBodySchema: z.ZodType<{ versions: Array<{ version: string; isSnapshot: boolean; latestBuild: number; updatedAt: string }> }>;
  const manifestBodySchema: z.ZodType<VersionInfoJson>; // coordinate + dependencies as strings, dates ISO
  type VersionInfoJson = Omit<VersionInfo, "coordinate" | "dependencies" | "createdAt" | "builds"> & { coordinate: string; dependencies: string[]; createdAt: string; builds: Array<{ buildNumber: number; createdAt: string; sha256: string }> };
  function versionInfoToJson(info: VersionInfo): VersionInfoJson;
  function versionInfoFromJson(body: VersionInfoJson): VersionInfo;
  /** Relative upstream path of a proto resource, each segment encodeURIComponent-ed. */
  function protoPath(kind: "versions" | "manifest" | "archive", c: { group: string; name: string; version?: string }, buildNumber?: number): string;
  const HOPS_HEADER = "x-weaver-hops";
  const MAX_MIRROR_HOPS = 4;
  // mirror-source.ts
  interface MirrorArchive { status: 200; body: ReadableStream<Uint8Array> | null; size: number | null; sha256: string | null; cache: MirrorResponse["cache"] }
  interface ProtoMirrorSource {
    node(repo: Repo, c: Coordinate, hops: number): Promise<ResolvedNode | null>;            // repository = repo.name
    versions(repo: Repo, group: string, name: string, hops: number): Promise<VersionSummary[] | null>;
    manifest(repo: Repo, c: Coordinate, hops: number, buildNumber?: number): Promise<VersionInfo | null>;
    archive(repo: Repo, c: Coordinate, buildNumber: number | undefined, hops: number, method: "GET" | "HEAD"): Promise<MirrorArchive | null>;
  }
  function createMirrorSource(deps: { mirror: MirrorEngine }): ProtoMirrorSource;
  ```
- Every call passes `subject = "<group>:<name>"`, `headers = { accept: "application/json", "x-weaver-hops": String(hops + 1) }`, `class` per Decisions, and `component = { namespace: group, name, version }` for archives. `null` from the engine → `null`. A 2xx JSON body failing its schema, or a non-2xx other than 404 → `RegistryError("upstream_unavailable", "Upstream of <repo> did not answer as a Weaver proto API")`. `node()` reads the manifest; `sha256`/size of archives come from the upstream `x-weaver-sha256`/`content-length` headers, or the cached `asset` row on a hit.

- [ ] **Step 1: Write failing tests** in `mirror-source.test.ts`, with a real `MirrorEngine` (core) over Testcontainers and a `node:http` upstream that returns canned `/api/v1` responses and counts hits:
  - `node maps an upstream manifest to a ResolvedNode` — `{ coordinate: {group:"acme",name:"money",version:"1.0.0"}, repository: "proto-mirror", buildNumber: 1, sha256: <canned>, dependencies: [] }`.
  - `upstream 404 is null`; `deny rule acme:* returns null without contacting upstream` (hits `0`).
  - `non-JSON or schema-invalid upstream body is upstream_unavailable` — HTML `200` and `{"versions":"x"}` both reject with code `upstream_unavailable`.
  - `release archive is cached as immutable and snapshot archive as metadata` — cache on; after one release and one snapshot archive request, `assets.find(repo.id, "artifacts/acme/money/1.0.0/archive?build=1").expiresAt === null` and the snapshot asset's `expiresAt` is ~`now + 1800 s`.
  - `mirror path with query string reaches upstream verbatim` — upstream sees `/api/v1/repos/up/artifacts/acme/money/1.0.0-SNAPSHOT/archive?build=3`.
  - `hops header is incremented` — upstream sees `x-weaver-hops: 2` when called with `hops = 1`.
  - `cache off streams the archive and reports bypass` — `cache === "bypass"`, no asset rows.
- [ ] **Step 2:** Run `pnpm --filter @weaver/proto test` → FAIL (module missing).
- [ ] **Step 3: Implement** `wire.ts` and `mirror-source.ts`. If "query string reaches upstream verbatim" fails because core's engine drops or re-encodes the query, fix it in `packages/core/src/mirror/engine.ts` (`upstreamUrl = base.replace(/\/+$/, "") + "/" + path`, no re-encoding) and add the same test to `packages/core/src/mirror/mirror.test.ts`.
- [ ] **Step 4:** Run `pnpm install && pnpm --filter @weaver/proto test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add packages/proto apps/web/package.json apps/web/next.config.ts pnpm-lock.yaml packages/core/src/mirror
  git commit -m "feat(proto): add proto package with mirror source for upstream weaver instances" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Task 3: Kind-aware proto service and client resolution

**Files:**
- Create: `packages/proto/src/service.ts`
- Modify: `packages/proto/src/index.ts`
- Test: `packages/proto/src/service.test.ts`

**Interfaces:**
- Consumes: Task 1 `Registry.hosted: HostedReader`; Task 2 `ProtoMirrorSource`; core `RepoService.get/members`, `canAccess`, `resolveGraph(roots, lookup, options)`, `ResolveOptions`, `Resolution`, `FormatDeps.usage`.
- Produces:
  ```ts
  /** What a proto archive read returns, for any repository kind. */
  interface ProtoArchive { body: ReadableStream<Uint8Array> | null; size: number | null; sha256: string | null; filename: string; cache: "hit" | "miss" | "bypass" | "stale" | null }
  interface ProtoService {
    /** Resolves roots across `repositories` (client order); every node's `repository` is the listed entry. */
    resolve(p: Principal, repositories: string[], roots: Coordinate[], options: ResolveOptions, hops: number): Promise<Resolution>;
    listVersions(p: Principal, repository: string, group: string, name: string, hops: number): Promise<VersionSummary[]>;
    getManifest(p: Principal, repository: string, c: Coordinate, select: BuildSelector, hops: number): Promise<VersionInfo>;
    archive(p: Principal, repository: string, c: Coordinate, select: BuildSelector, method: "GET" | "HEAD", hops: number): Promise<ProtoArchive>;
  }
  function createProtoService(deps: { registry: Registry; repos: RepoService; mirrorSource: ProtoMirrorSource; usage: FormatDeps["usage"] }): ProtoService;
  ```
- Reads: entry not found / not proto / not readable for `c.group` → skipped (resolve) or `not_found` (others). Hosted → `registry.hosted.*`; mirror → `mirrorSource.*`; group → members in order per Decisions, `upstream_unavailable` from a member remembered and rethrown only if nothing later matches. Every successful `archive` GET calls `usage({ repositoryId: <addressed repo id>, path: "<g>/<n>/<v>", action: "download", cache, bytes: size ?? 0, principal })`. Manifest results get `repository` set to the addressed name.

- [ ] **Step 1: Write failing tests** in `service.test.ts` (Testcontainers DB; two hosted repos `rel` and `snap`, a mirror `up-mirror` whose upstream is a second `createProtoHandler` instance served by `testing/upstream.ts` over hosted repo `remote` in the same DB, and a group `all = [rel, up-mirror]`):
  - `resolve follows the client's repository order` — `acme:money:1.0.0` in `rel` and `remote`; `resolve(p, ["up-mirror","rel"], …)` → node `repository === "up-mirror"`; reversed → `"rel"`.
  - `resolve does not search repos outside the list` — coordinate only in `snap` (priority 1); list `["rel"]` → rejects `not_found` with `details.path` `["acme:money:1.0.0"]`.
  - `resolve through a group names the group` — node `repository === "all"`, `buildNumber`/`sha256` equal the member's.
  - `highest version wins across mixed entries` — `order:1.0.0` (in `rel`) needs `money:1.0.0`, `invoice:1.0.0` (in `remote`) needs `money:1.1.0`; result has `money` at `1.1.0` and one conflict `{ requested: ["1.0.0","1.1.0"], selected: "1.1.0" }`.
  - `group read grants private members` — key with read on `all` only, `rel` private → `getManifest(p,"all",money)` succeeds; `getManifest(p,"rel",money)` rejects `not_found`.
  - `non-proto and unreadable entries are skipped` — list `["npm-hosted","private-other","rel"]` resolves from `rel`; with only `["npm-hosted"]` → `not_found`.
  - `group lists the union of member versions newest first` — `rel` has `1.0.0`, `remote` has `1.1.0` and `1.0.0` → `["1.1.0","1.0.0"]`, the `1.0.0` entry is `rel`'s.
  - `group snapshot comes from the first member that has it` — `rel` build 2, `remote` build 5 of `x:1.0.0-SNAPSHOT` → `buildNumber === 2`.
  - `group skips a failing mirror member` — group `[up-mirror-down, rel]` (upstream port closed) → resolves from `rel`.
  - `group reports upstream_unavailable when nothing else has it` — `[up-mirror-down]` → code `upstream_unavailable`.
  - `pinned mirror snapshot build gone upstream is not_found` — delete build 1 upstream, `archive(p,"up-mirror",c,{buildNumber:1},"GET",0)` → `not_found`; with caching on and a prior download → served, `cache === "stale"` or `"hit"`.
  - `archive download records usage once with the addressed repo id` — `usage` spy called once, `repositoryId === all.id`, `action === "download"`; `HEAD` records nothing.
- [ ] **Step 2:** Run `pnpm --filter @weaver/proto test -- service` → FAIL.
- [ ] **Step 3: Implement** `service.ts`. The resolve lookup memoises `RepoService.get`/`members` per call; mirror lookups go through `mirrorSource.node`.
- [ ] **Step 4:** Run `pnpm --filter @weaver/proto test` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add packages/proto
  git commit -m "feat(proto): resolve across hosted, mirror and group repositories in client order" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Task 4: `/api/v1` FormatHandler and mount

**Files:**
- Create: `packages/proto/src/handler.ts`, `packages/proto/src/http.ts` (ported from `apps/web/src/server/http.ts`: `json`, `errorResponse`, `readBodyLimited`, `readJson`, `forceParam`, `buildParam`, param checks, `archiveUrl(publicUrl, repository, c, buildNumber)`)
- Create: `apps/web/src/app/api/v1/[...path]/route.ts`
- Delete: `apps/web/src/app/api/v1/resolve/route.ts`, `apps/web/src/app/api/v1/repos/[repo]/artifacts/[group]/[name]/route.ts`, `…/[version]/route.ts`, `…/[version]/archive/route.ts`, `apps/web/src/app/api/v1/api.test.ts` (cases move to `handler.test.ts`)
- Modify: `apps/web/src/server/formats.ts` (mount union + proto factory), `apps/web/src/server/http.ts` (keep only what non-proto web code still imports)
- Test: `packages/proto/src/handler.test.ts`, `apps/web/src/server/formats.test.ts`

**Interfaces:**
- Consumes: core `FormatDeps`, `FormatHandler`, `FormatFactory`, `extractToken` (via `deps.principal`); Task 1 `Registry.publish/deleteVersion`; Task 3 `ProtoService`; Task 2 `HOPS_HEADER`, `MAX_MIRROR_HOPS`, `versionInfoToJson`.
- Produces:
  ```ts
  /** The /api/v1 proto REST API; `rest` is the path after "/api/v1/". */
  function createProtoHandler(deps: FormatDeps & { registry: Registry; validate?: typeof validateProtos }): FormatHandler;
  // apps/web/src/server/formats.ts — core interface change
  function getFormatHandler(mount: "maven" | "npm" | "docker" | "proto"): FormatHandler;
  ```
- Routes (wire unchanged from today): `POST resolve`; `GET repos/<r>/artifacts/<g>/<n>`; `GET|PUT|DELETE repos/<r>/artifacts/<g>/<n>/<v>`; `GET|HEAD repos/<r>/artifacts/<g>/<n>/<v>/archive[?build=]`. Anything else → `404 not_found`; a known path with another method → `405 method_not_allowed` with an `allow` header. Archive responses send `content-type: application/gzip`, `content-length` when known, `content-disposition: attachment; filename="<n>-<v>.tar.gz"`, `x-weaver-sha256` when known, `cache-control: private, no-store`. Limits stay `MAX_BODY_BYTES = 1 MiB` (resolve) and `LIMITS.archiveBytes + 64 KiB` (publish). The catch-all route exports `GET, HEAD, PUT, POST, DELETE` with `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `rest` from the raw pathname like core's mounts.

- [ ] **Step 1: Write failing tests** in `handler.test.ts` with plain `Request` objects (`principal` stub maps `authorization` tokens to fixed `Principal`s): port every case of the deleted `api.test.ts` (publish 201 body, validation 422 issues, immutable 409, has_dependents 409 and `?force=true`, archive `x-weaver-sha256`, HEAD counts no download, payload_too_large 413, delete 204), plus:
  - `PUT to a group answers 405 method_not_allowed` — `res.status === 405`, `body.error.code === "method_not_allowed"`; same for `DELETE` on a mirror.
  - `resolve archiveUrl uses the addressed repository and public url` — `"http://weaver.test/api/v1/repos/all/artifacts/acme/money/1.0.0/archive?build=1"` for a node resolved through group `all`.
  - `archive through a mirror streams upstream bytes with x-weaver-sha256` — body sha256 equals header.
  - `mirror loop stops at the hop limit` — mirror `loop` whose upstream is this same handler's `/api/v1/repos/loop`; `GET repos/loop/artifacts/acme/money` answers `404` within 5 s; and a request with `x-weaver-hops: 5` answers `404` with message `Mirror loop detected`.
  - `unknown path is 404 and wrong method on a known path is 405 with allow` — `POST repos/r/artifacts/g/n` → `405`, `allow: GET`.
  - `upstream_unavailable maps to 502`.
  - In `formats.test.ts`: `getFormatHandler("proto") answers /api/v1/resolve` (not the 501 placeholder) and `rest for /api/v1/repos/r/artifacts/g/n is "repos/r/artifacts/g/n"`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/proto test -- handler && pnpm --filter web test -- formats` → FAIL.
- [ ] **Step 3: Implement** the handler (one small router over split, decoded segments; hops read once per request) and the mount; delete the old route files and move the shared HTTP helpers.
- [ ] **Step 4:** Run `pnpm --filter @weaver/proto test && pnpm --filter web test && pnpm --filter web build && pnpm typecheck && pnpm lint` → PASS; `scripts/e2e-smoke.sh` → ends with its success line (hosted proto still works through Gradle and the CLI).
- [ ] **Step 5: Commit**
  ```bash
  git add packages/proto apps/web
  git commit -m "feat(proto): serve the v1 proto api through a format handler for every repository kind" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Task 5: Proto browse views per kind

**Files:**
- Modify: `apps/web/src/components/browse/registry.tsx` (proto entry dispatches on `repo.kind`)
- Create: `apps/web/src/components/browse/proto-mirror-view.tsx`, `apps/web/src/components/browse/proto-group-view.tsx`
- Modify: `apps/web/src/server/trpc/routers/browse.ts` (`artifacts`, `versions`, `version`, `file` reject non-hosted repos with `NOT_FOUND`; new `protoCache`, `protoMembers` queries), `apps/web/src/lib/browse.ts` (`gradleSnippet`/`weaverJsonSnippet` accept any proto repo name), `apps/web/src/components/usage-snippet.tsx` (repository-level variant)
- Test: `apps/web/src/server/trpc/routers.test.ts`, `apps/web/src/lib/browse.test.ts`, `apps/web/e2e/browse.spec.ts`

**Interfaces:**
- Consumes: core `BROWSE_VIEWS`, `AssetService.list`, `RepoService.members/upstreams`, `canReadThroughGroup`.
- Produces: tRPC `browse.protoCache({ repository })` → `{ caching: boolean; upstream: string | null; items: Array<{ coordinate: string; buildNumber: number | null; size: number; lastAccessedAt: Date | null; cache: "immutable" | "metadata" }> }` (archives only, newest access first, at most 500); `browse.protoMembers({ repository })` → `Array<{ name: string; kind: "hosted" | "mirror"; visibility: "public" | "private" }>` in group order. `UsageSnippet` takes `{ repository: string; coordinate?: string }` and prints `repositories("<repository>")` / `"repositories": ["<repository>"]`.

- [ ] **Step 1: Write failing tests:**
  - routers: `protoCache lists cached archives of a caching mirror`; `protoCache reports caching false and the first upstream url when caching is off`; `protoMembers returns members in group order`; `browse.versions on a proto mirror is NOT_FOUND`.
  - lib: `gradleSnippet for a group repository lists the group name` — output contains `repositories("all")`.
  - Playwright `browse.spec.ts`: `proto mirror without caching shows the upstream note` — text `This mirror does not cache; its content lives upstream at`; `proto group page links each member`.
- [ ] **Step 2:** Run `pnpm --filter web test` → FAIL.
- [ ] **Step 3: Implement** with existing `browse-ui.tsx` table/empty-state components; the hosted view is today's view unchanged.
- [ ] **Step 4:** Run `pnpm --filter web test && pnpm --filter web e2e -- browse` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/web
  git commit -m "feat(web): browse proto mirrors and groups" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Task 6: Proto docs and client checks

**Files:**
- Modify: `apps/web/content/docs/resolution.md`, `publish.md`, `consume.md`, `api.md`, `cli.md`, `gradle.md`, `admin/repositories.md`, `troubleshooting.md`
- Modify: `packages/cli/src/fetch.test.ts`, `gradle-plugin/src/test/kotlin/dev/slne/weaver/gradle/RemoteTest.kt` (and `RegistryStub.kt` if it needs a `502` route)
- Test: `apps/web/src/lib/docs.test.ts` (existing link/frontmatter checks)

**Interfaces:**
- Consumes: the wire behaviour of Task 4. Produces nothing for code.

- [ ] **Step 1: Write failing tests:**
  - CLI `fetch.test.ts`: `resolving through a group name downloads from the group's archive url` — stub server answers resolve with `repository: "all"` and `archiveUrl` under `/api/v1/repos/all/`; the CLI requests exactly that path and writes the files.
  - CLI: `upstream_unavailable is printed as the server message` — stub `502 {"error":{"code":"upstream_unavailable","message":"Upstream of up-mirror did not answer"}}` → `CliError` message `Upstream of up-mirror did not answer`.
  - Plugin `RemoteTest`: `fetchProtos surfaces a 502 message` — Gradle failure output contains `Upstream of up-mirror did not answer`.
- [ ] **Step 2:** Run `pnpm --filter @slne/weaver-cli test` and `cd gradle-plugin && ./gradlew test --no-daemon` → the new tests FAIL only if a client mangles the message; if both pass immediately, keep them as regression tests and record that no client change was needed.
- [ ] **Step 3: Update docs:**
  - `resolution.md`: entries may be hosted, mirror or group repos; lookup order is the list order; groups search members in order, first member with the exact version wins; mirrors ask their upstream; non-proto, unknown and unreadable names are ignored; the reported repository is the listed name.
  - `publish.md`: dependency checks use hosted proto repos you can read (directly or through a group), target first then resolution priority; mirrors are never consulted, so publish mirrored dependencies into a hosted repo first; publishing to a group or mirror answers `405 method_not_allowed`.
  - `api.md`: `405 method_not_allowed`, `502 upstream_unavailable`, `x-weaver-hops` (loop guard, limit 4).
  - `admin/repositories.md`: proto mirror upstream URL form `https://<host>/api/v1/repos/<repo>`, token as bearer credential, rules match `group:name`, what caching stores (release archives immutable; version lists, manifests and snapshot archives with the metadata TTL); proto groups.
  - `consume.md`, `cli.md`, `gradle.md`: one example each listing a group (`repositories("proto-all")`, `"repositories": ["proto-all"]`).
  - `troubleshooting.md`: "Mirror loop detected" and `upstream_unavailable` entries.
- [ ] **Step 4:** Run `pnpm --filter web test -- docs && pnpm --filter @slne/weaver-cli test && (cd gradle-plugin && ./gradlew test --no-daemon)` → PASS; `git grep -n "resolutionPriority" apps/web/content/docs` only hits `publish.md` and `admin/repositories.md`.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/content/docs packages/cli gradle-plugin
  git commit -m "docs(proto): document proto mirrors, groups and client resolution order" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Real-client flows for plan 6 (e2e)

Plan 6 extends `scripts/e2e-smoke.sh` with a second Weaver container as the proto upstream and must cover:
1. Gradle plugin `publishProtos` to a hosted repo, then `fetchProtos` from it (today's smoke flow).
2. CLI `weaver fetch` with `"repositories": ["<proto-mirror>"]` against the second instance, caching off; then caching on, upstream stopped, fetch again succeeds from cache.
3. Gradle `fetchProtos` with `repositories("<proto-group>")` whose members are a private hosted repo and the mirror, using a token that can read only the group.
4. Snapshot: publish two builds upstream, fetch through the mirror, the pinned build's archive sha256 matches the resolve answer.
5. Denials: publish to the group fails with the 405 message in Gradle output; a token without read on the group gets `not_found` from `weaver fetch`.

### Task order

1 → 2 → 3 → 4 → 5 → 6. After Task 6 run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`,
`cd gradle-plugin && ./gradlew test --no-daemon`, and `scripts/e2e-smoke.sh`.

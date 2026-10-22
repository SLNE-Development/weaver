# Weaver Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Protoloom codebase into the Weaver shared core: renamed product, streaming storage, a
multi-format repository model (hosted/mirror/group), client auth for stock tools, a mirror engine with
optional caching, mount points for the format protocols, and the admin UI to manage it all. Proto keeps
working throughout.

**Architecture:** Everything stays in the existing pnpm/turbo monorepo. Generic repository, mirror,
auth, storage and usage logic lives in `@weaver/core` and `@weaver/db`. Each wire protocol lives in its
own workspace package (`@weaver/maven`, `@weaver/npm`, `@weaver/docker`, added by later plans) exporting
a framework-agnostic `FormatHandler` (`(Request) => Promise<Response>`) that Next.js catch-all route
handlers mount at `/maven/*`, `/npm/*` and `/v2/*`.

**Tech Stack:** TypeScript 6, Next.js 16 route handlers (Node runtime), Drizzle ORM 0.45 on PostgreSQL 17,
Better Auth 1.7 (+ api-key plugin), BullMQ on Valkey, `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`,
Vitest 5 with Testcontainers, tRPC 11, React 19.

**Spec:** `docs/superpowers/specs/2026-10-22-weaver-design.md`

**Plan series** (execute in order; 1-4 depend only on this plan, 5 and 6 on all):
0. `2026-10-22-weaver-0-core.md` (this plan)
1. `2026-10-22-weaver-1-proto.md`
2. `2026-10-22-weaver-2-maven.md`
3. `2026-10-22-weaver-3-npm.md`
4. `2026-10-22-weaver-4-docker.md`
5. `2026-10-22-weaver-5-extras.md` (search, usage stats, cleanup policies for all formats)
6. `2026-10-22-weaver-6-e2e.md` (real-client e2e, CI with stand-in upstreams, nightly real upstreams, docs)

## Global Constraints

- Product name **Weaver**; no `protoloom` string survives outside `docs/superpowers/**` and git history.
- Identifiers: domain `weaver.slne.dev`, repo `SLNE-Development/weaver`, image `ghcr.io/slne-development/weaver`,
  Gradle plugin id `dev.slne.weaver`, CLI npm package `@slne/weaver-cli` (binary `weaver`), CLI config `weaver.json`,
  workspace scope `@weaver/*`, env vars `WEAVER_*`, headers `x-weaver-*`, Symbol brands `weaver.*`, log prefix `weaver:`.
- No compatibility aliases for old names.
- Keep users only: `user`, `account`, `session`, `verification`, `audit_event`, `setting` rows survive; all repository
  content, `apikey`, `api_key_permission`, `invite`, `cleanup_policy` rows are dropped by the migration.
- Repository names are globally unique across formats; `library` is reserved for docker repos.
- Mirror caching is **disabled by default**. Default metadata TTL **1800 s**; max age and max size default to unlimited.
- Groups are read-only; members are hosted or mirror repos of the same format (no nested groups).
- Read permission on a group grants read of everything served through it.
- Storage: both `STORAGE_LOCAL_PATH` and `S3_*` may be set; `STORAGE_DRIVER` names the primary (hosted) store.
- Storage reads and writes stream; nothing outside proto bundles is buffered whole in memory.
- Admin UI stays minimal: a new repo needs only name, format, kind; format/kind options appear only where they apply.
- Commit messages: Conventional Commits in English, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every exported function, type and component gets a doc comment saying what it does (repo convention).
- Pin new dependencies to exact versions, like the existing `package.json` files.

## Review Focus

1. **Next.js trailing-slash and path normalisation** — `GET /v2/` and Maven directory URLs ending in `/` must reach the
   handler unredirected and with the raw (still percent-encoded) path; covered by Task 8's route tests.
2. **Upstream that hangs or dies mid-stream with caching on** — a partially written cache object must never be served
   later; covered by Task 7's `mirror.test.ts` "aborted upstream leaves no asset row".
3. **Concurrent first requests for the same uncached mirror path** — both must get a full response and the asset row
   must be written once (`ON CONFLICT DO UPDATE`); covered by Task 7.
4. **Token with write on a group** — must not allow any write; covered by Task 6 `canAccess` tests.
5. **Deleting a repository that is a member of groups or has keys pointing at it** — group membership and key
   permissions vanish via FK cascade and the stored objects are deleted; covered by Task 4's service tests.

---

### Task 1: Rename Protoloom to Weaver

**Files:**
- Modify: every tracked file containing `protoloom`/`Protoloom`/`PROTOLOOM` except `docs/superpowers/**`
- Rename: `docs/brand/protoloom-*.svg` → `docs/brand/weaver-*.svg`, `packages/ui/src/assets/protoloom-*.svg` → `weaver-*.svg`
- Rename: CLI config default `protoloom.json` → `weaver.json`
- Modify: `gradle-plugin/build.gradle.kts`, `gradle-plugin/settings.gradle.kts`, plugin sources (package `dev.protoloom` → `dev.slne.weaver`, extension `protoloom {}` → `weaver {}`)
- Modify: `pnpm-lock.yaml` (regenerated by `pnpm install`)

**Interfaces:**
- Produces: workspace packages `@weaver/{config,core,db,jobs,ui,worker}`, CLI package `@slne/weaver-cli` with `bin: { weaver }`, env vars `WEAVER_URL`, `WEAVER_TOKEN`, `WEAVER_IMAGE`, `WEAVER_SMOKE_SEED`, `WEAVER_READ_TOKEN`, header `x-weaver-sha256`, `x-weaver-env`, `x-weaver-path`, queue name `weaver-cleanup` (renamed again in Task 11), brands `Symbol.for("weaver.RegistryError")`, `Symbol.for("weaver.QueueUnavailableError")`, globalThis key `__weaverServerContext`.

- [ ] **Step 1:** List all hits: `git grep -il protoloom -- ':!docs/superpowers'` and keep the list for verification.
- [ ] **Step 2:** Rename files (`git mv`) for SVGs and any file whose name contains `protoloom`; replace text with case-preserving substitutions (`Protoloom`→`Weaver`, `protoloom`→`weaver`, `PROTOLOOM`→`WEAVER`), then fix the special identifiers by hand: Gradle plugin id/group `dev.slne.weaver`, Kotlin package `dev.slne.weaver`, CLI package name `@slne/weaver-cli`, image `ghcr.io/slne-development/weaver`, URLs `github.com/SLNE-Development/weaver`, example domain `weaver.slne.dev`. SVG `aria-label` and wordmark `<text>` read `Weaver`.
- [ ] **Step 3:** Run `pnpm install` to refresh the lockfile.
- [ ] **Step 4:** Verify: `git grep -il protoloom -- ':!docs/superpowers'` prints nothing; `pnpm build && pnpm typecheck && pnpm lint && pnpm test` pass; `cd gradle-plugin && ./gradlew test --no-daemon` passes.
- [ ] **Step 5:** Commit `refactor: rename protoloom to weaver`.

### Task 2: Streaming object stores

**Files:**
- Create: `packages/core/src/storage/object-store.ts`, `packages/core/src/storage/hashing.ts`
- Modify: `packages/core/src/storage/local.ts`, `packages/core/src/storage/s3.ts`, `packages/core/src/storage/index.ts`
- Modify: `packages/core/src/registry/*.ts`, `packages/core/src/cleanup.ts`, `apps/web/src/server/context.ts`, `apps/worker/src/*.ts` (callers of `BlobStore`)
- Modify: `packages/core/package.json` (add `@aws-sdk/lib-storage` pinned to the same release line as `@aws-sdk/client-s3`)
- Test: `packages/core/src/storage/storage.test.ts`

**Interfaces:**
- Produces (exported from `@weaver/core`):
  ```ts
  type StoreId = "local" | "s3";
  interface ObjectDigests { md5: string; sha1: string; sha256: string; sha512: string } // lowercase hex
  interface PutResult extends ObjectDigests { size: number }
  interface ObjectInfo { size: number }
  interface ObjectRead { body: Readable; size: number; /** present when a range was requested */ range?: { start: number; end: number } }
  interface ObjectStore {
    readonly id: StoreId;
    /** Streams `body` to `key`, hashing on the way; the object only becomes visible once fully written. */
    put(key: string, body: Readable | Buffer, opts?: { contentLength?: number; signal?: AbortSignal }): Promise<PutResult>;
    get(key: string, opts?: { range?: { start: number; end?: number } }): Promise<ObjectRead | null>;
    head(key: string): Promise<ObjectInfo | null>;
    delete(key: string): Promise<void>;           // no throw when missing
    deleteMany(keys: string[]): Promise<void>;
  }
  interface StoreSet { primary: ObjectStore; get(id: StoreId): ObjectStore | null; configured(): StoreId[] }
  function createStoreSetFromEnv(env: NodeJS.ProcessEnv): StoreSet;
  function putBuffer(store: ObjectStore, key: string, data: Buffer): Promise<PutResult>;
  function getBuffer(store: ObjectStore, key: string): Promise<Buffer | null>;
  ```
- `BlobStore`/`createBlobStoreFromEnv` are removed; `ServerContext.blobs` becomes `ServerContext.stores: StoreSet`.

- [ ] **Step 1: Write failing tests** in `storage.test.ts`, parameterised over the local store (tmp dir) and the S3 store (existing test S3 container setup):
  - `put streams a 20 MiB generated stream and returns size and all four digests` — compare with `crypto.createHash` over the same bytes.
  - `put aborted via signal leaves no object` — `head(key)` is `null` afterwards.
  - `get with range returns exactly the requested bytes` — `{start: 10, end: 19}` → 10 bytes, `range` echoed.
  - `head returns size; missing key returns null`; `deleteMany ignores missing keys`.
  - `createStoreSetFromEnv configures both stores when both are set and picks primary by STORAGE_DRIVER`; `configured()` returns `["local","s3"]`; `get("s3")` is `null` when `S3_BUCKET` is unset.
- [ ] **Step 2:** Run `pnpm --filter @weaver/core test -- storage` → FAIL (missing exports).
- [ ] **Step 3:** Implement. Local: write to `<key>.tmp-<uuid>` then `rename`, keep the traversal guard. S3: `@aws-sdk/lib-storage` `Upload` (multipart, part size 8 MiB, queue size 4); range via `Range` header; `head` via `HeadObjectCommand`; `deleteMany` via `DeleteObjectsCommand` in batches of 1000. Hashing is a pass-through `Transform` in `hashing.ts`. Port proto code to `putBuffer`/`getBuffer`; behaviour and the 10 MB proto limits stay.
- [ ] **Step 4:** Run `pnpm --filter @weaver/core test` and `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(core): add streaming object stores with digests and ranges`.

### Task 3: Multi-format schema and reset migration

**Files:**
- Create: `packages/db/src/schema/repository.ts`, `packages/db/src/schema/content.ts`, `packages/db/src/schema/proto.ts`
- Delete: `packages/db/src/schema/registry.ts` (contents move into the three files above)
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/drizzle/0005_*.sql` (generated) — then hand-edit to start with `DELETE FROM "apikey"; DELETE FROM "invite";` and `DROP TABLE` the old registry tables before creating the new ones
- Modify: all `packages/core/src/**` and `apps/web/src/**` users of the old tables
- Test: `packages/db/src/migrate.test.ts`, `packages/db/src/create-db.test.ts`

**Interfaces:**
- Produces (exported from `@weaver/db`):
  - enums `repoFormatEnum = ["maven","npm","docker","proto"]`, `repoKindEnum = ["hosted","mirror","group"]`, `visibilityEnum`, `accessEnum`, `upstreamAuthEnum = ["none","basic","bearer"]`, `assetOriginEnum = ["hosted","cache"]`, `usageActionEnum = ["download","upload","delete"]`, `cacheResultEnum = ["hit","miss","bypass","stale"]`.
  - `repository`: `id uuid pk`, `name text unique`, `format`, `kind`, `description text null`, `visibility default 'private'`, `config jsonb not null default '{}'`, `dockerRoot boolean not null default false` (partial unique index `repository_docker_root_uq` on `docker_root` where `docker_root`), `createdAt`, `updatedAt`.
  - `repositoryUpstream`: `id`, `repositoryId → repository cascade`, `position int`, `url text`, `authType`, `username text null`, `secret text null` (ciphertext), unique `(repositoryId, position)`.
  - `groupMember`: `groupId → repository cascade`, `memberId → repository cascade`, `position int`; pk `(groupId, memberId)`, unique `(groupId, position)`.
  - `repoPermission` (replaces `api_key_permission`): `id`, `apiKeyId → apikey cascade`, `repositoryId → repository cascade`, `groupPrefix text null`, `access`; index on `apiKeyId`.
  - `component`: `id`, `repositoryId → repository cascade`, `namespace text not null default ''`, `name text`, `version text not null default ''`, `metadata jsonb not null default '{}'`, `downloadCount bigint default 0`, `lastDownloadedAt`, `createdAt`, `updatedAt`; unique `(repositoryId, namespace, name, version)`.
  - `asset`: `id`, `repositoryId → repository cascade`, `componentId → component set null`, `path text`, `store text` (`StoreId`), `storageKey text`, `size bigint`, `contentType text null`, `md5`, `sha1`, `sha256`, `sha512` (text), `origin`, `expiresAt timestamptz null` (metadata TTL; null = immutable), `lastAccessedAt`, `downloadCount bigint default 0`, `createdAt`, `updatedAt`; unique `(repositoryId, path)`; index `(repositoryId, origin, lastAccessedAt)`.
  - `usageEvent`: `id bigserial`, `at timestamptz default now()`, `repositoryId → repository set null`, `componentId → component set null`, `path text`, `action`, `cache null`, `bytes bigint default 0`, `userId text null`, `apiKeyId text null`; indexes on `at` and `(apiKeyId, at)`.
  - Proto tables renamed with a `proto_` prefix and otherwise unchanged: `protoArtifact`, `protoVersion`, `protoBuild`, `protoBuildFile`, `protoDependency`, `protoDeletedRelease` (FKs to `repository.id`).
  - `cleanupPolicy` kept (FK to `repository`), unchanged columns.
- Proto's former `repository` columns (`allowRedeploy`, `allowReleases`, `allowSnapshots`, `resolutionPriority`) move into `repository.config` (see Task 4) — this task reads them via a temporary `protoSettings(repo)` helper in `packages/core/src/registry/lookup.ts` returning `{ allowRedeploy, allowReleases, allowSnapshots, resolutionPriority }` with defaults `false, true, true, 100`; Task 4 replaces it with the parsed config.

- [ ] **Step 1: Write failing tests:** in `migrate.test.ts`, `migration keeps users and accounts and drops keys and content`: migrate a fresh DB to `0004`, insert a user, account, apikey, repository, artifact; migrate to head; assert user/account rows still exist and `apikey` is empty and table `artifact` no longer exists while `proto_artifact` does. Also `docker_root is unique when true`: inserting two repos with `docker_root = true` fails.
- [ ] **Step 2:** Run `pnpm --filter @weaver/db test` → FAIL.
- [ ] **Step 3:** Write the schema files; run `pnpm --filter @weaver/db db:generate`; hand-edit the SQL as described; update every caller so proto works on `proto_*` tables and `repository.format = 'proto'` (`createRepository` in proto paths sets `format: "proto", kind: "hosted"`).
- [ ] **Step 4:** Run `pnpm build && pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(db): add multi-format repository model and reset migration`.

### Task 4: Repository configuration and service

**Files:**
- Create: `packages/core/src/repos/config.ts`, `packages/core/src/repos/service.ts`, `packages/core/src/repos/rules.ts`, `packages/core/src/repos/index.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/registry/lookup.ts` (drop `protoSettings`, read `repo.config`)
- Modify: `apps/web/src/server/trpc/routers/repositories.ts` (delegate to the service)
- Test: `packages/core/src/repos/config.test.ts`, `packages/core/src/repos/rules.test.ts`, `packages/core/src/repos/service.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Format = "maven" | "npm" | "docker" | "proto";
  type Kind = "hosted" | "mirror" | "group";
  interface CacheConfig { enabled: boolean; store: StoreId | null /* null = settings.defaultCacheStore */; metadataTtlSeconds: number; maxAgeDays: number | null; maxSizeBytes: number | null }
  interface PathRules { allow: string[]; deny: string[] }
  interface MirrorConfig { cache: CacheConfig; offline: boolean; rules: PathRules; dockerHub?: boolean /* docker only */ }
  interface MavenHostedConfig { versionPolicy: "release" | "snapshot" | "mixed"; redeploy: boolean }
  interface NpmHostedConfig { redeploy: false }          // npm never overwrites a published version
  interface DockerHostedConfig { tagImmutable: boolean }
  interface ProtoHostedConfig { allowRedeploy: boolean; allowReleases: boolean; allowSnapshots: boolean; resolutionPriority: number }
  type RepositoryConfig = MavenHostedConfig | NpmHostedConfig | DockerHostedConfig | ProtoHostedConfig | MirrorConfig | Record<string, never>;
  function parseRepositoryConfig(format: Format, kind: Kind, raw: unknown): RepositoryConfig; // zod, fills defaults, throws invalid_request
  function defaultRepositoryConfig(format: Format, kind: Kind): RepositoryConfig;
  interface Repo { id: string; name: string; format: Format; kind: Kind; description: string | null; visibility: "public" | "private"; dockerRoot: boolean; config: RepositoryConfig }
  interface UpstreamInput { url: string; authType: "none" | "basic" | "bearer"; username?: string | null; /** undefined = keep existing secret */ secret?: string | null }
  interface UpstreamView { id: string; url: string; authType: "none" | "basic" | "bearer"; username: string | null; hasSecret: boolean }
  interface CreateRepoInput { name: string; format: Format; kind: Kind; description?: string | null; visibility?: "public" | "private"; config?: unknown; upstreams?: UpstreamInput[]; members?: string[] /* repo names, ordered */; dockerRoot?: boolean }
  type UpdateRepoInput = Partial<Omit<CreateRepoInput, "name" | "format" | "kind">>;
  interface RepoService {
    list(): Promise<Repo[]>;
    get(name: string): Promise<Repo | null>;
    getById(id: string): Promise<Repo | null>;
    create(actor: Principal, input: CreateRepoInput): Promise<Repo>;
    update(actor: Principal, name: string, patch: UpdateRepoInput): Promise<Repo>;
    delete(actor: Principal, name: string): Promise<void>;  // deletes stored objects of all assets and proto builds, then the row
    upstreams(repoId: string): Promise<UpstreamView[]>;
    upstreamsWithSecrets(repoId: string): Promise<Array<UpstreamView & { secret: string | null }>>; // decrypted, server-side only
    members(groupId: string): Promise<Repo[]>;              // ordered
    groupsContaining(memberId: string): Promise<Repo[]>;
    dockerRoot(): Promise<Repo | null>;
  }
  function createRepoService(deps: { db: Db; stores: StoreSet; secretKey: Buffer }): RepoService;
  /** Glob match where `*` matches any run of characters; empty allow = allow all; deny wins. */
  function matchesRules(rules: PathRules, subject: string): boolean;
  ```
- Defaults: maven hosted `{versionPolicy:"mixed", redeploy:false}`; docker hosted `{tagImmutable:false}`; proto hosted `{allowRedeploy:false, allowReleases:true, allowSnapshots:true, resolutionPriority:100}`; mirror `{cache:{enabled:false, store:null, metadataTtlSeconds:1800, maxAgeDays:null, maxSizeBytes:null}, offline:false, rules:{allow:[],deny:[]}}` plus `dockerHub: false` for docker.
- Consumes: Task 5 `encryptSecret`/`decryptSecret`.

- [ ] **Step 1: Write failing tests:**
  - config: `defaults for every format×kind`; `mirror cache disabled by default`; `rejects unknown keys and negative ttl with invalid_request`; `dockerHub only accepted for docker mirrors`.
  - rules: `matchesRules({allow:[],deny:[]}, "x") === true`; `allow ["org.apache.*"]` matches `org.apache.commons:lang3`, not `com.x:y`; `deny wins over allow`; `* matches across dots and slashes`.
  - service (Testcontainers DB): `create requires admin` (forbidden otherwise); `names are unique across formats`; `group members must exist, be same format, and not be groups`; `mirror requires at least one upstream with an http(s) url`; `only one docker root (second create fails with invalid_request)`; `docker repo named "library" is rejected`; `deleting a member removes it from groups`; `deleting a repo deletes its stored asset objects and cascades key permissions`; `upstream secrets are stored encrypted and upstreams() never returns them`; `update with secret undefined keeps the stored secret`; every mutation records an audit event (`repository.create|update|delete`).
- [ ] **Step 2:** Run `pnpm --filter @weaver/core test -- repos` → FAIL.
- [ ] **Step 3:** Implement; repo names keep today's `isValidRepositoryName` rule. Route the tRPC `repositories` router through the service.
- [ ] **Step 4:** Run `pnpm --filter @weaver/core test && pnpm --filter web test` → PASS.
- [ ] **Step 5:** Commit `feat(core): add repository configuration, rules and service`.

### Task 5: Secret encryption for upstream credentials

**Files:**
- Create: `packages/core/src/crypto.ts`
- Modify: `apps/web/src/server/context.ts`, `apps/worker/src/index.ts` (derive the key once from `BETTER_AUTH_SECRET`)
- Test: `packages/core/src/crypto.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** HKDF-SHA256 of the server secret with info "weaver-upstream-credentials", 32 bytes. */
  function deriveSecretKey(serverSecret: string): Buffer;
  /** AES-256-GCM; output "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>". */
  function encryptSecret(key: Buffer, plaintext: string): string;
  function decryptSecret(key: Buffer, value: string): string; // throws on tamper or wrong key
  ```

- [ ] **Step 1: Write failing tests:** round trip; two encryptions of the same plaintext differ; flipping one ciphertext byte throws; a different server secret cannot decrypt.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `node:crypto`. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(core): encrypt upstream credentials at rest`. (Execute this task before Task 4; it has no dependencies.)

### Task 6: Client authentication and per-repo permissions

**Files:**
- Modify: `packages/core/src/permissions.ts`, `apps/web/src/server/principal.ts`, `apps/web/src/server/trpc/routers/keys.ts`
- Create: `packages/core/src/auth/credentials.ts`
- Test: `packages/core/src/permissions.test.ts`, `packages/core/src/auth/credentials.test.ts`, `apps/web/src/server/principal.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface KeyPermission { repositoryId: string; repository: string; groupPrefix: string | null; access: Access }
  interface RepoRef { id: string; name: string; visibility: "public" | "private"; kind?: Kind }
  /** Extracts a token from `Authorization: Bearer <t>` or `Basic base64(<any user>:<t>)`; `""` for an empty one, `null` without the header. */
  function extractToken(headers: Headers): string | null;
  function canAccess(p: Principal, repo: RepoRef, scope: string, access: Access): boolean; // scope = proto group or "" (prefix rules only apply when the entry has one)
  /** Read through a group: true when `canAccess(p, group, "", "read")`. */
  function canReadThroughGroup(p: Principal, group: RepoRef): boolean;
  ```
  Writes on a repo with `kind === "group"` are always denied. Session users keep read-everything / write-nothing; key access is capped by role as today.
- `getPrincipal(req, deps)` uses `extractToken`, so every format gets Basic and Bearer auth.
- Keys tRPC router stores `repoPermission` rows by `repositoryId` (input still takes repository names, resolved and validated; unknown name → `BAD_REQUEST`).

- [ ] **Step 1: Write failing tests:** `extractToken` for Bearer, Basic with `user:tok`, Basic with `:tok`, malformed Basic → `""`; `canAccess` denies write on a group even with a write entry for it; `canReadThroughGroup` true for read entry on the group; principal test: Basic-authenticated request resolves to the key's principal; a banned owner via Basic is `unauthorized`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm --filter @weaver/core test && pnpm --filter web test` → PASS.
- [ ] **Step 5:** Commit `feat(auth): accept basic and bearer tokens with per-repo permissions`.

### Task 7: Mirror engine and asset store

**Files:**
- Create: `packages/core/src/content/assets.ts`, `packages/core/src/content/usage.ts`, `packages/core/src/mirror/upstream.ts`, `packages/core/src/mirror/engine.ts`, `packages/core/src/mirror/index.ts`
- Test: `packages/core/src/content/assets.test.ts`, `packages/core/src/mirror/mirror.test.ts` (uses a local `node:http` server as upstream)

**Interfaces:**
- Produces:
  ```ts
  interface AssetRow { id: string; repositoryId: string; componentId: string | null; path: string; store: StoreId; storageKey: string; size: number; contentType: string | null; md5: string; sha1: string; sha256: string; sha512: string; origin: "hosted" | "cache"; expiresAt: Date | null; lastAccessedAt: Date | null; createdAt: Date; updatedAt: Date }
  interface ComponentRef { namespace: string; name: string; version: string; metadata?: Record<string, unknown> }
  interface AssetService {
    find(repoId: string, path: string): Promise<AssetRow | null>;
    list(repoId: string, prefix: string): Promise<AssetRow[]>;
    /** Streams into the store under key `<repoId>/<origin>/<uuid>`, then upserts the row (replacing and deleting the previous object on conflict). */
    put(input: { repo: Repo; path: string; body: Readable; contentType?: string | null; origin: "hosted" | "cache"; store?: StoreId; expiresAt?: Date | null; component?: ComponentRef; contentLength?: number; signal?: AbortSignal }): Promise<AssetRow>;
    open(asset: AssetRow, range?: { start: number; end?: number }): Promise<ObjectRead | null>;
    delete(asset: AssetRow): Promise<void>;
    touch(assetId: string): Promise<void>; // lastAccessedAt = now
    upsertComponent(repoId: string, ref: ComponentRef): Promise<string>; // component id
  }
  function createAssetService(deps: { db: Db; stores: StoreSet }): AssetService;
  interface UsageInput { repositoryId: string | null; componentId?: string | null; assetId?: string | null; path: string; action: "download" | "upload" | "delete"; cache?: "hit" | "miss" | "bypass" | "stale"; bytes?: number; principal: Principal }
  /** Inserts a usage event and, for downloads, increments asset/component download counters and lastDownloadedAt. Never throws (logs). */
  function recordUsage(db: Db, input: UsageInput): Promise<void>;
  type ContentClass = "immutable" | "metadata";
  interface MirrorFetch {
    repo: Repo;                         // kind must be "mirror"
    path: string;                       // relative to each upstream base URL
    subject: string;                    // what rules match against
    class: ContentClass;
    method?: "GET" | "HEAD";
    headers?: Record<string, string>;   // forwarded (accept, etc.)
    component?: ComponentRef;
    /** Called on a 401 with WWW-Authenticate; returns an Authorization header value to retry once with, or null. */
    onChallenge?: (challenge: string, upstream: UpstreamView & { secret: string | null }) => Promise<string | null>;
  }
  interface MirrorResponse { status: number; headers: Headers; body: ReadableStream<Uint8Array> | null; cache: "hit" | "miss" | "bypass" | "stale"; asset: AssetRow | null; upstreamUrl: string | null }
  interface MirrorEngine {
    /** null = not found: rules reject, offline without cache, or every upstream answered 404. Upstream 5xx/network errors with no usable cache throw RegistryError("upstream_unavailable"). */
    fetch(req: MirrorFetch): Promise<MirrorResponse | null>;
  }
  function createMirrorEngine(deps: { db: Db; stores: StoreSet; repos: RepoService; assets: AssetService; settings: () => Promise<ServerSettings>; fetchImpl?: typeof fetch }): MirrorEngine;
  ```
- Adds error code `upstream_unavailable` (HTTP 502) to `ErrorCode`.
- Behaviour: rules checked first (no upstream contact on reject). Cache off → stream upstream body through (`bypass`), never write. Cache on → fresh asset (immutable, or metadata with `expiresAt > now`) served as `hit` and touched; else fetch upstreams in order (first non-404 wins; 2xx streamed to the client and to the store at the same time via a tee; asset row written only after the store write completes; for metadata `expiresAt = now + metadataTtlSeconds`); on upstream failure with an existing asset serve it as `stale`. Offline → only cached assets, regardless of expiry. Cache store = `config.cache.store ?? settings.defaultCacheStore`, falling back to primary if not configured. HEAD never writes the cache. Basic/Bearer upstream auth from the upstream row. Upstream requests time out after 30 s without response headers.

- [ ] **Step 1: Write failing tests** against a local upstream server:
  - `cache disabled: streams upstream body and writes no asset` (cache `bypass`, `asset` null, no rows).
  - `cache enabled: first request miss, second hit without contacting upstream` (count upstream hits).
  - `metadata expires after ttl and is refetched` (fake clock via `vi.setSystemTime`).
  - `upstream down with cached expired metadata serves stale`.
  - `offline serves cache only and returns null on miss without contacting upstream`.
  - `tries upstreams in order and skips 404s`; `deny rule returns null without contacting upstream`.
  - `basic credentials are sent as Authorization`; `onChallenge result is used for one retry`.
  - `aborted upstream leaves no asset row and no object` (server destroys socket mid-body).
  - `two concurrent misses for the same path both receive the full body and leave exactly one asset row`.
  - `recordUsage increments asset and component counters`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm --filter @weaver/core test` → PASS.
- [ ] **Step 5:** Commit `feat(core): add mirror engine with optional caching and asset store`.

### Task 8: Format mount points

**Files:**
- Create: `packages/core/src/formats.ts`
- Create: `apps/web/src/server/formats.ts`, `apps/web/src/app/maven/[...path]/route.ts`, `apps/web/src/app/npm/[...path]/route.ts`, `apps/web/src/app/v2/[[...path]]/route.ts`
- Modify: `apps/web/next.config.ts` (`skipTrailingSlashRedirect: true`), `apps/web/src/proxy.ts` (matcher also excludes `v2/`, `v2$`, `maven/`, `npm/`), `apps/web/src/server/context.ts` (adds `repos`, `assets`, `mirror`, `secretKey`)
- Test: `apps/web/src/server/formats.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // @weaver/core
  interface FormatDeps {
    db: Db; stores: StoreSet; repos: RepoService; assets: AssetService; mirror: MirrorEngine;
    principal(req: Request): Promise<Principal>;    // throws RegistryError("unauthorized") for a bad token
    settings(): Promise<ServerSettings>;
    publicUrl: string;                               // BETTER_AUTH_URL without trailing slash
    usage(input: UsageInput): Promise<void>;
  }
  /** `rest` is the raw, still percent-encoded path after the mount prefix, without a leading slash ("" for the prefix itself). */
  type FormatHandler = (req: Request, rest: string) => Promise<Response>;
  type FormatFactory = (deps: FormatDeps) => FormatHandler;
  // apps/web/src/server/formats.ts
  function getFormatHandler(mount: "maven" | "npm" | "docker"): FormatHandler; // memoised per process
  ```
  Until a format plan registers its factory, the mount returns `501` with body `{"error":{"code":"not_implemented","message":"<format> support is not installed"}}`. Format plans replace their placeholder in `apps/web/src/server/formats.ts` with one import + one map entry.
- Each route file exports `GET, HEAD, PUT, POST, PATCH, DELETE` (all `runtime = "nodejs"`, `dynamic = "force-dynamic"`), computing `rest` from `new URL(req.url).pathname` (not from params, to keep encoding), e.g. `/v2/` → `""` for docker, `/maven/releases/org/x/` → `releases/org/x/`.

- [ ] **Step 1: Write failing tests:** `rest is extracted raw: /npm/repo/@scope%2fpkg → "repo/@scope%2fpkg"`; `/v2/ maps to "" and /v2 maps to ""`; `trailing slash preserved for /maven/r/a/`; `placeholder answers 501 not_implemented`; and a config test asserting `next.config` has `skipTrailingSlashRedirect: true` and the proxy matcher does not match `/v2/x`, `/maven/x`, `/npm/x`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `pnpm --filter web test && pnpm --filter web build` → PASS.
- [ ] **Step 5:** Commit `feat(web): mount maven, npm and docker protocol endpoints`.

### Task 9: Storage settings

**Files:**
- Modify: `packages/core/src/settings.ts`, `apps/web/src/server/trpc/routers/settings.ts`
- Test: `packages/core/src/settings.test.ts`

**Interfaces:**
- Produces: `ServerSettings` gains `defaultCacheStore: StoreId` (default = the primary store id). `updateSettings` rejects a store that is not in `stores.configured()` with `invalid_request`; signature becomes `updateSettings(db, patch, actor, opts: { configuredStores: StoreId[] })`. New tRPC query `settings.storage` → `{ primary: StoreId; configured: StoreId[] }` (admin).

- [ ] **Step 1: Write failing tests:** default equals primary; setting `"s3"` when only local is configured fails; stored value round-trips.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(core): add default cache storage setting`.

### Task 10: Admin UI for repositories, keys and settings

**Files:**
- Modify: `apps/web/src/app/(app)/repositories/**` (list, create dialog, settings page), `apps/web/src/app/(app)/keys/**`, `apps/web/src/app/(app)/admin/settings/**`, `apps/web/src/app/(app)/browse/page.tsx`, `apps/web/src/app/(app)/browse/[repo]/page.tsx`
- Create: `apps/web/src/app/(app)/repositories/_components/{format-badge,upstreams-editor,members-editor,mirror-settings,hosted-settings}.tsx`, `apps/web/src/components/browse/registry.tsx`
- Modify: `apps/web/src/server/trpc/routers/repositories.ts`, `apps/web/src/server/trpc/routers/browse.ts`
- Test: `apps/web/src/server/trpc/routers.test.ts`, `apps/web/e2e/manage-repos-keys.spec.ts`

**Interfaces:**
- Consumes: Task 4 `RepoService`, Task 9 `settings.storage`.
- Produces: tRPC `repositories.list` returns `Array<Repo & { assetCount: number; storageBytes: number }>`; `repositories.create(CreateRepoInput)`, `repositories.update({ name, patch: UpdateRepoInput })`, `repositories.delete({ name })`, `repositories.upstreams({ name })`, `repositories.members({ name })`, `repositories.candidates({ format })` (hosted+mirror repos of a format for the member picker).
- `apps/web/src/components/browse/registry.tsx` exports `BROWSE_VIEWS: Partial<Record<Format, (props: { repo: Repo }) => React.ReactNode>>`; `/browse/[repo]` renders `BROWSE_VIEWS[repo.format]` or a "Browsing <format> repositories is not available yet" empty state. Proto's existing view is registered here. Format plans add one entry each.
- UI rules: create dialog asks name, format, kind (and for mirrors one upstream URL; for groups members) — everything else on the settings page with defaults. Settings page shows only sections for the repo's format/kind: hosted options per format; mirror: upstreams (ordered, add/remove/reorder, auth type, username, secret field showing "stored" when `hasSecret`), cache (toggle, store select limited to `configured`, TTL, max age, max size), offline toggle, allow/deny rules (one pattern per line), Docker Hub toggle and "root mirror" toggle for docker mirrors; group: ordered members. Repo lists show a format badge and kind. The keys page picks repositories from a list with format badges. Admin settings page adds "Default cache storage" select.

- [ ] **Step 1: Write failing tests:** router tests for `create` (admin only, defaults applied), `update` keeps secret when omitted, `candidates` excludes groups and other formats; Playwright: an admin creates an npm mirror with one upstream and sees "Caching off" on its settings page, enables caching and saves.
- [ ] **Step 2:** Run `pnpm --filter web test` → FAIL. **Step 3:** Implement with existing `@weaver/ui` components and page patterns (`admin-page.tsx`, dialogs). **Step 4:** `pnpm --filter web test && pnpm --filter web e2e -- manage-repos-keys` → PASS.
- [ ] **Step 5:** Commit `feat(web): manage multi-format repositories, mirrors and groups`.

### Task 11: Maintenance queue and cache eviction

**Files:**
- Modify: `packages/jobs/src/index.ts`, `apps/worker/src/worker.ts`, `apps/web/src/server/jobs.ts`
- Create: `packages/core/src/mirror/eviction.ts`
- Test: `packages/jobs/src/*.test.ts`, `apps/worker/src/worker.test.ts`, `packages/core/src/mirror/eviction.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // @weaver/jobs
  const MAINTENANCE_QUEUE = "weaver-maintenance";
  type MaintenanceJobData =
    | { kind: "cleanup:all" } | { kind: "cleanup:repo"; repository: string }
    | { kind: "evict:all" };
  // later plans extend the union (e.g. { kind: "docker:gc" }, { kind: "stats:rollup" })
  type MaintenanceQueue = Queue<MaintenanceJobData, unknown>;
  /** Upserts a job scheduler by id with a cron pattern. */
  function scheduleRepeating(queue: MaintenanceQueue, id: string, pattern: string, data: MaintenanceJobData): Promise<void>;
  // @weaver/core
  interface EvictionResult { repositories: number; assetsDeleted: number; bytesFreed: number }
  /** For each mirror with caching enabled: deletes cache assets idle longer than maxAgeDays, then least-recently-accessed ones until total ≤ maxSizeBytes. Also deletes all cache assets of mirrors whose caching is disabled. */
  function evictCaches(deps: { db: Db; assets: AssetService; now?: Date }): Promise<EvictionResult>;
  ```
  Schedulers: `cleanup-daily` at `0 3 * * *` (existing), `evict-hourly` at `17 * * * *`. Worker dispatches by `job.data.kind`.

- [ ] **Step 1: Write failing tests:** eviction by age; by size keeps the most recently accessed; disabled-cache mirror loses its cache; hosted assets never touched. Worker test: an `evict:all` job runs `evictCaches`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (rename `CLEANUP_QUEUE`, keep job options/backoff). **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5:** Commit `feat(worker): add maintenance queue with cache eviction`.

### Task order

5 → 1 → 2 → 3 → 4 → 6 → 7 → 8 → 9 → 10 → 11. After Task 11 run `pnpm build && pnpm typecheck && pnpm lint && pnpm test` and `scripts/e2e-smoke.sh` (proto still works end to end).

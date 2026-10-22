# Weaver Docker / OCI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Docker/OCI format to Weaver: an OCI Distribution registry at `/v2/...` with hosted, mirror
(including Docker Hub and a root mirror for `registry-mirrors`) and group repositories, a token service for
`docker login`, content-addressed blob storage with garbage collection, and a browse view.

**Architecture:** A new workspace package `@weaver/docker` exports `createDockerHandler: FormatFactory`, which
`apps/web/src/server/formats.ts` mounts at `/v2/*` (core Task 8). The handler parses the path into a route,
resolves the first name segment to a docker repo (falling back to the root docker mirror), authorizes the
request against a short-lived JWT from its own `/v2/token` endpoint, and dispatches to hosted, mirror or group
logic. Hosted blobs live in the primary object store under per-upload keys and are deduplicated per store by
digest in `docker_blob`; manifests are stored as exact bytes in Postgres. Mirrors use the core `MirrorEngine`
(so their cache is ordinary core assets, evicted by core eviction). A `docker:gc` maintenance job deletes
blobs no manifest references.

**Tech Stack:** TypeScript 6, Next.js 16 route handlers (Node runtime), Drizzle ORM 0.45 on PostgreSQL 17,
`node:crypto` (HS256 JWT, HKDF, SHA-256), BullMQ on Valkey, Vitest 5 with Testcontainers, tRPC 11, React 19.

**Spec:** `docs/superpowers/specs/2026-10-22-weaver-design.md`
**Core plan (interfaces consumed):** `docs/superpowers/plans/2026-10-22-weaver-0-core.md`

## Global Constraints

- Product name **Weaver**; workspace scope `@weaver/*`, env vars `WEAVER_*`, headers `x-weaver-*`, log prefix `weaver:`.
- Repository names are globally unique across formats; `library` is reserved for docker repos.
- Mirror caching is **disabled by default**. Default metadata TTL **1800 s**; max age and max size default to unlimited.
- Groups are read-only; members are hosted or mirror repos of the same format (no nested groups).
- Read permission on a group grants read of everything served through it.
- Storage reads and writes stream; nothing outside proto bundles is buffered whole in memory.
- Stock clients (`docker`, `podman`, `buildx`, containerd, `helm`, `oras`, `cosign`) need no special flag,
  patched config or documented workaround.
- Admin UI stays minimal: format/kind options appear only where they apply.
- Commit messages: Conventional Commits in English, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Where a task says "(trailer)", commit
  exactly as in Task 1 Step 5 with that task's message.
- Every exported function, type and component gets a doc comment saying what it does (repo convention).
- Pin new dependencies to exact versions, like the existing `package.json` files.
- Every `/v2` response carries `Docker-Distribution-API-Version: registry/2.0`; every error body is
  `{"errors":[{"code":"<CODE>","message":"<text>","detail":<json|null>}]}` with `content-type: application/json`.

## Review Focus

1. **Interrupted chunked upload resumed by the client** (`GET` upload status then `PATCH` from the reported
   offset): the `Range` header must report exactly the bytes persisted and the final digest must match;
   pinned by Task 5 `resumes after an interrupted PATCH`.
2. **The same new layer pushed concurrently to two repos**: both pushes succeed and exactly one `docker_blob`
   row exists for the digest, the losing object is deleted; pinned by Task 5 `concurrent uploads of one digest dedupe`.
3. **Manifest bytes with unusual whitespace or key order**: Weaver must serve the exact pushed bytes so the
   digest the client computed still matches; pinned by Task 6 `stores and serves exact manifest bytes`.
4. **Docker Hub answering blob GETs with a 307 to a CDN host**: the redirect is followed and the upstream
   bearer token is not sent to the CDN; pinned by Task 7 `follows blob redirect without forwarding authorization`.
5. **GC running while a push is in progress** (layers uploaded, manifest not yet PUT): the layers survive the
   grace period and the manifest PUT succeeds; pinned by Task 9 `keeps recently uploaded unreferenced blobs`.

## Decisions

- **Auth: Bearer token service, not a Basic challenge.** It is what Docker Hub, GHCR and distribution do, so
  docker, podman, buildx and containerd all take their best-tested path, and anonymous pulls of public repos
  work without credentials. `/v2/` and protected resources answer `401` with
  `WWW-Authenticate: Bearer realm="<publicUrl>/v2/token",service="<host>"` (+ `,scope="repository:<name>:<actions>"`
  on resource routes, + `,error="insufficient_scope"` when an anonymous JWT lacked the scope, or
  `,error="invalid_token"` for an expired or invalid JWT). The realm lives under `/v2`
  so no new Next.js route is needed; `/v2/token` (exactly, no further segments) never collides with an image path.
- **Token endpoint:** `GET /v2/token?service=&scope=...` (scope repeated or space-separated) authenticates with
  `deps.principal(req)` (core `extractToken`: Basic with the access token as password). `POST /v2/token`
  accepts `application/x-www-form-urlencoded` `grant_type=password&username=&password=&service=&scope=`
  (containerd); any other `grant_type` → `400 {"error":"unsupported_grant_type"}`. No credentials → anonymous
  token; bad credentials → `401` with the OCI `UNAUTHORIZED` body (docker prints "incorrect username or
  password"). Response `{token, access_token, expires_in: 300, issued_at}`. No refresh tokens.
- **JWT:** HS256 with `node:crypto`, key `HKDF-SHA256(deps.secretKey, info "weaver-docker-token", 32 bytes)`;
  claims `iss "weaver"`, `aud <host>`, `sub` (user id or `"anonymous"`), `iat`, `nbf`, `exp = iat + 300`, `jti`,
  `access: [{type:"repository", name, actions}]` (only actions actually granted, computed at issuance with
  `canAccess`/`canReadThroughGroup`), and `wv: {kind, userId?, keyId?, role?}` for usage attribution. Requests
  are authorized from the claims alone, so revoking a key takes effect within 5 minutes. As a convenience a
  non-JWT `Authorization` (Basic or Bearer access token) is also accepted on every route and resolved through
  `deps.principal` (curl, crane with basic auth).
- **Denials:** anonymous or missing scope → `401` + challenge; authenticated JWT/token with the scope missing
  → `403 DENIED "requested access to the resource is denied"`. Writes (push, delete) to a mirror or group →
  `405 UNSUPPORTED "<repo> is a <kind> repository and read-only"`.
- **Routing:** the first segment of the image name is a docker repo name when `repos.get(seg)` returns a repo
  with `format === "docker"`; then the image is the rest (empty rest → `400 NAME_INVALID`). Otherwise
  `repos.dockerRoot()` serves the full name as the image; no root → `404 NAME_UNKNOWN`. Docker Hub mirrors
  (`config.dockerHub`) map a single-segment image to `library/<image>` for upstream and rules. `_catalog` →
  `404 UNSUPPORTED`.
- **Uploads spool to a local temp file**, for monolithic and chunked uploads alike: `PATCH`/`PUT` bodies are
  piped (no buffering) to `<uploadDir>/<uploadId>`, and the final `PUT` streams that file into
  `stores.primary.put` (which computes sha256; mismatch → delete object, `400 DIGEST_INVALID`). This keeps
  resumable offsets trivial and sidesteps S3's 5 MiB minimum part size (lib-storage inside `ObjectStore.put`
  handles multipart). `uploadDir` = `WEAVER_DOCKER_UPLOAD_DIR` or `<os.tmpdir()>/weaver-uploads`; the docs tell
  self-hosters to mount a volume there. One upload id is serialized by an in-process mutex (single web instance).
- **Blob keys and dedup:** a finished blob is stored under `docker/blobs/sha256/<hex[0..2]>/<hex>-<uploadId>`;
  `docker_blob` is unique on `(store, digest)`. Finalizing upserts the row (`ON CONFLICT DO UPDATE SET
  last_linked_at = now()`); when another upload won, our object is deleted. When the row already exists before
  finalizing, the temp file is still hashed but not stored. A blob is visible in a repo/image only through a
  `docker_blob_link` row (no cross-repo existence leak).
- **Manifests** are stored as exact bytes in `docker_manifest.content bytea`, max 4 MiB (`413 SIZE_INVALID`
  above). Accepted media types: Docker v2 schema2 manifest and manifest list, OCI image manifest and OCI
  image index; schema1 → `400 MANIFEST_INVALID`. Referenced blobs (config, layers except foreign/`urls`
  layers) must be linked in the same repo/image (`400 MANIFEST_BLOB_UNKNOWN`); index children must exist in
  the same repo/image (`400 MANIFEST_UNKNOWN`). Platforms come from index entries or, for image manifests,
  from the config blob (read only when its size ≤ 1 MiB and its media type is an image config).
- **`tagImmutable`** (core `DockerHostedConfig`): moving an existing tag to a different digest →
  `403 DENIED "tag <t> is immutable"`; re-pushing the same digest is a no-op `201`.
- **Mirrors:** manifests by digest and blobs are `immutable`; manifests by tag, `tags/list` and `referrers`
  are `metadata`. Weaver always sends one fixed manifest `Accept` list upstream (all four types) so a cached
  tag manifest does not depend on the asking client. `Range` is never forwarded upstream; a range request on a
  cached blob is served from the asset with `assets.open(asset, range)`, otherwise answered `200` with the full
  body (permitted by HTTP). Cache hits on blobs verify `asset.sha256` against the digest (mismatch → delete
  asset, refetch). Upstream `Link` headers on `tags/list` are rewritten to the Weaver name.
- **Docker Hub auth** via core `onChallenge` plus a new `authorize` pre-hook (core change in Task 1) that
  replays a cached upstream token for the scope, so only the first request per scope per 5 minutes pays the
  401 round trip. Optional upstream credentials (basic: Docker Hub username + access token) are sent to the
  token realm.
- **Groups:** for each lookup (manifest, blob, tags/list, referrers) members are tried in order and the first
  member that has the item answers; tags are not merged.
- **Referrers:** hosted repos support the API (`200` OCI index, `OCI-Filters-Applied: artifactType` when
  filtered). Mirrors forward it; upstream not found → `404` so clients fall back to the `sha256-<hex>` tag
  schema, which works through ordinary manifest routes.
- **Blob DELETE** unlinks the blob from that repo/image (`202`); manifest DELETE by digest removes the manifest
  and its tags; DELETE by tag removes only the tag. GC reclaims storage.
- **GC:** job `{kind:"docker:gc"}`, scheduler `docker-gc-daily` at `30 3 * * *`. Grace period 24 h for links
  and blobs. Stale upload rows (no activity 24 h) are deleted by the job; temp files live on the web
  container, so the handler sweeps its upload dir (files without a live row, or older than 24 h) at most every
  10 minutes, triggered by upload requests.
- **Browse:** one `BROWSE_VIEWS.docker` view with in-page navigation through search params `?image=&digest=`
  (no new routes); data through a new tRPC `docker` router.

---

### Task 1: Core hooks the docker format needs

**Files:**
- Modify: `packages/core/src/formats.ts` (FormatDeps), `apps/web/src/server/formats.ts` (pass it)
- Modify: `packages/core/src/mirror/engine.ts` (MirrorFetch)
- Modify: `packages/jobs/src/index.ts` (MaintenanceJobData)
- Test: `packages/core/src/mirror/mirror.test.ts`, `apps/web/src/server/formats.test.ts`

**Interfaces:**
- Consumes: core Task 5 `deriveSecretKey`, core Task 8 `ServerContext.secretKey`.
- Produces (changes to core interfaces, additive):
  ```ts
  interface FormatDeps { /* ...core fields... */ secretKey: Buffer } // the derived server key; formats derive their own subkeys with HKDF
  interface MirrorFetch {
    /* ...core fields... */
    /** Called before the first request to each upstream; a non-null value is sent as Authorization instead of the upstream row's credentials. */
    authorize?: (upstream: UpstreamView & { secret: string | null }) => Promise<string | null>;
  }
  type MaintenanceJobData = /* ...core members... */ | { kind: "docker:gc" };
  ```

- [ ] **Step 1: Write failing tests** in `mirror.test.ts`: `authorize result replaces upstream credentials` (upstream row has basic creds; `authorize` returns `"Bearer t1"`; upstream server sees `authorization: Bearer t1`); `authorize null falls back to row credentials`; `onChallenge still retries once after an authorize value is rejected with 401`. In `formats.test.ts`: `format deps carry the secret key` (`deps.secretKey.length === 32`).
- [ ] **Step 2:** Run `pnpm --filter @weaver/core test -- mirror` and `pnpm --filter web test -- formats` → FAIL.
- [ ] **Step 3:** Implement; `docker:gc` jobs are no-ops in the worker dispatch until Task 9 (log and return).
- [ ] **Step 4:** Run `pnpm --filter @weaver/core test && pnpm --filter web test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add packages/core packages/jobs apps/web/src/server
  git commit -m "feat(core): add mirror authorize hook, format secret key and docker gc job kind" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Task 2: Docker schema and migration

**Files:**
- Create: `packages/db/src/schema/docker.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/drizzle/00NN_*.sql` + snapshot (generated)
- Test: `packages/db/src/docker-schema.test.ts`

**Interfaces:**
- Produces (exported from `@weaver/db`):
  - `dockerBlob`: `id uuid pk`, `store text` (StoreId), `digest text`, `size bigint`, `storageKey text`, `createdAt`, `lastLinkedAt timestamptz not null default now()`; unique `docker_blob_store_digest_uq (store, digest)`.
  - `dockerBlobLink`: `repositoryId → repository cascade`, `image text`, `blobId → docker_blob cascade`, `digest text`, `createdAt`; pk `(repositoryId, image, digest)`; index on `blobId`.
  - `dockerManifest`: `id uuid pk`, `repositoryId → repository cascade`, `image text`, `digest text`, `mediaType text`, `artifactType text null`, `subjectDigest text null`, `annotations jsonb null`, `platforms jsonb not null default '[]'` (`Array<{os, architecture, variant?}>`), `size bigint` (manifest bytes), `totalSize bigint` (config + layers, or sum of children), `content bytea`, `createdAt`, `lastPulledAt null`, `pullCount bigint default 0`; unique `(repositoryId, image, digest)`; index `(repositoryId, image, subjectDigest)`.
  - `dockerManifestRef`: `manifestId → docker_manifest cascade`, `digest text`, `kind text` (`"blob" | "manifest"`), `mediaType text`, `size bigint`, `position int`; pk `(manifestId, digest)`.
  - `dockerTag`: `repositoryId → repository cascade`, `image text`, `tag text`, `manifestId → docker_manifest cascade`, `updatedAt`, `lastPulledAt null`; pk `(repositoryId, image, tag)`.
  - `dockerUpload`: `id uuid pk`, `repositoryId → repository cascade`, `image text`, `offset bigint default 0`, `createdAt`, `updatedAt`.

- [ ] **Step 1: Write failing tests** (`startTestDb`): `docker tables exist after migrate`; `blob digest is unique per store` (second insert of `("local","sha256:aa")` fails, `("s3","sha256:aa")` succeeds); `deleting a manifest cascades its tags and refs`; `deleting a repository cascades links, manifests, tags and uploads`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/db test -- docker` → FAIL.
- [ ] **Step 3:** Write the schema; run `pnpm --filter @weaver/db db:generate` (one new migration, no hand edits).
- [ ] **Step 4:** Run `pnpm --filter @weaver/db test && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(db): add docker manifest, tag, blob and upload tables` (with the Co-Authored-By trailer).

### Task 3: Package scaffold, routing, errors and mount

**Files:**
- Create: `packages/docker/{package.json,tsconfig.json,tsconfig.build.json,eslint.config.js,vitest.config.ts}` (copy `packages/core`'s; deps `@weaver/core`, `@weaver/db`, `drizzle-orm`, `zod` at the versions core pins)
- Create: `packages/docker/src/index.ts`, `src/handler.ts`, `src/route.ts`, `src/errors.ts`, `src/media-types.ts`, `src/testing.ts`
- Modify: `apps/web/src/server/formats.ts` (register `createDockerHandler`), `apps/web/package.json` (`"@weaver/docker": "workspace:*"`)
- Test: `packages/docker/src/route.test.ts`, `packages/docker/src/handler.test.ts`

**Interfaces:**
- Consumes: core `FormatFactory`, `FormatDeps`, `RepoService.get`, `RepoService.dockerRoot`, `RegistryError`.
- Produces:
  ```ts
  type Route =
    | { kind: "base" } | { kind: "token" }
    | { kind: "manifest"; name: string; reference: string }          // tag or digest
    | { kind: "blob"; name: string; digest: string }
    | { kind: "upload-start"; name: string }                          // POST .../blobs/uploads/
    | { kind: "upload"; name: string; uploadId: string }
    | { kind: "tags"; name: string }
    | { kind: "referrers"; name: string; digest: string };
  /** Parses the raw rest after /v2/; null = no OCI route. Throws DockerError NAME_INVALID for bad names. */
  function parseRoute(rest: string): Route | null;
  interface Target { repo: Repo; image: string; name: string /* as the client sent it */ }
  /** Docker repo by first segment, else root mirror with the full name; null = NAME_UNKNOWN. */
  function resolveTarget(repos: RepoService, name: string): Promise<Target | null>;
  type DockerErrorCode = "BLOB_UNKNOWN" | "BLOB_UPLOAD_INVALID" | "BLOB_UPLOAD_UNKNOWN" | "DIGEST_INVALID" | "MANIFEST_BLOB_UNKNOWN" | "MANIFEST_INVALID" | "MANIFEST_UNKNOWN" | "NAME_INVALID" | "NAME_UNKNOWN" | "SIZE_INVALID" | "UNAUTHORIZED" | "DENIED" | "UNSUPPORTED" | "TOOMANYREQUESTS" | "RANGE_INVALID" | "UNAVAILABLE" | "UNKNOWN";
  class DockerError extends Error { constructor(status: number, code: DockerErrorCode, message: string, detail?: unknown, headers?: Record<string, string>) }
  function errorResponse(e: DockerError): Response;   // OCI error body + registry/2.0 header
  const MANIFEST_MEDIA_TYPES: readonly string[];       // the four accepted types
  function isDigest(s: string): boolean;               // sha256:<64 hex> (sha512:<128 hex> accepted for parsing)
  interface DockerOptions { uploadDir: string; now?: () => Date }
  function createDockerHandlerWith(deps: FormatDeps, opts: DockerOptions): FormatHandler;
  const createDockerHandler: FormatFactory;             // uploadDir from WEAVER_DOCKER_UPLOAD_DIR or os.tmpdir()/weaver-uploads
  // src/testing.ts (test-only export "./testing")
  function startDockerTestRegistry(opts?: { fetchImpl?: typeof fetch }): Promise<DockerTestRegistry>;
  interface DockerTestRegistry { deps: FormatDeps; handler: FormatHandler; call(method: string, rest: string, init?: { headers?: Record<string,string>; body?: BodyInit; token?: string }): Promise<Response>; createRepo(input: CreateRepoInput): Promise<Repo>; tokenFor(perms: Array<{ repo: string; access: Access }>): string; stop(): Promise<void> }
  ```
  `startDockerTestRegistry` uses `startTestDb`, a tmp-dir local store, real `createRepoService`/`createAssetService`/`createMirrorEngine`, and a `principal` stub mapping test tokens to `apikey` principals; `call` builds a plain `Request` for `http://weaver.test/v2/<rest>` and passes `Basic base64("x:<token>")` when `token` is set.
- Name grammar (OCI): each component `[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*`, joined by `/`; tag `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`. Routes are matched from the right: `^(.+)/blobs/uploads/([^/]*)$`, `^(.+)/blobs/([^/]+)$`, `^(.+)/manifests/([^/]+)$`, `^(.+)/tags/list$`, `^(.+)/referrers/([^/]+)$`; `""` → base; `token` → token.

- [ ] **Step 1: Write failing tests:**
  - route: `"" is base`; `"token" is token`; `"hosted/app/manifests/latest" → {kind:"manifest", name:"hosted/app", reference:"latest"}`; `"hosted/a/b/blobs/uploads/" → upload-start`; `"hosted/a/blobs/uploads/<uuid>" → upload`; `"hosted/a/blobs/sha256:<hex>" → blob`; `"m/library/nginx/tags/list" → tags`; `"Hosted/App/manifests/x" throws NAME_INVALID`; `"a/manifests/" is null`.
  - resolveTarget: `docker repo by first segment` (`hosted/app` → repo `hosted`, image `app`); `non-docker repo name falls through to root` (a maven repo `foo`; root mirror `hub` gets image `foo/bar`); `library/nginx goes to root`; `no root → null`; `repo segment alone ("hosted") → NAME_INVALID`.
  - handler: `unknown route answers 404 with OCI body and registry/2.0 header`; `GET /v2/ without auth → 401 with WWW-Authenticate Bearer realm="http://weaver.test/v2/token",service="weaver.test"`; `GET /v2/ with valid basic token → 200 {}`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test` → FAIL.
- [ ] **Step 3:** Implement; register in `apps/web/src/server/formats.ts` (one import + one map entry). The handler maps thrown `RegistryError`s: `unauthorized` → `401 UNAUTHORIZED` + challenge, `forbidden` → `403 DENIED`, `not_found` → `404 NAME_UNKNOWN`, `upstream_unavailable` → `502 UNAVAILABLE "upstream unavailable"`, anything else → `500 UNKNOWN` (logged with prefix `weaver:docker`). An upstream `429` passed through by the mirror engine becomes `429 TOOMANYREQUESTS` (Task 7).
- [ ] **Step 4:** Run `pnpm --filter @weaver/docker test && pnpm --filter web test -- formats && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(docker): add oci routing, errors and the /v2 mount` (trailer).

### Task 4: Token service and request authorization

**Files:**
- Create: `packages/docker/src/auth/jwt.ts`, `src/auth/token-endpoint.ts`, `src/auth/authorize.ts`
- Test: `packages/docker/src/auth/jwt.test.ts`, `src/auth/token-endpoint.test.ts`, `src/auth/authorize.test.ts`

**Interfaces:**
- Consumes: `FormatDeps.principal`, `FormatDeps.secretKey`, `FormatDeps.publicUrl`, core `canAccess`, `canReadThroughGroup`, `extractToken`, Task 3 `resolveTarget`.
- Produces:
  ```ts
  type DockerAction = "pull" | "push" | "delete";
  interface AccessEntry { type: "repository"; name: string; actions: DockerAction[] }
  interface DockerClaims { iss: "weaver"; aud: string; sub: string; iat: number; nbf: number; exp: number; jti: string; access: AccessEntry[]; wv: { kind: "anonymous" | "user" | "apikey"; userId?: string; keyId?: string; role?: Role } }
  function tokenKey(secretKey: Buffer): Buffer;                     // HKDF info "weaver-docker-token"
  function signToken(key: Buffer, claims: DockerClaims): string;
  function verifyToken(key: Buffer, token: string, aud: string, now: Date): DockerClaims | null; // null on bad sig, wrong aud, expired, nbf in future (30 s leeway)
  /** Parses scope strings ("repository:a/b:pull,push", space-separated lists); unknown types are ignored. */
  function parseScopes(values: string[]): AccessEntry[];
  /** Grants per entry: pull→read, push/delete→write; push/delete never granted on mirror or group targets. */
  function grantAccess(deps: FormatDeps, p: Principal, requested: AccessEntry[]): Promise<AccessEntry[]>;
  function handleToken(deps: FormatDeps, req: Request): Promise<Response>;
  interface Caller { principal: Principal; claims: DockerClaims | null }
  /** Resolves the caller from a JWT or a raw access token; throws DockerError 401 for an invalid/expired JWT. */
  function identify(deps: FormatDeps, req: Request): Promise<Caller>;
  /** Throws DockerError 401 (anonymous/insufficient_scope) or 403 DENIED or 405 UNSUPPORTED per Decisions. */
  function requireAccess(deps: FormatDeps, caller: Caller, target: Target, action: DockerAction): void;
  ```

- [ ] **Step 1: Write failing tests:**
  - jwt: `round trip`; `tampered signature → null`; `expired (exp+31 s) → null`; `wrong audience → null`; `key differs from deriveSecretKey output for another info`.
  - token endpoint: `anonymous GET grants pull on a public hosted repo and nothing on a private one` (decoded `access` equals `[{type:"repository",name:"pub/app",actions:["pull"]}]`); `basic with a write key grants pull,push`; `viewer-owned key gets pull only`; `invalid basic → 401 UNAUTHORIZED`; `push on a group or mirror is never granted`; `group read grants pull on group/app`; `root mirror scope "library/nginx" is granted when the root mirror is public`; `POST form grant_type=password works`; `POST grant_type=refresh_token → 400 unsupported_grant_type`; `response has token, access_token, expires_in 300, issued_at`; `scope given twice and space-separated both parse`.
  - authorize: `anonymous on private → 401 with scope="repository:priv/app:pull"`; `JWT lacking push → 403 DENIED`; `push to mirror → 405 UNSUPPORTED`; `raw basic access token authorizes without JWT`; `expired JWT → 401 with error="invalid_token"`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test -- auth` → FAIL.
- [ ] **Step 3:** Implement with `node:crypto` (`createHmac`, `hkdfSync`, `timingSafeEqual`, base64url); wire `token` route and `base` route into the handler (`base` requires a valid JWT or raw token, else 401).
- [ ] **Step 4:** Run `pnpm --filter @weaver/docker test` → PASS.
- [ ] **Step 5: Commit** `feat(docker): add token service and scoped request authorization` (trailer).

### Task 5: Hosted blobs and uploads

**Files:**
- Create: `packages/docker/src/hosted/blobs.ts`, `src/hosted/uploads.ts`, `src/hosted/spool.ts`
- Test: `packages/docker/src/hosted/blobs.test.ts`, `src/hosted/uploads.test.ts`

**Interfaces:**
- Consumes: Task 2 tables, Task 4 `requireAccess`, `StoreSet.primary`, `ObjectStore.put/get/head/delete`, `FormatDeps.usage`.
- Produces:
  ```ts
  interface BlobRef { blobId: string; store: StoreId; storageKey: string; size: number; digest: string }
  /** Linked blob of repo/image, or null. */
  function findLinkedBlob(db: Db, repoId: string, image: string, digest: string): Promise<BlobRef | null>;
  function linkBlob(db: Db, repoId: string, image: string, blob: BlobRef): Promise<void>; // idempotent
  function serveHostedBlob(ctx: HostedCtx, req: Request, digest: string): Promise<Response>;   // GET/HEAD
  function deleteHostedBlob(ctx: HostedCtx, digest: string): Promise<Response>;
  function startUpload(ctx: HostedCtx, req: Request): Promise<Response>;   // POST (plain, ?digest=, ?mount=&from=)
  function patchUpload(ctx: HostedCtx, req: Request, id: string): Promise<Response>;
  function finishUpload(ctx: HostedCtx, req: Request, id: string): Promise<Response>;   // PUT ?digest=
  function uploadStatus(ctx: HostedCtx, id: string): Promise<Response>;
  function cancelUpload(ctx: HostedCtx, id: string): Promise<Response>;
  interface HostedCtx { deps: FormatDeps; opts: DockerOptions; caller: Caller; target: Target }
  /** Pipes a web ReadableStream to the end of a file; returns bytes written. Aborted/failed streams truncate back to the previous length. */
  function appendToSpool(path: string, body: ReadableStream<Uint8Array>, expectedStart: number): Promise<number>;
  ```
- Wire behaviour (OCI): `POST` → `202`, `Location: /v2/<name>/blobs/uploads/<id>`, `Docker-Upload-UUID`, `Range: 0-0`, `Content-Length: 0`. `PATCH` → `202` with `Range: 0-<offset-1>`; a `Content-Range` whose start ≠ offset → `416 RANGE_INVALID` with the current `Range`. `PUT ?digest=` (optional final body) → `201`, `Location: /v2/<name>/blobs/<digest>`, `Docker-Content-Digest`. Bad digest → `400 DIGEST_INVALID`, upload kept for retry. Unknown/foreign upload id → `404 BLOB_UPLOAD_UNKNOWN`. `POST ?digest=` with body → monolithic `201`. Mount: source resolved with `resolveTarget`, must be hosted in the same store, readable by the caller (`claims` must list pull on the `from` name, or `canAccess`) and have the blob linked → `201`; otherwise ordinary `202` upload. Blob GET → `200` streaming `ObjectStore.get`, `Content-Type: application/octet-stream`, `Docker-Content-Digest`, `Accept-Ranges: bytes`, `ETag: "<digest>"`; `Range: bytes=a-b` → `206` with `Content-Range`; unsatisfiable → `416`. HEAD → headers only. DELETE → `202`. Downloads call `deps.usage({action:"download", bytes})`, finished uploads `action:"upload"`.

- [ ] **Step 1: Write failing tests** (via `startDockerTestRegistry`, blobs generated with a seeded PRNG stream):
  - `monolithic POST ?digest= stores and serves the blob` (GET body sha256 equals digest; `Docker-Content-Digest` set).
  - `POST, PATCH whole body, PUT empty (docker push flow)`; `chunked PATCHes with Content-Range 0-999, 1000-1999 then PUT with final chunk`.
  - `out-of-order chunk → 416 with Range 0-999`.
  - `resumes after an interrupted PATCH` — a PATCH body stream errors after 600 of 1000 bytes; `GET` status reports the persisted offset (`Range: 0-599`); PATCH from 600 then PUT succeeds with the right digest.
  - `wrong digest on PUT → 400 DIGEST_INVALID and no blob row`.
  - `64 MiB PATCH is spooled with backpressure` — the body is a pull-based `ReadableStream` of 64 KiB chunks; at every pull, bytes produced minus the spool file's size stays ≤ 4 MiB, and the finished blob's digest matches.
  - `concurrent uploads of one digest dedupe` — two repos finish the same digest in parallel: both `201`, one `docker_blob` row, exactly one object under `docker/blobs/sha256/`.
  - `second push of an existing digest stores nothing new and links it`.
  - `blob of another repo is 404 BLOB_UNKNOWN until mounted`; `mount from a readable repo → 201`; `mount from an unreadable repo → 202 upload`.
  - `GET with Range: bytes=10-19 → 206 with 10 bytes and Content-Range bytes 10-19/<size>`; `HEAD has Content-Length and no body`.
  - `DELETE upload → 204 and the spool file is gone`; `DELETE blob → 202 then GET 404`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test -- hosted/blobs hosted/uploads` → FAIL.
- [ ] **Step 3:** Implement; use `stream.Readable.fromWeb` + `pipeline` into `fs.createWriteStream(path, { flags: "a" })`; `offset` in `docker_upload` is updated after each completed append, and `fs.truncate` restores it on failure. Finalize per Decisions (unique key, upsert, delete loser object, delete spool file and upload row).
- [ ] **Step 4:** Run `pnpm --filter @weaver/docker test` → PASS.
- [ ] **Step 5: Commit** `feat(docker): add hosted blob storage with chunked, resumable uploads and mounts` (trailer).

### Task 6: Hosted manifests, tags and referrers

**Files:**
- Create: `packages/docker/src/hosted/manifests.ts`, `src/hosted/tags.ts`, `src/hosted/referrers.ts`, `src/manifest-parse.ts`
- Test: `packages/docker/src/manifest-parse.test.ts`, `src/hosted/manifests.test.ts`, `src/hosted/tags.test.ts`, `src/hosted/referrers.test.ts`

**Interfaces:**
- Consumes: Task 5 `findLinkedBlob`, Task 2 tables, `DockerHostedConfig.tagImmutable`.
- Produces:
  ```ts
  interface Descriptor { mediaType: string; digest: string; size: number; platform?: Platform; artifactType?: string; annotations?: Record<string, string>; urls?: string[] }
  interface Platform { os: string; architecture: string; variant?: string }
  interface ParsedManifest { mediaType: string; isIndex: boolean; config: Descriptor | null; layers: Descriptor[]; manifests: Descriptor[]; subject: Descriptor | null; artifactType: string | null; annotations: Record<string, string> | null }
  /** Validates JSON shape and media type (Content-Type must match `mediaType` when present). Throws DockerError MANIFEST_INVALID. */
  function parseManifest(bytes: Buffer, contentType: string | null): ParsedManifest;
  interface StoredManifest { id: string; digest: string; mediaType: string; size: number; content: Buffer; subjectDigest: string | null }
  function findManifest(db: Db, repoId: string, image: string, reference: string): Promise<StoredManifest | null>; // tag or digest
  function putManifest(ctx: HostedCtx, req: Request, reference: string): Promise<Response>;
  function serveManifest(ctx: HostedCtx, req: Request, reference: string): Promise<Response>;  // GET/HEAD
  function deleteManifest(ctx: HostedCtx, reference: string): Promise<Response>;
  function listTags(db: Db, repoId: string, image: string, n: number | null, last: string | null): Promise<{ tags: string[]; more: boolean }>;
  function serveTags(ctx: HostedCtx, req: Request): Promise<Response>;
  function listReferrers(db: Db, repoId: string, image: string, digest: string, artifactType: string | null): Promise<Descriptor[]>;
  function serveReferrers(ctx: HostedCtx, req: Request, digest: string): Promise<Response>;
  ```
- Manifest PUT reads the body with a 4 MiB cap (stream with a byte counter; over → `413 SIZE_INVALID`), digest = `sha256:` of the exact bytes; a digest reference must equal it (`400 DIGEST_INVALID`). Stores the row, refs, and the tag in one transaction; response `201`, `Location: /v2/<name>/manifests/<digest>`, `Docker-Content-Digest`, plus `OCI-Subject: <digest>` when `subject` is set. GET/HEAD: `Content-Type` = stored media type, `Content-Length`, `Docker-Content-Digest`, `ETag`; updates `lastPulledAt`/`pullCount` on manifest and tag and records usage (GET only). Tags list: lexical order, `n` default unlimited (cap 1000), `Link: </v2/<name>/tags/list?n=<n>&last=<lastTag>>; rel="next"` when more; unknown image → `404 NAME_UNKNOWN`. Referrers: `200`, `Content-Type: application/vnd.oci.image.index.v1+json`, `{schemaVersion:2, mediaType, manifests:[...]}`; descriptor `artifactType` = manifest `artifactType` ?? config media type; empty list when none (never 404 in hosted).

- [ ] **Step 1: Write failing tests:**
  - parse: `docker schema2 image`, `docker manifest list`, `oci manifest`, `oci index`, `helm chart (config application/vnd.cncf.helm.config.v1+json)`, `cosign signature with subject`, `schema1 rejected`, `content-type mismatch rejected`, `invalid JSON rejected`.
  - manifests: `push image by tag then GET by tag and by digest returns identical bytes and headers`; `stores and serves exact manifest bytes` (manifest with 3-space indentation and reordered keys; GET body is byte-equal and digest matches the client's sha256); `manifest referencing an unlinked layer → 400 MANIFEST_BLOB_UNKNOWN`; `foreign layer with urls is not required`; `multi-arch index whose children were pushed by digest first`; `index with a missing child → 400 MANIFEST_UNKNOWN`; `platforms are read from the config blob and from index entries` (row `platforms` equals `[{os:"linux",architecture:"arm64",variant:"v8"}]`); `PUT by digest with mismatching bytes → 400 DIGEST_INVALID`; `over 4 MiB → 413 SIZE_INVALID`; `tagImmutable rejects moving a tag with 403 DENIED but accepts the same digest`; `HEAD has no body and the same headers as GET`; `DELETE by tag removes the tag only`; `DELETE by digest removes manifest and its tags`; `unknown tag → 404 MANIFEST_UNKNOWN`.
  - tags: `n=2 returns 2 tags and a Link to the next page`; `last=b continues after b`; `sorted lexically`.
  - referrers: `cosign signature and SBOM attached to an image are listed`; `artifactType filter returns only matches and sets OCI-Filters-Applied`; `OCI-Subject header on push of a referrer`; `empty index for a digest without referrers`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test -- manifest tags referrers` → FAIL.
- [ ] **Step 3:** Implement; wire all hosted routes into the handler through `requireAccess` (`GET/HEAD` → pull, `PUT/POST/PATCH` → push, `DELETE` → delete).
- [ ] **Step 4:** Run `pnpm --filter @weaver/docker test` → PASS.
- [ ] **Step 5: Commit** `feat(docker): add hosted manifests, tags and the referrers api` (trailer).

### Task 7: Mirror repositories and Docker Hub

**Files:**
- Create: `packages/docker/src/mirror/mirror.ts`, `src/mirror/hub-auth.ts`
- Test: `packages/docker/src/mirror/mirror.test.ts`, `src/mirror/hub-auth.test.ts` (local `node:http` servers as registry, token realm and CDN)

**Interfaces:**
- Consumes: core `MirrorEngine.fetch(MirrorFetch)` with `class`, `onChallenge`, Task 1 `authorize`; `AssetService.find/open/delete`; `MirrorConfig.dockerHub`, `MirrorConfig.rules`.
- Produces:
  ```ts
  /** Upstream image name: Docker Hub mirrors map "nginx" to "library/nginx". */
  function upstreamImage(repo: Repo, image: string): string;
  /** Parses `Bearer realm="…",service="…",scope="…"`; null for other schemes. */
  function parseChallenge(header: string): { realm: string; service?: string; scope?: string } | null;
  interface HubAuth {
    authorize(upstream: UpstreamView & { secret: string | null }, scope: string): Promise<string | null>;  // cached "Bearer <t>"
    onChallenge(challenge: string, upstream: UpstreamView & { secret: string | null }): Promise<string | null>;
  }
  function createHubAuth(fetchImpl: typeof fetch, now: () => Date): HubAuth;   // cache key (upstream.id, scope), lifetime expires_in - 30 s (default 60 s)
  function mirrorManifest(ctx: MirrorCtx, req: Request, reference: string): Promise<Response | null>;
  function mirrorBlob(ctx: MirrorCtx, req: Request, digest: string): Promise<Response | null>;
  function mirrorTags(ctx: MirrorCtx, req: Request): Promise<Response | null>;
  function mirrorReferrers(ctx: MirrorCtx, req: Request, digest: string): Promise<Response | null>;
  interface MirrorCtx { deps: FormatDeps; caller: Caller; target: Target; hub: HubAuth }
  ```
  `null` = not found (the group logic in Task 8 relies on it); the route turns it into `404 MANIFEST_UNKNOWN`/`BLOB_UNKNOWN`/`NAME_UNKNOWN`.
- Mapping to `MirrorFetch`: path `v2/<upstreamImage>/manifests/<ref>` (class `immutable` when `ref` is a digest, else `metadata`), `v2/<upstreamImage>/blobs/<digest>` (`immutable`), `v2/<upstreamImage>/tags/list?<query>` and `v2/<upstreamImage>/referrers/<digest>?<query>` (`metadata`); `subject` = upstream image name; manifest `headers.accept` = `MANIFEST_MEDIA_TYPES.join(", ")`; `method` HEAD passed through. Response headers kept: `content-type`, `content-length`, `docker-content-digest` (computed as `sha256:<asset.sha256>` when served from cache), `etag`; upstream `www-authenticate` is never passed on. Upstream `Link` path `/v2/<upstreamImage>/` → `/v2/<target.name>/`. Scope for `authorize` = `repository:<upstreamImage>:pull`. `usage` with `cache` from `MirrorResponse.cache`.

- [ ] **Step 1: Write failing tests:**
  - hub-auth: `parses a Docker Hub challenge`; `fetches a token with basic upstream credentials and caches it until expires_in - 30 s`; `anonymous token request sends no authorization`; `token endpoint failure → null`.
  - mirror (fake registry requiring bearer tokens from a fake realm): `pulls manifest by tag through a dockerHub mirror mapping nginx → library/nginx`; `second manifest request reuses the cached upstream token (one token fetch)`; `cache off: blob streamed, no asset row`; `cache on: blob served from cache on the second GET without upstream contact`; `tag manifest is metadata: refetched after ttl`; `digest manifest is immutable: not refetched after ttl`; `deny rule "library/*" answers 404 without upstream contact`; `follows blob redirect without forwarding authorization` (registry answers 307 to a CDN server that records headers; CDN sees no `authorization`); `range request on a cached blob → 206 from the asset`; `range request uncached → 200 full body`; `cached blob with wrong sha256 is deleted and refetched`; `tags/list Link header is rewritten to the weaver name`; `upstream referrers 404 → 404`; `upstream 429 → 429 TOOMANYREQUESTS`; `push to a mirror → 405 UNSUPPORTED`.
  - root routing: `GET /v2/library/nginx/manifests/latest is served by the root mirror` and `GET /v2/nginx/manifests/latest maps to library/nginx when the root is a dockerHub mirror`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test -- mirror` → FAIL.
- [ ] **Step 3:** Implement; one `HubAuth` per handler instance.
- [ ] **Step 4:** Run `pnpm --filter @weaver/docker test` → PASS.
- [ ] **Step 5: Commit** `feat(docker): add mirror repositories with docker hub token auth` (trailer).

### Task 8: Group repositories

**Files:**
- Create: `packages/docker/src/group.ts`
- Test: `packages/docker/src/group.test.ts`

**Interfaces:**
- Consumes: `RepoService.members`, Task 5/6 hosted lookups, Task 7 mirror functions, core `canReadThroughGroup`.
- Produces:
  ```ts
  /** Tries members in order; the first non-null answer wins. Hosted members answer null when the item is missing. */
  function fromGroup(ctx: { deps: FormatDeps; caller: Caller; target: Target; hub: HubAuth }, op: "manifest" | "blob" | "tags" | "referrers", req: Request, arg: string): Promise<Response | null>;
  ```
  Members are called with a member-scoped `Target` (`repo` = member, same `image` and client `name`) and without re-checking member permissions (group read covers them). Hosted members' tag lists and referrers answer null when the image has no manifests.

- [ ] **Step 1: Write failing tests:** `manifest from the first member that has it` (both members have `app:1`, group returns member 1's digest); `falls through a hosted miss to a mirror`; `blob only in the second member is served`; `read on the group alone serves a private member's content`; `tags/list comes from the first member with the image`; `push to a group → 405 UNSUPPORTED`; `token service never grants push on group/app`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test -- group` → FAIL.
- [ ] **Step 3:** Implement and wire the group branch into the handler.
- [ ] **Step 4:** Run `pnpm --filter @weaver/docker test` → PASS.
- [ ] **Step 5: Commit** `feat(docker): serve group repositories in member order` (trailer).

### Task 9: Garbage collection and upload cleanup

**Files:**
- Create: `packages/docker/src/gc.ts`, `packages/docker/src/sweep.ts`
- Modify: `packages/docker/package.json` (export `./gc` for the worker), `apps/worker/package.json` (`"@weaver/docker": "workspace:*"`), `apps/worker/src/worker.ts` (dispatch `docker:gc`, schedule `docker-gc-daily`)
- Test: `packages/docker/src/gc.test.ts`, `packages/docker/src/sweep.test.ts`, `apps/worker/src/worker.test.ts`

**Interfaces:**
- Consumes: core `MAINTENANCE_QUEUE`, `scheduleRepeating`, Task 1 `{kind:"docker:gc"}`, `StoreSet.get(id).deleteMany`.
- Produces:
  ```ts
  interface DockerGcResult { linksDeleted: number; blobsDeleted: number; bytesFreed: number; uploadsDeleted: number }
  const DOCKER_GC_GRACE_MS = 24 * 60 * 60 * 1000;
  /** 1) deletes upload rows idle > grace; 2) deletes links older than grace whose digest no manifest of the same repo/image references; 3) deletes blob rows with no links and lastLinkedAt older than grace, then their objects. */
  function runDockerGc(deps: { db: Db; stores: StoreSet; now?: Date }): Promise<DockerGcResult>;
  /** Deletes spool files with no live upload row or mtime older than grace. Runs at most every 10 min per process. */
  function sweepUploads(db: Db, uploadDir: string, now: Date): Promise<number>;
  ```
  Step 3 is one `DELETE ... WHERE NOT EXISTS (link) AND last_linked_at < $cutoff RETURNING store, storage_key, size`; objects are deleted after commit (a crash leaves orphans only, never dangling rows). Manifests are never deleted by GC (untagged-manifest cleanup belongs to plan 5's cleanup policies, which then rely on this GC).

- [ ] **Step 1: Write failing tests:**
  - `deletes a blob whose only manifest was deleted` (after `now + 25 h`: row and object gone, `bytesFreed` equals size).
  - `keeps recently uploaded unreferenced blobs` (layer uploaded, no manifest, GC at `now + 1 h` keeps link, row and object; then manifest PUT succeeds).
  - `keeps a blob still referenced by another repo's manifest` (shared digest, one repo deletes its manifest).
  - `keeps blobs referenced only by a child manifest of an index`.
  - `deletes upload rows idle for 25 h`; sweep: `removes orphan spool files and keeps live ones`.
  - `relinking during gc keeps the blob` (upsert `lastLinkedAt = now` before the delete runs → blob kept).
  - worker: `a docker:gc job runs runDockerGc and docker-gc-daily is scheduled at "30 3 * * *"`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test -- gc sweep` and `pnpm --filter worker test` → FAIL.
- [ ] **Step 3:** Implement; call `sweepUploads` from `startUpload` behind the 10-minute throttle.
- [ ] **Step 4:** Run `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(docker): garbage-collect unreferenced blobs and stale uploads` (trailer).

### Task 10: Browse view, client snippets and docs

**Files:**
- Create: `packages/docker/src/browse.ts`
- Create: `apps/web/src/server/trpc/routers/docker.ts`; Modify: `apps/web/src/server/trpc/root.ts`, `apps/web/package.json`
- Create: `apps/web/src/components/browse/docker/{docker-repo-view,image-list,image-detail,manifest-detail,docker-snippets}.tsx`
- Modify: `apps/web/src/components/browse/registry.tsx` (`BROWSE_VIEWS.docker`)
- Create: `apps/web/content/docs/docker.md`; Modify: `apps/web/content/docs/self-host/compose.md` (upload dir volume, proxy body size), `apps/web/src/lib/docs.test.ts` (`PLAN` gains `/docs/docker` after `/docs/cli`)
- Test: `packages/docker/src/browse.test.ts`, `apps/web/src/server/trpc/routers.test.ts`, `apps/web/e2e/browse-docker.spec.ts`

**Interfaces:**
- Consumes: core `BROWSE_VIEWS`, `Repo`; tRPC `browseProcedure`, `requireBrowsableRepository` from `apps/web/src/server/trpc/{init,helpers}.ts`.
- Produces:
  ```ts
  // @weaver/docker/browse
  interface ImageSummary { image: string; tagCount: number; manifestCount: number; totalSize: number; updatedAt: Date }
  interface TagRow { tag: string; digest: string; mediaType: string; platforms: Platform[]; totalSize: number; updatedAt: Date; lastPulledAt: Date | null }
  interface ManifestDetail { digest: string; mediaType: string; artifactType: string | null; platforms: Platform[]; size: number; totalSize: number; tags: string[]; refs: Array<{ kind: "blob" | "manifest"; digest: string; mediaType: string; size: number; platform?: Platform }>; referrers: Descriptor[]; createdAt: Date }
  function listImages(db: Db, repoId: string, opts: { query?: string; cursor?: string; limit: number }): Promise<{ items: ImageSummary[]; next: string | null }>;
  function listImageTags(db: Db, repoId: string, image: string): Promise<TagRow[]>;
  function getManifestDetail(db: Db, repoId: string, image: string, digest: string): Promise<ManifestDetail | null>;
  /** Copy-paste snippets for a repo: login, pull, push (hosted only), daemon.json registry-mirrors (root mirror only). */
  function dockerSnippets(publicUrl: string, repo: Repo, image?: string, tag?: string): { login: string; pull: string; push: string | null; daemonJson: string | null };
  ```
  tRPC `docker.images({ repo, query?, cursor? })`, `docker.tags({ repo, image })`, `docker.manifest({ repo, image, digest })` (all `browseProcedure` + `requireBrowsableRepository`). The view reads `?image=` and `?digest=`; a mirror with caching off and group repos show "Content of this repository lives upstream; Weaver shows only what it stores" (mirror) or lists members' browse links (group). Attached artifacts (referrers) render with a type label: Helm chart, cosign signature, SBOM (`application/spdx+json`, `application/vnd.cyclonedx+json`), else the raw artifact type.
- Docs page `docker.md`: frontmatter `title: Docker and OCI`, `section: Clients`, `order` after the CLI page; covers `docker login {{host}}` with an access token as password, push/pull URLs `{{host}}/<repo>/<image>:<tag>`, mirrors and Docker Hub (`library/` mapping, optional Docker Hub credentials), root mirror with `daemon.json` `registry-mirrors`, groups, helm `helm push chart.tgz oci://{{host}}/<repo>`, cosign/oras referrers, deletes and GC, and the upload directory.

- [ ] **Step 1: Write failing tests:**
  - browse: `listImages groups by image with tag counts and sizes`; `listImageTags sorts by updatedAt desc`; `getManifestDetail lists layers, children with platforms and referrers`.
  - snippets: `hosted repo: login "docker login weaver.slne.dev", pull "docker pull weaver.slne.dev/apps/web:latest", push set`; `root mirror: daemonJson is {"registry-mirrors":["https://weaver.slne.dev"]}`; `mirror: push null`.
  - router: `docker.images is NOT_FOUND for a private repo and anonymous caller`; `returns images for a reader`.
  - docs: existing `docs.test.ts` with the extended `PLAN`.
  - Playwright `browse-docker.spec.ts`: seeded hosted repo with a multi-arch image; open `/browse/<repo>`, click the image, see tags `1.0` and `latest`, platforms `linux/amd64` and `linux/arm64`, and the `docker pull` snippet.
- [ ] **Step 2:** Run `pnpm --filter @weaver/docker test -- browse` and `pnpm --filter web test` → FAIL.
- [ ] **Step 3:** Implement with existing `@weaver/ui` components and the proto browse view's layout.
- [ ] **Step 4:** Run `pnpm --filter web test && pnpm --filter web e2e -- browse-docker && pnpm build && pnpm typecheck && pnpm lint` → PASS.
- [ ] **Step 5: Commit** `feat(web): add docker browse view, client snippets and docs` (trailer).

### Task order and final verification

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Afterwards run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
and `scripts/e2e-smoke.sh` (proto unaffected); manually `curl -i http://localhost:3000/v2/` shows
`401` with `WWW-Authenticate: Bearer realm="http://localhost:3000/v2/token",service="localhost:3000"`.

### Client flows plan 6 must cover

- `docker login <host>` with an access token (success) and a wrong token (fails with "unauthorized"); `docker logout`.
- `docker push`/`docker pull` of a multi-layer image to a hosted repo; re-push with all layers already present ("Layer already exists").
- Cross-repo mount: push the same base image to a second hosted repo (log shows "Mounted from").
- `docker buildx build --platform linux/amd64,linux/arm64 --push` (OCI index) and pulling each platform; `podman push/pull` with `--tls-verify` as in CI; `crane`/`skopeo copy` for chunked uploads if available.
- Anonymous pull from a public hosted repo; denied push without write (`denied: requested access to the resource is denied`); push to a group or mirror fails.
- Mirror pulls against a local stand-in registry (`registry:2` with token auth via a stub realm) with caching off and on; nightly: Docker Hub `nginx` and `library/nginx` via a dockerHub mirror, with and without `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN`.
- Root mirror: a Docker daemon with `registry-mirrors: ["https://<host>"]` running `docker pull nginx` through Weaver.
- Group read: pull through a group whose image lives in its second member.
- `helm push`/`helm pull oci://<host>/<repo>`; optional `cosign sign`/`verify` and `oras attach`/`oras discover` (referrers); containerd via `ctr`/`nerdctl pull` with credentials.
- Tag delete and manifest delete with `crane delete`/`regctl`, then a `docker:gc` run frees the blobs.

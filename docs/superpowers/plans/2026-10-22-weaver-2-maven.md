# Weaver Maven Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Maven repositories (hosted, mirror, group) at `<host>/maven/<repo>/` so stock `mvn` and Gradle
publish and resolve with no workarounds, plus a Maven browse view and a Maven docs page.

**Architecture:** A new workspace package `@weaver/maven` exports `createMavenHandler: FormatFactory`. It parses
the raw `rest` path into a typed `MavenPath`, authorizes against the repo, and dispatches to hosted, mirror or
group readers. Hosted content is stored as core assets with components `(groupId, artifactId, version)`;
`maven-metadata.xml` and missing checksums are generated on read and never stored. Mirrors go through the core
`MirrorEngine`; groups try members in order and merge metadata.

**Tech Stack:** TypeScript 6, `@weaver/core` (FormatDeps, AssetService, MirrorEngine, RepoService),
Drizzle ORM 0.45, `fast-xml-parser` 5.11.1 (parsing upstream metadata only), Vitest 5 with Testcontainers,
tRPC 11, React 19.

**Spec:** `docs/superpowers/specs/2026-10-22-weaver-design.md`
**Depends on:** `docs/superpowers/plans/2026-10-22-weaver-0-core.md` (all tasks) and runs after
`2026-10-22-weaver-1-proto.md`. Interfaces named below (`FormatDeps`, `FormatHandler`, `FormatFactory`, `Repo`,
`MavenHostedConfig`, `MirrorConfig`, `AssetService`, `AssetRow`, `ComponentRef`, `MirrorEngine`, `MirrorFetch`,
`UsageInput`, `canAccess`, `canReadThroughGroup`, `extractToken`, `StoreSet`, `BROWSE_VIEWS`, `RegistryError`,
`component`/`asset` tables) are the core plan's, used unchanged.

## Global Constraints

- Product name **Weaver**; identifiers `@weaver/*`, `WEAVER_*`, `x-weaver-*`, `weaver.json`, `dev.slne.weaver`, `@slne/weaver-cli`.
- Maven client base URL is `<host>/maven/<repo>/`; repo names are globally unique across formats.
- Groups are read-only; members are hosted or mirror repos of the same format. Read on a group grants read of everything served through it.
- Mirror caching is **disabled by default**; default metadata TTL **1800 s** (core `CacheConfig`).
- Maven hosted defaults `{ versionPolicy: "mixed", redeploy: false }`; snapshots are always overwritable.
- Storage reads and writes stream; no Maven artifact is buffered whole in memory (generated metadata and checksum bodies are small strings and exempt).
- Stock clients must work with no special flag or patched config (anti-goal "client quirks").
- Admin UI stays minimal; this plan adds no admin form fields (Maven hosted options are rendered by core Task 10).
- Commit messages: Conventional Commits in English, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Every exported function, type and component gets a doc comment saying what it does (repo convention).
- Pin new dependencies to exact versions, like the existing `package.json` files.

## Review Focus

1. **Non-preemptive client auth** — Maven Wagon/resolver and Gradle send the first PUT (and GETs on private repos) without credentials and only send them after a `401` carrying `WWW-Authenticate: Basic realm="Weaver"`. A `403` or a `401` without the header makes the build fail with no retry. Pinned in Task 3: `anonymous PUT to a public hosted repo gets 401 with Basic challenge`.
2. **`mvn deploy` uploads `maven-metadata.xml` and its checksums on every release** — with `redeploy: false` those PUTs must still succeed (201) or every second release of an artifact fails. Pinned in Task 4: `PUT of artifact-level maven-metadata.xml and .sha1 answer 201 in a redeploy-denied repo`.
3. **Generated metadata and its checksum must agree byte for byte** — `mvn -C` / Gradle verification fetch `maven-metadata.xml` and `.sha1` in separate requests; if `lastUpdated` came from the clock they would differ. Pinned in Task 4: `sha1 of GET maven-metadata.xml equals GET maven-metadata.xml.sha1`.
4. **Hostile or odd paths** — `..`, `%2e%2e`, `%2F` inside a segment, backslashes, empty segments must be rejected with 400 and nothing stored. Pinned in Task 1 parser tests and Task 4 `PUT with traversal path answers 400 and stores nothing`.
5. **A group with one dead mirror member** — metadata merge must still return the hosted members' versions, and a file present in a later member must still be served; only when no member answers and one failed is the answer 502. Pinned in Task 7: `metadata merge skips a member whose upstream is down`.

## Decisions

- **Metadata is generated, never stored.** Uploaded artifact- and version-level `maven-metadata.xml` (and their `.md5/.sha1/.sha256/.sha512`) are accepted with 201 and discarded. Exception: an uploaded `maven-metadata.xml` whose root has `<plugins>` and no `<versioning>` (Maven plugin group metadata) is stored as uploaded and served as-is.
- **Metadata sources:** artifact-level from `component` rows `(namespace = groupId, name = artifactId)`; version-level (directory ending `-SNAPSHOT`) from the assets in that directory. `lastUpdated` is the max `updatedAt` of the rows used, formatted UTC `yyyyMMddHHmmss`, so repeated reads are identical. Root element `<metadata modelVersion="1.1.0">`.
- **Version order** is Maven `ComparableVersion` semantics (subset in Task 1). `latest` = highest version, `release` = highest non-SNAPSHOT version, `versions` ascending.
- **Status codes:** PUT success 201 empty body; version-policy violation 400; release redeploy denied 409; PUT/DELETE/other on mirror or group 405 with `Allow: GET, HEAD`; methods other than GET/HEAD/PUT on hosted 405 with `Allow: GET, HEAD, PUT`; bad path 400; missing 404; upstream down 502. Error bodies are `text/plain` one-liners. The method check runs before auth.
- **Unknown repo or a non-maven repo** under `/maven/` → 404 for everyone. `/maven/<repo>` without trailing slash → 308 to `/maven/<repo>/`.
- **Checksums:** an uploaded checksum asset is served as uploaded, never verified. Missing ones are the lowercase hex digest from the asset row (no filename, no newline). Checksums of checksums and of `.asc` → 404 unless uploaded.
- **Non-unique snapshot request** (`a-1.0-SNAPSHOT.jar`) with no exact asset serves the newest timestamped file with the same classifier and extension (hosted only).
- **Files are linked to components** (every file in a version directory, including checksums and `.asc`). Usage `download` is recorded only for GETs of files that are not checksums, signatures or metadata; `upload` for PUTs of those same files.
- **Paths outside the standard layout** (fewer than 4 segments, or a filename not starting with `<artifactId>-<version>`, e.g. `archetype-catalog.xml`) are `other`: stored and served as-is in hosted repos, always overwritable, no component, no policy check.
- **Mirror rule subject:** `groupId:artifactId` for files and metadata; for `other` the path with `/` replaced by `.`. Content class `metadata` for `maven-metadata.xml`, its checksums, `other` paths and everything inside a `-SNAPSHOT` directory; `immutable` otherwise. A mirror checksum that upstream answers 404 for is generated from the cached file's asset if one exists.
- **Directory listings** (GET on a path ending `/`) list stored assets only: hosted content, mirror cache, and for groups the union of members' stored assets (first member wins on name clash). No Range support; `Last-Modified` from `asset.updatedAt` and `ETag: "<sha1>"` on file responses.
- **Group version-level snapshot metadata:** the member document with the greatest `lastUpdated` wins (no merge). Group plugin metadata: union of `<plugin>` entries by `prefix`, earlier member wins.
- **No upload size cap** beyond storage; `Content-Length` is passed to `assets.put` as `contentLength` when present.
- **No schema change**: Maven uses core `component`/`asset` tables, so this plan generates no migration.
- **Browse for groups** shows the ordered member list linking to each member's browse page; mirrors with caching off show "This mirror does not cache; its content lives upstream."

---

### Task 1: Package scaffold, path parsing and version order

**Files:**
- Create: `packages/maven/package.json`, `packages/maven/tsconfig.json`, `packages/maven/tsconfig.build.json`, `packages/maven/eslint.config.js`, `packages/maven/vitest.config.ts` (copies of `packages/core`'s, name `@weaver/maven`, deps `@weaver/core`, `@weaver/db`, `drizzle-orm` 0.45.4, `fast-xml-parser` 5.11.1; devDeps as core plus `@testcontainers/postgresql` 12.2.1; `tsconfig.build.json` excludes `src/**/*.test.ts` and `src/testing/**`)
- Create: `packages/maven/src/index.ts`, `packages/maven/src/path.ts`, `packages/maven/src/version.ts`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)
- Test: `packages/maven/src/path.test.ts`, `packages/maven/src/version.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ChecksumAlgo = "md5" | "sha1" | "sha256" | "sha512";
  const CHECKSUM_ALGOS: readonly ChecksumAlgo[]; // ["md5","sha1","sha256","sha512"]
  interface SnapshotStamp { timestamp: string /* yyyyMMdd.HHmmss */; buildNumber: number }
  interface MavenFile {
    type: "file"; path: string; basePath: string; // basePath = path without checksum suffix
    groupId: string; artifactId: string; version: string; // version as in the directory, e.g. "1.0-SNAPSHOT"
    snapshot: boolean; stamp: SnapshotStamp | null; classifier: string | null;
    extension: string;                 // "jar", "pom", "module", "jar.asc", "tar.gz"
    checksum: ChecksumAlgo | null; signature: boolean;
  }
  type MavenPath =
    | { type: "directory"; path: string }                                   // "" or ends with "/"
    | { type: "metadata"; path: string; basePath: string; dir: string; checksum: ChecksumAlgo | null } // dir without trailing "/"
    | MavenFile
    | { type: "other"; path: string; basePath: string; checksum: ChecksumAlgo | null };
  /** Splits raw `rest` into the repo name and a decoded, validated target; throws RegistryError("invalid_request"). `target` null = bare repo name without slash. */
  function parseMavenPath(rest: string): { repo: string; target: MavenPath | null };
  /** Maven ComparableVersion order; negative, 0 or positive. */
  function compareMavenVersions(a: string, b: string): number;
  function isSnapshotVersion(version: string): boolean; // endsWith("-SNAPSHOT")
  /** Rule subject for mirrors: "groupId:artifactId", or path with "/"→"." for other/directories. */
  function mirrorSubject(p: MavenPath): string;
  ```
- `index.ts` re-exports these plus (later tasks) `createMavenHandler`.

- [ ] **Step 1: Write failing tests** in `path.test.ts`:
  - `parses a release jar`: `parseMavenPath("releases/org/example/lib/1.2.0/lib-1.2.0.jar")` → `{repo:"releases", target:{type:"file", groupId:"org.example", artifactId:"lib", version:"1.2.0", snapshot:false, stamp:null, classifier:null, extension:"jar", checksum:null, signature:false, path:"org/example/lib/1.2.0/lib-1.2.0.jar"}}`.
  - `parses classifier and compound extension`: `lib-1.2.0-sources.jar` → classifier `"sources"`, ext `"jar"`; `lib-1.2.0.tar.gz` → ext `"tar.gz"`; `lib-1.2.0.jar.asc` → ext `"jar.asc"`, `signature:true`.
  - `parses a timestamped snapshot`: `.../lib/1.0-SNAPSHOT/lib-1.0-20261022.101010-3-sources.jar` → `snapshot:true`, `stamp:{timestamp:"20261022.101010", buildNumber:3}`, classifier `"sources"`.
  - `parses a checksum of a file`: `.../lib-1.2.0.pom.sha256` → `checksum:"sha256"`, `basePath` ends with `lib-1.2.0.pom`, ext `"pom"`.
  - `parses metadata at artifact and snapshot level`: `org/example/lib/maven-metadata.xml.sha1` → `{type:"metadata", dir:"org/example/lib", checksum:"sha1"}`.
  - `directories`: `"releases/"` → `{type:"directory", path:""}`; `"releases/org/"` → `path:"org/"`; `"releases"` → `target:null`.
  - `other paths`: `releases/archetype-catalog.xml` → `type:"other"`; `releases/org/x/1.0/README.txt` → `type:"other"`.
  - `rejects traversal and odd segments` — each of `r/../x`, `r/%2e%2e/x`, `r/a%2Fb/c`, `r/a\\b`, `r//a`, `r/a/%00` throws with `code === "invalid_request"`.
  - `mirrorSubject`: file → `"org.example:lib"`; artifact metadata `org/example/lib/maven-metadata.xml` → `"org.example:lib"`; snapshot metadata `org/example/lib/1.0-SNAPSHOT/maven-metadata.xml` → `"org.example:lib"`; other `archetype-catalog.xml` → `"archetype-catalog.xml"`.
  In `version.test.ts`: `sorted ascending` — `["1.0","1.0-SNAPSHOT","1.0-rc1","1.0-alpha-1","1.10","1.9","1.0-sp1","1.0-beta","1.0.1"].sort(compareMavenVersions)` equals `["1.0-alpha-1","1.0-beta","1.0-rc1","1.0-SNAPSHOT","1.0","1.0-sp1","1.0.1","1.9","1.10"]`; `compareMavenVersions("1.0.0","1") === 0`; `compareMavenVersions("1.0-RC1","1.0-cr1") === 0`.
- [ ] **Step 2:** Run `pnpm install && pnpm --filter @weaver/maven test` → FAIL (modules missing).
- [ ] **Step 3: Implement** `path.ts` and `version.ts`. Decode each segment with `decodeURIComponent` after splitting on `/`; reject `""` (except a trailing one), `.`, `..`, and decoded segments containing `/`, `\`, or `\0`. A file is `MavenFile` when there are ≥4 segments and the filename starts with `<artifactId>-<version>` or, for snapshots, `<artifactId>-<base>-<yyyyMMdd.HHmmss>-<n>` (`base` = version without `-SNAPSHOT`); the remainder is `[-classifier].extension` with the extension being everything after the first `.`. Version order: tokenize on `.`, `-` and digit/letter transitions, compare numbers numerically and qualifiers by `alpha|a < beta|b < milestone|m < rc|cr < snapshot < "" = ga = final = release < sp`, unknown qualifiers lexically after `sp`; trailing zero/empty tokens are trimmed.
- [ ] **Step 4:** Run `pnpm --filter @weaver/maven test && pnpm --filter @weaver/maven typecheck` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add packages/maven pnpm-lock.yaml
  git commit -m "feat(maven): add maven path parsing and version ordering" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
  ```

### Task 2: maven-metadata.xml rendering, parsing and merging

**Files:**
- Create: `packages/maven/src/metadata.ts`
- Test: `packages/maven/src/metadata.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ArtifactMetadata { groupId: string; artifactId: string; versions: string[]; lastUpdated: string /* yyyyMMddHHmmss */ }
  interface SnapshotVersionEntry { classifier: string | null; extension: string; value: string; updated: string }
  interface SnapshotMetadata { groupId: string; artifactId: string; version: string; latest: SnapshotStamp | null; snapshotVersions: SnapshotVersionEntry[]; lastUpdated: string }
  interface PluginEntry { name: string | null; prefix: string; artifactId: string }
  type ParsedMetadata = { kind: "artifact"; value: ArtifactMetadata } | { kind: "snapshot"; value: SnapshotMetadata } | { kind: "plugins"; plugins: PluginEntry[] };
  function renderArtifactMetadata(m: ArtifactMetadata): string;   // computes latest/release from versions
  function renderSnapshotMetadata(m: SnapshotMetadata): string;
  function renderPluginMetadata(plugins: PluginEntry[]): string;
  function parseMetadata(xml: string): ParsedMetadata | null;    // null when not valid maven metadata
  function mergeArtifactMetadata(docs: ArtifactMetadata[]): ArtifactMetadata; // union, ascending, max lastUpdated
  function formatMavenTimestamp(d: Date): string;                  // UTC yyyyMMddHHmmss
  ```

- [ ] **Step 1: Write failing tests:**
  - `renders artifact metadata exactly` — for `{groupId:"org.example", artifactId:"lib", versions:["1.0","1.1-SNAPSHOT","1.0.1"], lastUpdated:"20261022101010"}` the output equals the fixed string: XML declaration `<?xml version="1.0" encoding="UTF-8"?>`, `<metadata modelVersion="1.1.0">`, `<groupId>`, `<artifactId>`, `<versioning>` with `<latest>1.1-SNAPSHOT</latest>`, `<release>1.0.1</release>`, `<versions>` in order `1.0, 1.0.1, 1.1-SNAPSHOT`, `<lastUpdated>20261022101010</lastUpdated>`, two-space indentation, trailing newline. Omit `<release>` when there is no release version.
  - `renders snapshot metadata` — `<version>1.0-SNAPSHOT</version>`, `<snapshot><timestamp>20261022.101010</timestamp><buildNumber>3</buildNumber></snapshot>`, one `<snapshotVersion>` per entry with `<classifier>` only when non-null, `<extension>`, `<value>1.0-20261022.101010-3</value>`, `<updated>`.
  - `round trip` — `parseMetadata(renderArtifactMetadata(m))` deep-equals `{kind:"artifact", value:m-with-sorted-versions}`; same for snapshot and plugins.
  - `parses Maven Central style metadata without modelVersion and with a single version element`.
  - `returns null for non-metadata XML and for garbage` (`"<html/>"`, `"not xml"`).
  - `merge unions and recomputes` — merging `["1.0","2.0"]@20260101000000` and `["1.5","2.0","3.0-SNAPSHOT"]@20260201000000` gives versions `["1.0","1.5","2.0","3.0-SNAPSHOT"]`, lastUpdated `20260201000000`; rendered `<release>2.0</release>`, `<latest>3.0-SNAPSHOT</latest>`.
  - `escapes XML special characters in ids`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/maven test -- metadata` → FAIL.
- [ ] **Step 3: Implement**: render with a small string builder (escape `& < > " '`); parse with `fast-xml-parser` `XMLParser({ isArray: (name) => ["version","snapshotVersion","plugin"].includes(name), parseTagValue: false })`.
- [ ] **Step 4:** Run `pnpm --filter @weaver/maven test` → PASS.
- [ ] **Step 5: Commit** `feat(maven): render, parse and merge maven-metadata.xml` (with the Co-Authored-By trailer).

### Task 3: Handler skeleton, test fixture and authorization

**Files:**
- Create: `packages/maven/src/handler.ts`, `packages/maven/src/http.ts`, `packages/maven/src/context.ts`
- Create: `packages/maven/src/testing/fixture.ts`, `packages/maven/src/testing/upstream.ts`
- Modify: `packages/maven/src/index.ts`
- Test: `packages/maven/src/handler.test.ts`

**Interfaces:**
- Consumes: `FormatFactory`, `FormatDeps`, `extractToken`, `canAccess`, `canReadThroughGroup`, `RepoService.get`, `RegistryError`, `startTestDb`, `createStoreSetFromEnv`, `createRepoService`, `createAssetService`, `createMirrorEngine`, `deriveSecretKey`, `recordUsage`, `getSettings`.
- Produces:
  ```ts
  // context.ts
  interface MavenContext { deps: FormatDeps; principal: Principal; method: "GET" | "HEAD" }
  // http.ts
  function textResponse(status: number, message: string, headers?: Record<string, string>): Response;
  function unauthorized(): Response;      // 401, WWW-Authenticate: Basic realm="Weaver"
  function methodNotAllowed(allow: string): Response;
  function assetResponse(asset: AssetRow, body: ReadableStream<Uint8Array> | null): Response; // content-type, content-length, last-modified, etag
  function contentTypeFor(path: string): string; // .jar application/java-archive, .pom/.xml application/xml, .module application/json, .asc/.md5/.sha1/.sha256/.sha512 text/plain, else application/octet-stream
  // handler.ts
  const createMavenHandler: FormatFactory;
  // testing/fixture.ts (tests only)
  interface MavenFixture {
    deps: FormatDeps; handler: FormatHandler; repos: RepoService; admin: Principal;
    /** Registers a token resolving to an apikey principal with these grants; returns the token. */
    token(grants: Array<{ repo: string; access: Access }>, role?: Role): Promise<string>;
    request(method: string, path: string /* after /maven/ */, init?: { body?: string | Buffer; token?: string; basic?: boolean }): Promise<Response>;
    createRepo(input: CreateRepoInput): Promise<Repo>;
    stop(): Promise<void>;
  }
  function startMavenFixture(): Promise<MavenFixture>;
  // testing/upstream.ts
  interface StubUpstream { url: string; files: Map<string, string | Buffer>; hits: string[]; down: boolean; close(): Promise<void> }
  function startStubUpstream(files?: Record<string, string | Buffer>): Promise<StubUpstream>; // 503 while down
  ```
- Dispatch in `createMavenHandler`: parse → repo lookup (`format !== "maven"` → 404) → `target === null` → 308 → method check → principal (`deps.principal` throwing `unauthorized` → `unauthorized()`) → access check → `readHosted`/`writeHosted` (Task 4), `readMirror` (Task 6), `readGroup` (Task 7), `listDirectory` (Task 5). Until those tasks land, readers are stubs returning 404. `RegistryError` maps to `textResponse(err.status, err.message)`.
- Access: read allowed when `repo.visibility === "public"`, or for groups `canReadThroughGroup(p, repo)`, else `canAccess(p, repo, "", "read")`; write needs `canAccess(p, repo, "", "write")`. Denied + anonymous → `unauthorized()`; denied + authenticated → 403 `"Forbidden"`.
- Fixture: local store in a tmp dir (`STORAGE_DRIVER=local`), admin user row inserted, principal resolver maps `extractToken` result through the `token()` registry (unknown non-null token → `RegistryError("unauthorized")`), `usage` = `recordUsage(db, …)`, `publicUrl = "http://weaver.test"`. `basic: true` sends `Authorization: Basic base64("token:<t>")`.

- [ ] **Step 1: Write failing tests** in `handler.test.ts`:
  - `unknown repo answers 404`; `npm repo under /maven answers 404`.
  - `bare repo name redirects`: `GET releases` → 308, `location` `http://weaver.test/maven/releases/`.
  - `anonymous GET on a private repo gets 401 with Basic challenge` — `www-authenticate === 'Basic realm="Weaver"'`.
  - `anonymous PUT to a public hosted repo gets 401 with Basic challenge`.
  - `token without grant gets 403 on GET and PUT`; `read token gets 403 on PUT`.
  - `invalid token gets 401 even on a public repo`.
  - `Basic and Bearer tokens are both accepted` (stub reader 404 instead of 401/403 proves authorization passed).
  - `PUT to a group or mirror answers 405 with Allow: GET, HEAD`; `DELETE on hosted answers 405 with Allow: GET, HEAD, PUT`.
  - `group read token reads the group` (404 from stub, not 401/403).
- [ ] **Step 2:** Run `pnpm --filter @weaver/maven test -- handler` → FAIL.
- [ ] **Step 3:** Implement the files above.
- [ ] **Step 4:** Run `pnpm --filter @weaver/maven test` → PASS.
- [ ] **Step 5: Commit** `feat(maven): add maven handler with basic challenge authorization` (with trailer).

### Task 4: Hosted deploy and read

**Files:**
- Create: `packages/maven/src/hosted.ts`, `packages/maven/src/checksum.ts`, `packages/maven/src/generate.ts`
- Modify: `packages/maven/src/handler.ts` (wire hosted)
- Test: `packages/maven/src/hosted.test.ts`

**Interfaces:**
- Consumes: Task 1 `MavenPath`, Task 2 renderers, Task 3 `MavenContext`/http helpers, `AssetService.{find,list,put,open,touch}`, `component` table, `MavenHostedConfig`.
- Produces:
  ```ts
  // hosted.ts
  function writeHosted(ctx: MavenContext, repo: Repo, target: MavenPath, req: Request): Promise<Response>;
  /** null = not found here (lets groups continue). */
  function readHosted(ctx: MavenContext, repo: Repo, target: Exclude<MavenPath, { type: "directory" }>): Promise<Response | null>;
  // generate.ts
  /** Generated (or stored plugin) metadata XML for a hosted repo directory, or null. */
  function hostedMetadataXml(deps: FormatDeps, repo: Repo, dir: string): Promise<string | null>;
  // checksum.ts
  function digestOf(asset: AssetRow, algo: ChecksumAlgo): string;
  function checksumText(text: string, algo: ChecksumAlgo): string; // node:crypto over UTF-8 bytes
  ```
- PUT rules (in order): `directory` → 400; `metadata` → read the body (cap 1 MiB, else 413): store via `assets.put` only when `parseMetadata` says `plugins`; else drain and discard; metadata checksums always discarded; 201. `file`: `versionPolicy === "release"` and snapshot → 400 `"Repository <name> does not accept SNAPSHOT versions"`; `"snapshot"` and release → 400 `"Repository <name> only accepts SNAPSHOT versions"`; release, `redeploy === false` and `assets.find(repo.id, path)` exists → 409 `"<path> already exists and redeploy is disabled for <name>"`; then `assets.put({ origin: "hosted", component: { namespace: groupId, name: artifactId, version }, contentType: contentTypeFor(path), contentLength, signal: req.signal, body: Readable.fromWeb(req.body) })` → 201. `other` → put without component, 201. Uploads of non-checksum, non-signature files call `deps.usage({ action: "upload", bytes: size, … })`.
- GET/HEAD rules: stored asset at `path` → stream it (HEAD: no body), `touch`, usage `download` for non-checksum/signature/metadata files. Else checksum → base asset digest, or for metadata the checksum of the generated XML. Else metadata → `hostedMetadataXml`. Else non-unique snapshot fallback (Decisions). Else `null`.
- `hostedMetadataXml`: stored plugin metadata asset at `<dir>/maven-metadata.xml` if any; else if `dir` ends `-SNAPSHOT`, snapshot metadata from `assets.list(repo.id, dir + "/")` timestamped files (entries per `(classifier, extension)` with the highest build, excluding checksums; `latest` = highest stamp; `lastUpdated` = max asset `updatedAt`); else artifact metadata from `component` rows with `namespace = dir without last segment, "/"→"."` and `name = last segment`; null when nothing found.

- [ ] **Step 1: Write failing tests** in `hosted.test.ts` (fixture repos `releases` `{versionPolicy:"release", redeploy:false}`, `snapshots` `{versionPolicy:"snapshot"}`, `mixed` default, writer token):
  - `deploys and reads back a jar`: PUT `lib-1.2.0.jar` → 201; GET → 200, same bytes, `content-type: application/java-archive`, `etag` = `"<sha1>"`; HEAD → 200, `content-length` equals size, empty body.
  - `creates a component org.example:lib:1.2.0` (query `component` table) and `GET counts one download` (`downloadCount === 1` after one GET of the jar, still 1 after GET of its `.sha1`).
  - `serves uploaded checksum as uploaded`: PUT `lib-1.2.0.jar.sha1` with body `"deadbeef"` → GET returns `"deadbeef"`.
  - `generates missing checksums`: for each of md5/sha1/sha256/sha512, GET `lib-1.2.0.pom.<algo>` equals `createHash(algo).update(pomBytes).digest("hex")`.
  - `release redeploy denied`: second PUT of `lib-1.2.0.jar` → 409; with `redeploy: true` (updated repo) → 201 and new content served.
  - `PUT of artifact-level maven-metadata.xml and .sha1 answer 201 in a redeploy-denied repo` (twice in a row), and the stored asset count does not change.
  - `version policy`: SNAPSHOT into `releases` → 400; `1.0` into `snapshots` → 400; both into `mixed` → 201.
  - `snapshots are overwritable`: PUT the same timestamped snapshot file twice → 201 both.
  - `artifact metadata lists versions`: after deploying 1.0, 1.10, 1.9 and 2.0-SNAPSHOT, GET `org/example/lib/maven-metadata.xml` parses to versions `["1.0","1.9","1.10","2.0-SNAPSHOT"]`, `<release>1.10</release>`, `<latest>2.0-SNAPSHOT</latest>`.
  - `sha1 of GET maven-metadata.xml equals GET maven-metadata.xml.sha1` (two separate requests, with `vi.setSystemTime` advanced 5 s between them).
  - `snapshot metadata`: deploy builds 1 and 2 of `lib-1.0-<ts>-N.jar`, `.pom` and `-sources.jar`; `org/example/lib/1.0-SNAPSHOT/maven-metadata.xml` has `<buildNumber>2</buildNumber>` and three `snapshotVersion` entries all with build 2 values.
  - `non-unique snapshot name serves newest build`: GET `lib-1.0-SNAPSHOT.jar` returns build 2 bytes.
  - `.asc and .module stored as-is`: PUT then GET returns identical bytes; `.module` has `content-type: application/json`.
  - `plugin group metadata is stored`: PUT `org/example/maven-metadata.xml` with a `<plugins>` document → GET returns those exact bytes.
  - `PUT with traversal path answers 400 and stores nothing` (`org/%2e%2e/x/1/x-1.jar`), asset count 0.
  - `missing file answers 404`.
- [ ] **Step 2:** Run `pnpm --filter @weaver/maven test -- hosted` → FAIL.
- [ ] **Step 3:** Implement `hosted.ts`, `generate.ts`, `checksum.ts`; wire into the handler.
- [ ] **Step 4:** Run `pnpm --filter @weaver/maven test` → PASS.
- [ ] **Step 5: Commit** `feat(maven): deploy and serve hosted maven repositories with generated metadata` (with trailer).

### Task 5: Directory listings

**Files:**
- Create: `packages/maven/src/listing.ts`
- Modify: `packages/maven/src/handler.ts`
- Test: `packages/maven/src/listing.test.ts`

**Interfaces:**
- Consumes: `AssetService.list`, `RepoService.members`.
- Produces:
  ```ts
  interface ListingEntry { name: string; directory: boolean; size: number | null; updatedAt: Date | null }
  /** Immediate children of `prefix` across the given repos' stored assets; first repo wins on clash; directories first, then by name. */
  function listEntries(deps: FormatDeps, repoIds: string[], prefix: string): Promise<ListingEntry[]>;
  function renderListing(repoName: string, prefix: string, entries: ListingEntry[]): string; // HTML
  function listDirectory(ctx: MavenContext, repo: Repo, prefix: string): Promise<Response>;
  ```
- HTML: `<!doctype html>`, `<title>Weaver: <repo>/<prefix></title>`, `<h1>`, a `<pre>` with `<a href="../">../</a>` (omitted at root) and one relative `<a href>` per entry (directories end `/`, hrefs percent-encoded per segment, text HTML-escaped), size and ISO time. `content-type: text/html; charset=utf-8`. An empty non-root prefix → 404. Groups list over `members(repo.id)` ids in order.

- [ ] **Step 1: Write failing tests:** `root lists top-level directories` (`org/` for deployed `org/example/...`); `lists files with sizes in a version directory`; `escapes names` (an `other` file named `a<b>.txt` renders `a&lt;b&gt;.txt` and href `a%3Cb%3E.txt`); `unknown directory answers 404`; `group lists the union of members, first member wins`; `mirror lists only cached assets` (cache disabled → root listing has no entries but answers 200).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm --filter @weaver/maven test` → PASS.
- [ ] **Step 5: Commit** `feat(maven): serve html directory listings` (with trailer).

### Task 6: Mirror repositories

**Files:**
- Create: `packages/maven/src/mirror.ts`
- Modify: `packages/maven/src/handler.ts`
- Test: `packages/maven/src/mirror.test.ts` (uses `startStubUpstream`)

**Interfaces:**
- Consumes: `MirrorEngine.fetch(MirrorFetch)`, `MirrorResponse`, `AssetService.find`, Task 1 `mirrorSubject`, Task 4 `digestOf`.
- Produces:
  ```ts
  function contentClassFor(target: Exclude<MavenPath, { type: "directory" }>): ContentClass;
  function readMirror(ctx: MavenContext, repo: Repo, target: Exclude<MavenPath, { type: "directory" }>): Promise<Response | null>;
  /** Upstream (or cached) metadata XML for a mirror directory, or null; throws RegistryError("upstream_unavailable"). */
  function mirrorMetadataXml(ctx: MavenContext, repo: Repo, dir: string): Promise<string | null>;
  ```
- `readMirror` calls `deps.mirror.fetch({ repo, path: target.path, subject: mirrorSubject(target), class, method: ctx.method, component })` (`component` for `file` targets). The response keeps status, `content-type`, `content-length`, `last-modified`, `etag` only. Null + checksum target → `assets.find(repo.id, basePath)` and serve `digestOf`; else null. Usage `download` with `cache: res.cache` for counted files.

- [ ] **Step 1: Write failing tests:**
  - `contentClassFor`: release jar → `immutable`; snapshot jar, `maven-metadata.xml`, `maven-metadata.xml.sha1`, `archetype-catalog.xml` → `metadata`.
  - `proxies a release jar with caching off` — body equals upstream, `hits` has one entry, `asset` table empty.
  - `caching on serves the second request from cache` — upstream hit once for two GETs.
  - `deny rule answers 404 without contacting upstream` — rules `{allow:[], deny:["com.evil.*"]}`, GET `com/evil/x/1/x-1.jar` → 404, `hits` empty.
  - `generates a checksum the upstream lacks from the cached file` — cache on, upstream has `x-1.jar` but not `x-1.jar.sha1`.
  - `upstream down without cache answers 502`.
  - `records download with cache result` — `usage_event.cache` is `"miss"` then `"hit"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm --filter @weaver/maven test` → PASS.
- [ ] **Step 5: Commit** `feat(maven): proxy maven mirrors through the mirror engine` (with trailer).

### Task 7: Group repositories

**Files:**
- Create: `packages/maven/src/group.ts`
- Modify: `packages/maven/src/handler.ts`
- Test: `packages/maven/src/group.test.ts`

**Interfaces:**
- Consumes: `RepoService.members`, Task 4 `readHosted`/`hostedMetadataXml`, Task 6 `readMirror`/`mirrorMetadataXml`, Task 2 `parseMetadata`/`mergeArtifactMetadata`/renderers, Task 4 `checksumText`.
- Produces:
  ```ts
  function readGroup(ctx: MavenContext, group: Repo, target: Exclude<MavenPath, { type: "directory" }>): Promise<Response | null>;
  /** Merged metadata XML across members, or null when no member has any. */
  function groupMetadataXml(ctx: MavenContext, group: Repo, dir: string): Promise<string | null>;
  ```
- Non-metadata targets: members in order, first non-null response wins; a member throwing `upstream_unavailable` is skipped and remembered; none found → rethrow if any failed, else null. Metadata targets: collect every member's XML (failing members skipped and logged with prefix `weaver:`; all failing → `upstream_unavailable`), parse, drop unparsable, then: all `artifact` → `renderArtifactMetadata(mergeArtifactMetadata(...))`; `snapshot` → greatest `lastUpdated` rendered as-is; `plugins` → union by prefix, earlier wins. Checksums of group metadata are `checksumText` over the merged XML. The read principal for members is the caller (read-through already authorized at group level; members are not re-checked).

- [ ] **Step 1: Write failing tests** (group over hosted `a`, hosted `b`, mirror `m` on a stub upstream):
  - `first member wins`: same path in `a` and `b` with different bytes → `a`'s bytes.
  - `falls through to later members`: file only in `m`'s upstream is served.
  - `merges artifact metadata`: `a` has 1.0, `b` has 2.0, upstream has 1.5 → versions `["1.0","1.5","2.0"]`, `<release>2.0</release>`; `.sha1` of the merged document equals `checksumText(body, "sha1")`.
  - `metadata merge skips a member whose upstream is down` — `upstream.down = true` → 200 with `["1.0","2.0"]`.
  - `file only in a dead mirror answers 502`; `file in no member answers 404`.
  - `a private member is readable through a group token` — token with read on the group only reads a file from private hosted `a`.
  - `group token cannot PUT` → 405.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm --filter @weaver/maven test && pnpm --filter @weaver/maven lint && pnpm --filter @weaver/maven typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(maven): serve maven groups with merged metadata` (with trailer).

### Task 8: Mount the Maven handler in the web app

**Files:**
- Modify: `apps/web/package.json` (`"@weaver/maven": "workspace:*"`), `apps/web/src/server/formats.ts` (import `createMavenHandler`, replace the maven placeholder), `pnpm-lock.yaml`
- No `docker/Dockerfile` change: `turbo prune web @weaver/worker --docker` follows the new `web → @weaver/maven` dependency.
- Test: `apps/web/src/server/formats.test.ts`

**Interfaces:**
- Consumes: core Task 8 `getFormatHandler("maven")` map, `createMavenHandler`.

- [ ] **Step 1: Write failing test:** `maven mount is served by the maven handler` — `getFormatHandler("maven")` called with `GET /maven/does-not-exist/x` returns 404 `text/plain` (not 501); switch the existing placeholder test to `"npm"` if it used `"maven"`.
- [ ] **Step 2:** Run `pnpm --filter web test -- formats` → FAIL.
- [ ] **Step 3:** Wire the import and map entry; `pnpm install`.
- [ ] **Step 4:** Run `pnpm --filter web test && pnpm build` → PASS; then with the dev stack up (`pnpm dev`), `curl -i http://localhost:3000/maven/nope/` → `HTTP/1.1 404`.
- [ ] **Step 5: Commit** `feat(web): mount the maven protocol handler` (with trailer).

### Task 9: Maven browse view and client snippets

**Files:**
- Create: `apps/web/src/server/trpc/routers/maven.ts`, `apps/web/src/lib/maven-snippets.ts`, `apps/web/src/components/browse/maven-view.tsx`
- Modify: `apps/web/src/server/trpc/root.ts` (register `maven`), `apps/web/src/components/browse/registry.tsx` (add `maven` entry)
- Test: `apps/web/src/lib/maven-snippets.test.ts`, `apps/web/src/server/trpc/routers.test.ts` (new `describe("maven")`)

**Interfaces:**
- Consumes: `browseProcedure`, `requireBrowsableRepository` (as adapted by core Task 10), `component`/`asset` tables, `RepoService.members`, `compareMavenVersions`/`isSnapshotVersion` from `@weaver/maven`, `CodeBlock`, `BROWSE_VIEWS`.
- Produces:
  ```ts
  // routers/maven.ts — all browseProcedure queries, input { repository: string, ... }
  maven.overview({ repository }) → { kind: Kind; members: string[]; cacheEnabled: boolean | null; versionPolicy: "release" | "snapshot" | "mixed" | null }
  maven.artifacts({ repository, groupPrefix?: string }) → Array<{ groupId: string; artifactId: string; latestVersion: string; versionCount: number; updatedAt: Date }> // ≤ 500, by groupId, artifactId
  maven.versions({ repository, groupId, artifactId }) → Array<{ version: string; snapshot: boolean; updatedAt: Date; downloadCount: number }> // newest first by compareMavenVersions
  maven.files({ repository, groupId, artifactId, version }) → Array<{ name: string; path: string; size: number; sha1: string; contentType: string | null; updatedAt: Date; url: string }>
  // lib/maven-snippets.ts
  interface MavenSnippetInput { url: string; repo: string; isPrivate: boolean; versionPolicy: "release" | "snapshot" | "mixed" | null; coordinate?: { groupId: string; artifactId: string; version: string } }
  function gradleRepositoryName(repo: string): string; // "weaver" + PascalCase of alphanumeric runs: "my-releases" → "weaverMyReleases"
  function mavenSettingsXml(i: MavenSnippetInput): string;   // <servers><server><id>weaver-<repo></id><username>token</username><password>${env.WEAVER_TOKEN}</password>
  function mavenPomSnippet(i: MavenSnippetInput): string;    // <repositories> (+ <distributionManagement> when versionPolicy !== null) (+ <dependency> when coordinate)
  function gradleKotlinSnippet(i: MavenSnippetInput): string;// repositories { maven("<url>/maven/<repo>/") { name = ...; credentials(PasswordCredentials::class) } } (+ publishing block when hosted, + implementation("g:a:v"))
  ```
- View: client component reading search params `g`, `a`, `v`; levels artifacts list (filter box over `groupPrefix`) → versions → files (download links to `url`, size, sha1, copy coordinate); snippet panel on every level via `CodeBlock` with titles `settings.xml`, `pom.xml`, `build.gradle.kts`. Groups render the member list linking `/browse/<member>`; mirrors with `cacheEnabled === false` show the Decisions note.

- [ ] **Step 1: Write failing tests:**
  - snippets: `gradleRepositoryName("my-releases") === "weaverMyReleases"`; `gradleKotlinSnippet({url:"https://weaver.slne.dev", repo:"releases", isPrivate:true, versionPolicy:"release"})` contains `maven("https://weaver.slne.dev/maven/releases/")`, `name = "weaverReleases"`, `credentials(PasswordCredentials::class)` and `publishing {`; public non-hosted (`versionPolicy:null, isPrivate:false`) contains no `credentials` and no `publishing`; `mavenSettingsXml` contains `<id>weaver-releases</id>` and `${env.WEAVER_TOKEN}`; `mavenPomSnippet` with `versionPolicy:"snapshot"` contains `<snapshotRepository>` and no `<repository>` inside `<distributionManagement>`, and with a coordinate contains `<artifactId>lib</artifactId>`.
  - router: `artifacts lists components of a hosted maven repo`; `versions sorted newest first` (`["1.10","1.9","1.0"]`); `files lists assets of a version with download urls` (`url === "<publicUrl>/maven/releases/org/example/lib/1.0/lib-1.0.jar"`); `anonymous cannot browse a private maven repo` (`UNAUTHORIZED`/`NOT_FOUND` as `requireBrowsableRepository` answers for proto); `overview of a group lists members in order`.
- [ ] **Step 2:** Run `pnpm --filter web test -- maven` → FAIL.
- [ ] **Step 3:** Implement router, snippets, view; register in `root.ts` and `registry.tsx`. Confirm `hosted-settings.tsx` from core Task 10 renders `versionPolicy` and `redeploy` for maven hosted repos; if it does not, add those two fields there in this step (select "Releases and snapshots" / "Releases only" / "Snapshots only"; checkbox "Allow redeploying releases").
- [ ] **Step 4:** Run `pnpm --filter web test && pnpm --filter web typecheck && pnpm --filter web lint` → PASS; with `pnpm dev`, deploy one jar via `curl -u token:<t> -T lib-1.0.jar http://localhost:3000/maven/releases/org/example/lib/1.0/lib-1.0.jar` and open `/browse/releases?g=org.example&a=lib&v=1.0` — the file row and three snippets render.
- [ ] **Step 5: Commit** `feat(web): add maven browse view with client snippets` (with trailer).

### Task 10: Maven docs page

**Files:**
- Create: `apps/web/content/docs/maven.md` (frontmatter `title: Maven and Gradle`, `description: Resolve and publish Maven artifacts with mvn and Gradle, use mirrors and groups, and fix 401, 403, 405 and 409 errors.`, `section: Clients`, `order: 5`)
- Modify: `apps/web/content/docs/index.md` (link to the new page where formats are listed)
- Test: existing `apps/web/src/lib/docs.test.ts` link check

- [ ] **Step 1:** Write the page with h2 sections: `Repository URLs` (`{{url}}/maven/<repo>/`, hosted/mirror/group meaning), `Access tokens` (settings.xml `<server>`, Gradle `weaver<Repo>Username`/`Password` in `~/.gradle/gradle.properties`, any username), `Resolve with Maven` (pom `<repositories>`, settings.xml `<mirror><mirrorOf>*</mirrorOf>` pointing at a group), `Resolve with Gradle`, `Publish with Maven` (`distributionManagement`, `mvn deploy`), `Publish with Gradle` (`maven-publish`, `signing` → `.asc` stored as uploaded, `.module` files), `Snapshots` (timestamped builds, always overwritable, version policy), `Checksums` (served when uploaded, generated otherwise), `Errors` (table: 401 no/invalid token, 403 token lacks access, 400 version policy, 405 publishing to a mirror or group, 409 release exists and redeploy is off, 502 upstream unavailable). All URLs use `{{url}}`/`{{host}}`.
- [ ] **Step 2:** Run `pnpm --filter web test -- docs` → PASS (no missing-link or frontmatter errors); `pnpm --filter web build` → PASS.
- [ ] **Step 3: Commit** `docs: add maven and gradle client guide` (with trailer).

### Task order and final check

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Then run `pnpm build && pnpm typecheck && pnpm lint && pnpm test` → all PASS, and `scripts/e2e-smoke.sh` (proto still works).

## Client flows plan 6 must cover

Real `mvn` (3.9.x, default settings, no extra flags) and Gradle (9.x, `maven-publish`) against a CI Weaver instance:

1. `mvn deploy` of a release to a private hosted repo with `settings.xml` credentials (exercises the 401 challenge on the first PUT), then `mvn dependency:get` of it with `-C` (strict checksums).
2. `mvn deploy` of the same SNAPSHOT twice; a consumer with `-U` resolves build 2 via version-level metadata.
3. Second `mvn deploy` of the same release with redeploy off fails with 409; a new release version of the same artifact succeeds (metadata uploads accepted).
4. Gradle `publish` with `signing` and Gradle module metadata; a second Gradle build resolves it, using the `.module` file, from a group.
5. Resolve through a mirror against a stand-in upstream container (cache off, cache on, offline on with a warm cache), and nightly against Maven Central (`https://repo.maven.apache.org/maven2/`).
6. Group over hosted + mirror as `<mirrorOf>*</mirrorOf>`: a build resolving both a hosted artifact and a Central artifact.
7. Denials: anonymous resolve from a private repo fails, a token without the repo gets 403, `mvn deploy` to a group URL fails with 405.

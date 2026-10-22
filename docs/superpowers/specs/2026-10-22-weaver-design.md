# Weaver: multi-format artifact repository

Status: approved · Date: 2026-10-22

## Intent

Protoloom is a self-hosted registry for `.proto` bundles. It becomes **Weaver**, a self-hosted artifact
repository in the spirit of Nexus and Reposilite that hosts **Maven, npm, Docker/OCI and proto**. It is
built for SLNE first and published as open source for anyone to self-host.

The existing codebase is evolved, not replaced: Next.js web app + REST/tRPC, BullMQ worker on Valkey,
PostgreSQL via Drizzle, blob storage on local disk or S3, GitHub/Discord OAuth via Better Auth, and the
current admin UI. The woven-grid logo stays; only the name changes.

## Goals

- One server, one admin UI, four formats: **maven**, **npm**, **docker** (OCI distribution), **proto**.
- Every format supports three repository kinds:
  - **hosted**: clients publish into it.
  - **mirror**: forwards reads to one or more upstreams (Reposilite-style), optionally caching.
  - **group**: one read URL in front of an ordered list of hosted and mirror repos of the same format.
- Stock clients work with no workarounds: `docker`/`podman`/`buildx`, `mvn`, Gradle, `npm`, `pnpm`,
  `yarn` (berry and classic), `bun`, and the Weaver Gradle plugin + CLI for proto.
- v1 extras: per-format browse UI, cleanup policies, cross-repo search, usage stats.

## Non-goals (v1)

- Formats beyond the four (PyPI, Go, Helm-as-HTTP-repo, etc.). Helm charts are covered only as OCI
  artifacts in docker repos.
- Buf Schema Registry protocol compatibility. Proto keeps its own format; Buf may come later.
- Clustering / HA. Weaver runs as a single web instance plus a worker, as today.
- Managing repos through config files or a public admin API. Repos are created and configured in the
  **admin UI only**.
- Pushing to group repos. Groups are **read-only**; publishing to a group URL is rejected with the
  format's native "method not allowed / denied" error.
- Migrating existing proto artifacts.

## Anti-goals (a failure even if every feature works)

- **Client quirks.** If any common client needs a special flag, a patched config, or a documented
  workaround to push or pull, that is a bug. Behaviour must match what each client expects from the
  reference registries (Maven Central/Nexus, registry.npmjs.org/Verdaccio, Docker Hub/distribution).
- **Nexus-style UI bloat.** The admin screens stay as clean as today's app: no forest of tabs and
  checkboxes. Format-specific options appear only for the format they apply to, with sane defaults so a
  new repo needs a name, a format and a kind and nothing else.

## Success for v1

Every format passes automated end-to-end tests with **real clients** in CI. Every CI run uses
**local stand-in upstreams** (containers); a separate nightly/manual workflow runs the same mirror tests
against **real upstreams** (Maven Central, registry.npmjs.org, Docker Hub via `auth.docker.io`, with
optional `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets). Tests cover (extending today's
`scripts/e2e-smoke.sh` approach): publish to hosted, pull through mirror (cache on and off), read
through group, and auth/permission denial. Migrating SLNE's own builds onto Weaver comes after v1.

## Constraints and decisions made

### Rename

- Product name **Weaver** everywhere: UI copy, docs, README, SECURITY.md, templates, npm scope of
  workspace packages, the CLI package and binary, the Gradle plugin id and extension, env vars
  (`PROTOLOOM_*` → `WEAVER_*`), HTTP headers (`x-protoloom-*` → `x-weaver-*`), queue names, error
  brands, the GHCR image, compose files, the GitHub repo, and the domain.
- Logo artwork is kept; SVG files are renamed and their `aria-label`/wordmark text changes to Weaver.
- Identifiers: domain `weaver.slne.dev`, GitHub repo `SLNE-Development/weaver`, image
  `ghcr.io/slne-development/weaver`, Gradle plugin id `dev.slne.weaver`, CLI npm package
  `@slne/weaver-cli` (binary `weaver`), CLI config file `weaver.json`.
- No compatibility aliases for old names: data is reset anyway and there are no outside consumers to
  protect.

### Data

- **Keep users only.** `user` and `account` rows (and therefore OAuth logins and roles) survive the
  upgrade. Everything else (repositories, artifacts, builds, API keys and their permissions, invites,
  cleanup policies, sessions) may be dropped. (Builder's call whether audit history and settings are
  kept.)
- The schema may change freely; a Drizzle migration drops the proto-specific tables and creates the
  new model.

### Repository model

- A repository has: unique name, **format**, **kind**, description, visibility (public = anonymous
  read allowed, private = token/session required), and format- and kind-specific config.
- Repo names are globally unique across formats (they appear in every URL).
- **Hosted, Maven:** a release/snapshot policy (releases only, snapshots only, or both), and a
  **redeploy policy** (allow or deny overwriting a released version; snapshots are always
  overwritable). Today's proto `allowRedeploy`, `allowReleases`, `allowSnapshots` and the
  deleted-release tombstone rule carry over to proto repos.
- **Mirror, all formats:**
  - an **ordered list of upstream URLs**, tried in order until one answers (Reposilite behaviour);
  - **optional credentials per upstream** (basic auth or bearer token), stored encrypted at rest;
  - **path allow/deny rules** (Maven groupId prefixes, npm scopes/package names, image namespaces,
    proto group prefixes): requests outside the rules are answered as "not found" without contacting
    upstream;
  - an **offline toggle**: when on, upstream is never contacted and only cached content is served;
  - **caching, disabled by default.**
- **Group:** ordered member list of same-format hosted/mirror repos. First member that has the
  requested item wins. Metadata that clients expect merged (Maven `maven-metadata.xml` version lists,
  npm packuments' versions and dist-tags) is merged across members; for dist-tag conflicts the
  earlier member wins.

### Mirror caching

- **Off (default):** Weaver proxies the request to upstream and streams the response to the client
  without writing it to storage. Responses that reference upstream URLs (npm packument tarball URLs,
  Docker auth challenges) are rewritten so the client keeps talking to Weaver.
- **On:** fetched content is stored and served from storage on later requests.
  - Immutable content (Maven release files, npm tarballs, Docker blobs and digest-addressed
    manifests, proto release archives) is cached until evicted.
  - Mutable metadata (`maven-metadata.xml`, snapshot files, npm packuments, Docker tag → digest
    lookups, proto version lists) is cached with a **metadata TTL**.
  - **Eviction per mirror:** a max age since last access and/or a max total size; least recently used
    content goes first. Eviction runs in the worker.
  - If upstream fails and a cached copy exists, the cached copy is served even if its TTL expired.
- **Cache location is chosen per mirror** (local disk or S3). New mirrors default to an app-wide
  **"default cache storage"** value under admin Settings. Both stores are configured **by env only**
  (my call): `STORAGE_LOCAL_PATH` and `S3_*` may both be set; `STORAGE_DRIVER` names the primary store
  used for hosted content. The settings and mirror forms only offer stores that are configured.

### URLs (my call, all on the one existing domain)

| Format | Client base URL |
| --- | --- |
| Docker | `<host>/<repo>/<image>:<tag>` (OCI API at `<host>/v2/<repo>/<image>/...`) |
| Maven | `<host>/maven/<repo>/` |
| npm | `<host>/npm/<repo>/` |
| proto | existing `<host>/api/v1/...` REST API with repo names in the path/body |

Docker uses a **path prefix**, not ports or subdomains: the first path segment after `/v2/` is the repo.
Docker Hub official images in a Docker Hub mirror are addressed as `<host>/<mirror>/library/nginx`;
the mirror also accepts `<host>/<mirror>/nginx` and maps it to `library/nginx`.

**Root Docker mirror (my call):** one Docker mirror can be marked **root** in the admin UI. Requests
to `/v2/<name>/...` whose first segment is not a Docker repo name are served by the root mirror with
the full path as the image name. This makes the Docker daemon's `registry-mirrors: ["https://<host>"]`
setting work, so a plain `docker pull nginx` or `FROM nginx` goes through Weaver without editing
Dockerfiles. Repo names that clash with common Docker Hub namespaces (`library` at least) are
reserved and cannot be used for Docker repos. Repo names are matched before falling through to root.

### Format behaviour

- **Maven:** standard layout, PUT/GET/HEAD. `maven-metadata.xml` is generated at artifact and
  version level for hosted repos, including timestamped SNAPSHOT builds. Checksums (`.md5`, `.sha1`,
  `.sha256`, `.sha512`) are served when uploaded and generated when missing. `.asc` signatures and
  Gradle `.module` files are stored and served as uploaded.
- **npm:** registry API for install and publish, scoped packages (`@scope/name`, including encoded
  `%2f`), `dist-tags` add/rm/ls, `deprecate`, `unpublish`, `npm login`/`whoami` via token. Works with
  npm, pnpm, yarn classic, yarn berry and bun. In mirrors, `/-/npm/v1/security/*` (audit) is forwarded
  upstream; in groups it is forwarded to the first mirror member; in hosted repos it returns "no
  advisories".
- **Docker / OCI:** OCI Distribution spec push and pull, including chunked and resumable blob uploads
  and cross-repo blob mount, multi-arch image indexes, and **OCI artifacts** (Helm charts, cosign
  signatures, SBOMs; the referrers API). Blobs are content-addressed and deduplicated per storage
  store. **Large layers (multi-GB) stream straight to storage** (S3 multipart or disk) without being
  held in memory. **Tag and manifest deletion** is supported, and a worker **garbage collection** job
  removes blobs no longer referenced by any manifest. The **Docker Hub mirror** handles Docker Hub's
  token auth against `auth.docker.io` itself, optionally with a Docker Hub account to lift rate limits.
- **Proto:** today's behaviour is ported unchanged in substance: coordinates, server-side transitive
  resolution with highest-version-wins, snapshots, buf validation on publish, the Gradle plugin and CLI.
  Proto gets mirror repos (the upstream is another Weaver instance's proto API) and groups (resolution
  across group members in order).
  - **Client resolution (my call):** the ordered `repositories` list sent by the plugin/CLI is the
    lookup order; entries may be hosted, mirror or group repos. The global search over all repos by
    `resolutionPriority` is removed for client resolution.
  - **Publish-time dependency check (my call):** dependencies of a published bundle must resolve in
    *local* proto repos (hosted, and groups over hosted) readable by the publisher, in the existing
    target-repo-first then `resolutionPriority` order. Publish never contacts a mirror upstream.

### Storage

- The blob layer must **stream** reads and writes and support HEAD/exists, byte ranges, and S3
  multipart. The current buffer-only `BlobStore` and the 10 MB archive cap apply only to proto bundles
  after this change; other formats have no small cap. Size limits per format are the builder's call,
  but they must handle multi-GB Docker layers and large Maven/npm artifacts.

### Auth and permissions

- **Web UI:** GitHub/Discord OAuth as today, with invites and the `INITIAL_ADMIN` bootstrap.
- **Clients:** per-user **access tokens** (today's API keys), accepted the way each client sends them:
  - HTTP Basic with any username and the token as the password (Maven `settings.xml`, Gradle
    credentials, `docker login`, npm `_auth`);
  - `Authorization: Bearer <token>` (npm `_authToken`, the Weaver CLI and plugin).
  - For Docker, Weaver implements the token-auth flow if Basic alone does not satisfy every client.
    Either way, `docker login <host>` works.
- **`npm login` / `yarn npm login` create a token through the browser.** Weaver implements npm's web
  login flow (`/-/v1/login` + polling `doneUrl`): the CLI opens a Weaver page, the user signs in with
  OAuth, chooses which repos the new token can read or write (pre-filled with the npm repo the login
  targeted, write if the user's role allows), and the token is issued to the CLI. For clients that only
  speak the legacy `PUT /-/user/org.couchdb.user:<name>` flow (yarn berry), the password field accepts
  an existing access token and returns it.
- **Permissions are per repo, read or write**, granted to tokens as today and capped by the owner's
  current role (viewer = read only; banned users are rejected). Today's group-prefix narrowing for
  proto may be kept for proto.
- **Anonymous read** is per repo through visibility. The existing `anonymousView` setting keeps gating
  the browse UI.
- **Groups:** read permission on a group gives read access to everything served through that group,
  even from members the caller can't read directly (Nexus behaviour, my call). Writes are never
  possible through a group.

### Extras

- **Browse UI per format:**
  - Maven: groupId/artifactId/version tree, files.
  - npm: package page with README, versions, dist-tags.
  - Docker: images, tags, digests, platforms, layer sizes, attached OCI artifacts.
  - Proto: today's version and dependency pages.
  - Each page shows copy-paste client config (settings.xml/Gradle, `.npmrc`, `docker login`/`pull`,
    Gradle plugin/CLI) for that repo.
- **Cleanup policies** per repo, run daily by the worker and on demand:
  - Maven/proto: keep the last N snapshot builds, delete stale snapshots, delete not downloaded in
    N days (today's kinds), optionally including releases.
  - npm: delete versions not downloaded in N days, keep the last N versions.
  - Docker: delete untagged manifests, keep the last N tags matching a pattern, delete tags not pulled
    in N days, followed by GC.
  - Mirror caches are governed by eviction settings, not cleanup policies.
- **Browse and search show only what Weaver stores (my call):** hosted content and mirror caches. A
  mirror with caching off shows a short note that its content lives upstream. `npm search`
  (`/-/v1/search`) against a mirror is forwarded upstream; against a group it merges hosted results with
  the first mirror member's upstream results.
- **Search** across all repos the caller can read: by name, Maven coordinates, npm package name,
  image name, proto coordinates. Postgres-based search is fine.
- **Usage stats:**
  - downloads per package/artifact/image over time;
  - storage used per repo, including mirror cache size;
  - mirror cache hit rate (hits vs upstream fetches);
  - per-token activity: which token pushed or pulled what, and when.

### Delivery

- **Formats are built in parallel** on top of a shared core: rename, generic repository model,
  streaming storage, client auth, mirror/group machinery and the admin UI shell. The shared core comes
  first because every format depends on it.
- Deployment stays one Docker image used for web and worker, plus PostgreSQL, Valkey and optional S3,
  deployable through the existing compose and Coolify files.

## Left to the builder

- The concrete DB schema: generic tables vs per-format tables, how components, assets and blobs are
  modelled.
- Whether the format protocol endpoints run as Next.js route handlers or as a separate Node HTTP server
  inside the same image, as long as request/response streaming, large uploads and the URL layout above
  work behind the existing reverse proxy setup.
- Encryption scheme for stored upstream credentials (derived from an env secret).
- Exact defaults: metadata TTL, eviction limits, per-format size limits, stats retention and
  aggregation granularity.
- Search implementation (full text or trigram) and ranking.
- How the Gradle plugin and CLI are renamed and versioned, within the "rename everything" decision.
- Test layout, as long as the real-client e2e bar above is met.

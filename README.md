<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/weaver-logo-inverted.svg">
  <img alt="Weaver" src="docs/brand/weaver-logo.svg" width="232" height="64">
</picture>

A self-hosted artifact repository for **Maven**, **npm**, **Docker/OCI** and **proto**. Every format has
**hosted** repositories you publish to, **mirrors** that proxy an upstream such as Maven Central,
registry.npmjs.org or Docker Hub (caching optional, off by default), and read-only **groups** that put one URL
in front of several of them. Stock clients work without plugins or special flags: `mvn`, Gradle, `npm`, `pnpm`,
`yarn`, `bun`, `docker`, `podman`, `buildx` and `helm`, plus the Weaver Gradle plugin and CLI for proto.

Source: [github.com/SLNE-Development/weaver](https://github.com/SLNE-Development/weaver) · License: MIT ·
Docs: `/docs` on every instance (sources in [`apps/web/content/docs`](apps/web/content/docs))

## Features

- **Four formats, three kinds:** hosted, mirror and group repositories for Maven, npm, Docker/OCI and proto,
  all on one domain: `/maven/<repo>/`, `/npm/<repo>/`, `/v2/<repo>/…` and the proto REST API under `/api/v1/`.
- **Mirrors** with ordered upstreams, per-upstream credentials (encrypted at rest), allow/deny rules, an offline
  switch, and optional caching with a metadata TTL and eviction by age and size. A Docker mirror can be the
  **root mirror**, so the Docker daemon's `registry-mirrors` setting pulls Docker Hub images through Weaver.
- **Per-format browse UI:** Maven artifacts, npm packages with dist-tags, Docker tags with platforms, Helm charts,
  signatures and SBOMs, and proto versions with a file viewer.
- **Cleanup policies** per format (snapshot builds, unused versions, tags and untagged manifests) with preview,
  plus Docker garbage collection.
- **Search** across repositories and **usage statistics** per repository.
- **Access control:** GitHub and Discord OAuth, invites, `admin`/`maintainer`/`viewer` roles, and access tokens
  with read or write access per repository. Public repositories allow anonymous reads; reading a group covers
  everything served through it.
- **Storage** on local disk, S3, or both: hosted content on the primary store, mirror caches on either.

## Quick start

Requirements: Docker with Compose, a domain with HTTPS in front of the server, and a GitHub or Discord OAuth app.

```sh
git clone https://github.com/SLNE-Development/weaver.git
cd weaver
cp .env.example .env
# set POSTGRES_PASSWORD, BETTER_AUTH_SECRET, BETTER_AUTH_URL, one OAuth provider and, for the first
# deploy, INITIAL_ADMIN (github:<login> or discord:<user id>; without it nobody can sign in)
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` runs the published image `ghcr.io/slne-development/weaver:latest` as the web app and
as the worker, with PostgreSQL and Valkey. Set `WEAVER_IMAGE` to pin a release (for example
`ghcr.io/slne-development/weaver:0.1.0`), or run `up -d --build` to build from the checkout. Put a TLS-terminating
reverse proxy in front of port 3000 that does not limit request bodies (nginx: `client_max_body_size 0;` and
`proxy_request_buffering off;`), and set `BETTER_AUTH_URL` to its https URL.

For Coolify, use `docker-compose.coolify.yml`. Every setting is described in the docs:
[Docker Compose](apps/web/content/docs/self-host/compose.md), [Coolify](apps/web/content/docs/self-host/coolify.md)
and the [configuration reference](apps/web/content/docs/self-host/config.md) (`/docs/self-host/config` on a
running instance).

## Clients

The examples use `https://weaver.example.com` and read the access token from `WEAVER_TOKEN`. Create tokens under
**API keys** in the web app. The browse page of every repository shows these snippets for that repository.

### Maven

`~/.m2/settings.xml`:

```xml
<settings>
  <servers>
    <server>
      <id>weaver-releases</id>
      <username>token</username>
      <password>${env.WEAVER_TOKEN}</password>
    </server>
  </servers>
</settings>
```

`pom.xml`:

```xml
<repositories>
  <repository>
    <id>weaver-releases</id>
    <url>https://weaver.example.com/maven/releases/</url>
  </repository>
</repositories>
```

Gradle (credentials `weaverReleasesUsername` / `weaverReleasesPassword` in `~/.gradle/gradle.properties`):

```kotlin
repositories {
    maven {
        name = "weaverReleases"
        url = uri("https://weaver.example.com/maven/releases/")
        credentials(PasswordCredentials::class)
    }
}
```

### npm, pnpm, yarn and bun

`.npmrc` (npm, pnpm and yarn classic; yarn berry and bun are covered in the docs):

```ini
registry=https://weaver.example.com/npm/npm-group/
//weaver.example.com/npm/npm-group/:_authToken=${WEAVER_TOKEN}
```

`npm login --registry=https://weaver.example.com/npm/npm-group/` also works and approves the login in the browser.

### Docker and OCI

```sh
echo "$WEAVER_TOKEN" | docker login weaver.example.com --username token --password-stdin
docker push weaver.example.com/apps/web:1.0
docker pull weaver.example.com/hub/nginx:latest
```

The first path segment is the repository. Docker clients need HTTPS (or `insecure-registries`) and Weaver at the
root of its domain.

### proto

Gradle plugin `dev.slne.weaver`, published to `https://reposilite.slne.dev/releases/`:

```kotlin
// settings.gradle.kts
pluginManagement {
    repositories {
        maven("https://reposilite.slne.dev/releases/")
        gradlePluginPortal()
    }
}
```

```kotlin
// build.gradle.kts
plugins {
    id("dev.slne.weaver") version "0.1.0"
}

// WEAVER_URL and WEAVER_TOKEN are read from the environment by default.
weaver {
    repositories("releases")            // lookup order for dependencies
    publishing {
        repository.set("releases")
        snapshotRepository.set("snapshots")
        group.set("com.example")
        name.set("orders-api")
    }
}

dependencies {
    weaver("com.example:common-types:2.0.0")
}
```

`./gradlew publishProtos` uploads the bundle; `./gradlew fetchProtos` resolves the dependencies into
`build/weaver/protos/`.

The `weaver` CLI ([`@slne/weaver-cli`](packages/cli/README.md), Node 22.3+) fetches the same bundles in Node
projects from a `weaver.json`:

```sh
pnpm add -D @slne/weaver-cli
export WEAVER_URL=https://weaver.example.com
npx weaver fetch
```

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/web` | Next.js app: UI, REST API, tRPC, the Maven, npm and Docker registry routes, and the docs (`content/docs`) |
| `apps/worker` | BullMQ worker: cleanup, cache eviction, Docker garbage collection, usage statistics |
| `packages/core` | Repository model, mirror engine, storage, permissions, cleanup runner, search |
| `packages/maven`, `packages/npm`, `packages/docker`, `packages/proto` | One package per format: protocol handlers, browse, cleanup |
| `packages/db` | Drizzle schema and migrations |
| `packages/jobs` | Job queue shared by web and worker |
| `packages/ui`, `packages/config` | UI components; shared TypeScript, ESLint and Vitest config |
| `packages/cli` | The `weaver` CLI (`@slne/weaver-cli`) |
| `gradle-plugin` | Gradle plugin `dev.slne.weaver` |
| `docker/` | Dockerfile, entrypoint and healthcheck |
| `scripts/e2e/` | End-to-end tests with real clients |
| `.github/workflows` | CI and tag releases |

## Local development

Requirements: Node 22.3+ (see `.nvmrc`), pnpm (via corepack), Docker, and a JDK 21 for the Gradle plugin.

```sh
corepack enable
pnpm install
docker compose up -d          # postgres, valkey (job queue) and seaweedfs (S3, bucket "weaver") for development
cp .env.example .env          # then fill in the values
pnpm dev                      # web app (next dev) and worker (tsx watch), both reading the root .env
```

## Testing

```sh
pnpm build && pnpm typecheck && pnpm lint
pnpm test                     # unit and integration tests (Vitest; database tests use Testcontainers)
pnpm --filter web e2e         # Playwright tests of the web app
scripts/e2e/run.sh [format]   # end-to-end tests with real clients against the production image
```

`scripts/e2e/run.sh` builds the image, starts `docker-compose.prod.yml` with local stand-in upstreams and runs
every format (`proto`, `maven`, `npm`, `docker`, `platform`), or only the ones you name. It needs Docker with
Compose v2 and buildx, a JDK 21, Maven, podman, helm and Node per `.nvmrc`. The `docker` format needs Linux
(host networking); the others also run in Git Bash on Windows. `--upstreams=real` points the mirrors at Maven
Central, registry.npmjs.org and Docker Hub instead.

## Releases

CI (`.github/workflows/ci.yml`) builds, type-checks, lints and tests every push to `main` and every pull request,
and runs the Gradle plugin tests.

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`. The tag must equal the version in
`packages/cli/package.json` and `gradle-plugin/build.gradle.kts`. It publishes:

- the image `ghcr.io/slne-development/weaver:X.Y.Z` and `:latest` (linux/amd64 and linux/arm64),
- the CLI to npm as `@slne/weaver-cli@X.Y.Z`,
- the Gradle plugin `dev.slne.weaver:X.Y.Z` to `https://reposilite.slne.dev/releases/`.

Repository secrets the release needs:

| Secret | Used for |
| --- | --- |
| `NPM_TOKEN` | npm automation (or granular publish) token for `@slne/weaver-cli`. |
| `SLNE_RELEASES_REPO_USERNAME` | Reposilite user with write access to `releases`. |
| `SLNE_RELEASES_REPO_PASSWORD` | Its password or token. |

The image is pushed with the workflow's built-in `GITHUB_TOKEN` (`packages: write`); no secret is needed for it.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

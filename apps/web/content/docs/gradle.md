---
title: Gradle plugin
description: Every option of the dev.slne.weaver plugin, covering repositories, publishing, snapshot repositories, local modules, environment variables and the configuration cache.
section: Clients
order: 1
---

The Gradle plugin `dev.slne.weaver` publishes the `.proto` files of a project and fetches proto dependencies into `build/weaver/protos/`. It is built and tested with Gradle 9 on Java 21, and supports the configuration cache.

## Install

The plugin is published to the SLNE Maven repository:

```kotlin title="settings.gradle.kts"
pluginManagement {
    repositories {
        gradlePluginPortal()
        maven("https://reposilite.slne.dev/releases/")
    }
}
```

```kotlin title="build.gradle.kts"
plugins {
    id("dev.slne.weaver") version "0.1.0"
}
```

## Full example

```kotlin title="build.gradle.kts"
group = "dev.surf.economy"
version = "1.4.0"

weaver {
    // Defaults: the WEAVER_URL and WEAVER_TOKEN environment variables.
    // url = "{{url}}"
    // token = providers.environmentVariable("MY_TOKEN")

    repositories("releases", "snapshots")   // lookup order for dependencies

    publishing {
        repository = "releases"             // receives release versions
        snapshotRepository = "snapshots"    // receives -SNAPSHOT versions
        group = "dev.surf.economy"
        name = "economy-contracts"
        // version defaults to project.version
        // source defaults to src/main/proto
    }
}

dependencies {
    weaver("dev.surf.common:common-types:2.0.0")   // published artifact
    weaver(project(":shared-protos"))              // module of the same build
}
```

## The `weaver` block

| Option | Type | Default | Used by |
| --- | --- | --- | --- |
| `url` | `Property<String>` | `WEAVER_URL` environment variable | both tasks |
| `token` | `Property<String>` | `WEAVER_TOKEN` environment variable | both tasks |
| `repositories(vararg names)` | appends to `ListProperty<String>` | empty | `fetchProtos` |
| `publishing { }` | see below | | `publishProtos` |
| `protosDir` | `Provider<Directory>` (read only) | `build/weaver/protos` | your build |

- `url` is the base URL of the server, for example `{{url}}`. Without it, both tasks fail with `No Weaver server URL configured. Set the WEAVER_URL environment variable or weaver.url.`
- `token` is an API key, sent as `Authorization: Bearer <token>`. It is optional when you only read public repositories. It is never part of a task's inputs, so changing it doesn't invalidate anything.
- `repositories` is the lookup order for dependencies. Entries can be hosted, mirror or group repositories: `repositories("proto-all")` searches the members of the group `proto-all` in order. `fetchProtos` fails with `weaver.repositories is empty` when you declared remote dependencies but no repository.

## The `publishing` block

| Option | Type | Default |
| --- | --- | --- |
| `repository` | `Property<String>` | none, required |
| `snapshotRepository` | `Property<String>` | falls back to `repository` |
| `group` | `Property<String>` | none, required |
| `name` | `Property<String>` | none, required |
| `version` | `Property<String>` | `project.version` (when set) |
| `source` | `DirectoryProperty` | `src/main/proto` |

A missing value fails the publish with `weaver.publishing.<option> is not set.` A version ending in `-SNAPSHOT` goes to `snapshotRepository` when it is set, otherwise to `repository`.

Only files matching `**/*.proto` under `source` are packed. Their path relative to `source` is their import path.

## Dependencies

Declare dependencies in the `weaver` configuration:

```kotlin
dependencies {
    weaver("dev.surf.common:common-types:2.0.0")
    weaver("dev.surf.common:common-types:2.1.0-SNAPSHOT")
    weaver(project(":shared-protos"))
}
```

A remote dependency needs a group, a name and an exact version. Without a version the build fails with `weaver dependency … needs a version.` Gradle-style ranges and `+` are not supported; the server rejects them as invalid coordinates.

The same list is used twice: `fetchProtos` downloads it, and `publishProtos` writes it into the published artifact as its declared dependencies.

## Tasks

| Task | What it does |
| --- | --- |
| `fetchProtos` | Resolves the dependencies on the server and writes all files into `build/weaver/protos/`. |
| `publishProtos` | Packs `source` with `packProtos` and uploads it with its dependencies. |
| `packProtos` | Builds `build/weaver/publish/protos.tar.gz`, reproducibly (fixed order, no timestamps). |

### `fetchProtos`

- Always runs. It is never up to date, because a snapshot may have a new build.
- Archives are cached by checksum in `~/.gradle/caches/weaver/` (under your Gradle user home). A release downloads once; a cached archive is reused across projects.
- Every download is checked against the SHA-256 from the server. A mismatch fails the build.
- The output folder is synchronised: files that are no longer part of the tree are removed.
- Version conflicts are logged, and two sources with the same file path fail the build. See [Dependencies and resolution](/docs/resolution).

Use the output through `weaver.protosDir`. It carries the task dependency, so anything that reads it runs after `fetchProtos`:

```kotlin
tasks.named("generateContracts") {
    inputs.dir(weaver.protosDir)
}
```

### `publishProtos`

On success it prints the coordinate, the repository and the build number:

```text
Published dev.surf.economy:economy-contracts:1.4.0 to releases, build 1
```

A failed publish shows the server's error code and message, for example `immutable: … already exists in releases and releases are immutable`. See [REST API](/docs/api#errors) for every code.

## Local modules

In a multi-module build, a module can use the protos of another module directly:

```kotlin title="app/build.gradle.kts"
dependencies {
    weaver(project(":shared-protos"))
}
```

- `:shared-protos` must apply `dev.slne.weaver` too.
- Its `source` files are copied into this module's `build/weaver/protos/` as they are. Changes are picked up on the next build, without publishing.
- Its own `weaver` dependencies are fetched as well, in the same request as this module's.
- If `:shared-protos` has a `publishing` block, its `group:name` stands in for the remote artifact with that `group:name`. The remote artifact is never downloaded, and nor are the dependencies it alone brings in. Run with `--info` to see `Using project :shared-protos instead of …`.
- Two local modules can't publish the same `group:name`; the build fails and names both.
- A file path in both a local module and a remote artifact fails the fetch, like two remote artifacts would.

When you publish a module that depends on a local module, the dependency is written as that module's own coordinate (`group:name:version` from its `publishing` block). The publish fails if the module has no `publishing` block, and the server rejects it if that version isn't published yet. Publish `:shared-protos` first.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `WEAVER_URL` | Default for `weaver.url`. |
| `WEAVER_TOKEN` | Default for `weaver.token`. |

Set them in your shell, or as CI secrets:

```yaml title=".github/workflows/protos.yml"
- run: ./gradlew publishProtos
  env:
    WEAVER_URL: {{url}}
    WEAVER_TOKEN: ${{ secrets.WEAVER_TOKEN }}
```

To read them from somewhere else, set the properties yourself:

```kotlin
weaver {
    url = providers.gradleProperty("weaverUrl")
    token = providers.environmentVariable("CI_WEAVER_KEY")
}
```

## Configuration cache

The plugin is compatible with Gradle's configuration cache (`--configuration-cache` or `org.gradle.configuration-cache=true`). The URL and token are read through providers, so a changed environment variable is picked up without stale values.

---
title: Publish your first artifact
description: Turn the .proto files of a Gradle project into a versioned artifact other projects can depend on. Takes about five minutes.
section: Getting started
order: 3
---

You need an account on this instance and permission to write to a repository. If you don't have either, ask an admin for an invite and for write access to a repository such as `releases`.

The examples publish `dev.surf.protection:protection-contracts:1.0.0` to a repository called `releases`. Use your own group, name and repository.

## 1. Create an API key

Builds publish with an API key, never with your browser session.

1. Open **API keys** in the sidebar and choose **Create key**.
2. Give it a name, such as `protection-contracts CI`.
3. Add a permission: repository `releases`, group prefix `dev.surf.protection`, access `write`.
4. Copy the key. It is shown only once.

Only maintainers and admins can create keys with write access. See [API keys and permissions](/docs/admin/keys).

## 2. Store the key where Gradle can read it

The plugin reads the server URL and the key from two environment variables. Locally, export them in your shell. In CI, add them as secrets.

```sh
export WEAVER_URL={{url}}
export WEAVER_TOKEN=<your API key>
```

Keep the key out of `build.gradle.kts` and `gradle.properties` files that are committed.

## 3. Apply the plugin

The plugin `dev.slne.weaver` is published to the SLNE Maven repository. Add it to the plugin repositories in `settings.gradle.kts`:

```kotlin title="settings.gradle.kts"
pluginManagement {
    repositories {
        gradlePluginPortal()
        maven("https://reposilite.slne.dev/releases/")
    }
}
```

Then apply and configure it:

```kotlin title="build.gradle.kts"
plugins {
    id("dev.slne.weaver") version "0.1.0"
}

version = "1.0.0"

weaver {
    repositories("releases")
    publishing {
        repository = "releases"
        group = "dev.surf.protection"
        name = "protection-contracts"
        // version defaults to project.version
    }
}

dependencies {
    // every artifact your protos import from
    weaver("dev.surf.economy:economy-contracts:1.4.0")
}
```

Your `.proto` files go in `src/main/proto`, in folders that match their import paths: `src/main/proto/surf/protection/v1/region.proto` is imported as `surf/protection/v1/region.proto`.

## 4. Publish

```sh
./gradlew publishProtos
```

On success Gradle prints a line like this:

```text
Published dev.surf.protection:protection-contracts:1.0.0 to releases, build 1
```

Weaver compiles your files together with their dependencies before it accepts them. If a file doesn't compile, or imports a file from an artifact you didn't declare, the publish fails and names the file and the problem. See [Validation on publish](/docs/validation).

> [!WARNING]
> **Releases are permanent.** Once `1.0.0` is published it can't be overwritten, unless the repository allows redeploy. While you're iterating, use a version like `1.0.0-SNAPSHOT`. Every publish then creates a new build, and consumers get the newest one.

## 5. Check it in the browser

Open **Browse**, then `releases`, then `dev.surf.protection`, then `protection-contracts`. You see the version, its files in the proto viewer, and the dependency on `economy-contracts`. The **Usage** tab shows the snippet other teams copy:

```kotlin
weaver("dev.surf.protection:protection-contracts:1.0.0")
```

## Dependency checks

When you publish, the server checks that every dependency you declared exists. It looks only in hosted proto repositories your key can read, either directly or through a group: first the repository you publish to, then the others by resolution priority. See [Dependencies and resolution](/docs/resolution#resolution-when-publishing).

Mirrors are never consulted. If a dependency is only available through a mirror, publish it into a hosted repository first.

Publishing to a group or to a mirror is not possible: the server answers `405 method_not_allowed`. Publish to a hosted repository and let the group include it.

## Next steps

- Publish snapshots to a separate repository with `snapshotRepository`: see [Gradle plugin](/docs/gradle).
- Learn when a version can be replaced: [Versions and snapshots](/docs/versions).
- Fetch the artifact in another project: [Use protos in a project](/docs/consume).

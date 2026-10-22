---
title: Versions and snapshots
description: Choose between a release and a -SNAPSHOT version, know when a version can be replaced, and what happens to the artifacts that depend on it.
section: Concepts
order: 1
---

Every artifact version is either a **release** or a **snapshot**. The version string decides which.

| Version | Kind | Can be published again? |
| --- | --- | --- |
| `1.4.0`, `2.0`, `1.4.0-rc.1` | release | No, unless the repository allows redeploy |
| `1.4.0-SNAPSHOT` | snapshot | Yes, every publish creates a new build |

A version is a snapshot exactly when it ends in `-SNAPSHOT` (uppercase).

## Version format

A version is one to four numbers separated by dots, optionally followed by `-` and a qualifier made of letters, digits, `.` and `-`. It can be at most 64 characters long.

```text
1            1.4.0         1.4.0.7
1.4.0-rc.1   1.4.0-beta2   1.4.0-SNAPSHOT
```

Versions are compared number by number, so `1.10.0` is higher than `1.9.0`. A version without a qualifier is higher than the same numbers with one: `1.4.0` is higher than `1.4.0-rc.1` and `1.4.0-SNAPSHOT`. Qualifiers are compared part by part; numeric parts compare as numbers, so `rc.10` is higher than `rc.2`.

## Releases

A release is permanent. Publishing `1.4.0` a second time is rejected with `409 immutable`:

```text
immutable: dev.surf.economy:economy-contracts:1.4.0 already exists in releases and releases are immutable
```

Bump the version instead. Builds that depend on `1.4.0` keep getting exactly the files they were built against.

### Redeploy

An admin can turn on **Allow redeploy** for a repository. Then publishing an existing release replaces it: the old files are deleted and the new upload becomes build 1 again. Gradle reports `(redeployed)` after the build number.

Redeploy is still blocked when other versions depend on the release, in any repository. The publish fails with `409 has_dependents` and lists the dependents you can see. An admin can force it through the REST API with `?force=true`; forced actions are marked in the audit log. See [REST API](/docs/api#publish-a-version).

## Snapshots

Use a snapshot while a contract is still changing: `1.5.0-SNAPSHOT`.

- Every publish of `1.5.0-SNAPSHOT` creates a new **build** with the next build number (1, 2, 3 …).
- Resolving or downloading `1.5.0-SNAPSHOT` always returns the newest build.
- Older builds stay until a [cleanup policy](/docs/admin/cleanup) removes them. The version page in the browser lists them under **Builds**.
- Clients re-check snapshots on every fetch, so you pick up new builds without changing anything.

When the contract is stable, publish `1.5.0` as a release.

## A release can't depend on a snapshot

A release must be reproducible, so it may not depend on a snapshot, directly or through another dependency. Such a publish is rejected with `422 validation_failed`:

```text
validation_failed: A release may not depend on snapshot dev.surf.common:common-types:2.1.0-SNAPSHOT
```

Publish the dependency as a release first. A snapshot may depend on releases and on other snapshots.

## Which repository accepts what

Each repository accepts releases, snapshots, or both (both by default). Publishing a kind the repository doesn't accept fails with `400 invalid_request`, for example `Repository releases does not accept snapshots`.

A common setup is a `releases` repository that accepts only releases and a `snapshots` repository that accepts only snapshots. The Gradle plugin sends `-SNAPSHOT` versions to `snapshotRepository` when you set it:

```kotlin title="build.gradle.kts"
weaver {
    repositories("releases", "snapshots")
    publishing {
        repository = "releases"
        snapshotRepository = "snapshots"
        group = "dev.surf.economy"
        name = "economy-contracts"
    }
}
```

## Deleting a version

Maintainers and admins can delete a version on its page in the browser. All its builds and files are removed. Like redeploy, deleting is blocked while other versions depend on it. The dialog lists the dependents, and admins get **Delete anyway**, which asks you to type the coordinate.

Before you delete or redeploy, check the **Dependents** tab of the version page.

### Publishing a deleted release again

Deleting a release doesn't free its version number for new content. Weaver remembers the checksum (sha256) of the deleted archive, whether a person or a [cleanup policy](/docs/admin/cleanup) deleted it. In a repository without **Allow redeploy**, publishing that version again is accepted only with identical content, for example to restore a release deleted by mistake. Different content is rejected with `409 immutable`:

```text
immutable: Release dev.surf.economy:economy-contracts:1.4.0 was deleted; re-publishing is only allowed with identical content (or enable redeploy)
```

Bump the version instead, or ask an admin to turn on **Allow redeploy**. Snapshots are not affected: a deleted snapshot version can be published again with any content.

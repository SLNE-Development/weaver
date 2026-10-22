---
title: Dependencies and resolution
description: Predict which version of each artifact wins, read version conflict warnings, and fix "provided by both" errors.
section: Concepts
order: 2
---

Resolution turns the coordinates you declared into the complete list of artifacts to download. It runs on the server, so the Gradle plugin and the CLI always agree.

## What the client sends

A client sends two lists to `POST /api/v1/resolve`:

- **repositories**, in order: `["releases", "snapshots"]`. In Gradle this is `weaver { repositories(...) }`; in the CLI it is `repositories` in `weaver.json`.
- **dependencies**, as exact coordinates: `["dev.surf.economy:economy-contracts:1.4.0"]`.

The server answers with every artifact in the tree, each with its repository, build number, checksum and archive URL, plus any version conflicts it settled. See [REST API](/docs/api#resolve-dependencies).

## Where each artifact is found

For every coordinate in the tree, the server looks in your repositories in the order you listed them. The first repository that has the exact version **and** that you can read wins. An entry can be a hosted, a mirror or a group repository.

- A **hosted** repository answers from what was published to it.
- A **mirror** asks its upstream Weaver instance. See [Repositories](/docs/admin/repositories#proto-mirrors-and-groups).
- A **group** searches its members in the member order, and the first member that has the exact version wins. A group is one entry in your list, so the list order decides between a group and the entries around it.
- Repositories you can't read are skipped, as if the artifact wasn't there.
- Names that don't exist, names of repositories of another format (such as Maven or npm) and names you can't read are ignored.
- The repository reported for an artifact is the name you listed. An artifact found through the group `proto-all` is reported, and downloaded, as `proto-all`, not as the member that holds it.
- A `-SNAPSHOT` version resolves to its newest build.

If no repository has the coordinate, resolution fails with `404 not_found`, and `details.path` shows how it was reached:

```json
{
  "error": {
    "code": "not_found",
    "message": "Dependency dev.surf.common:common-types:2.0.0 was not found",
    "details": {
      "path": [
        "dev.surf.economy:economy-contracts:1.4.0",
        "dev.surf.common:common-types:2.0.0"
      ]
    }
  }
}
```

Check that the repository holding it is in your list and that your key can read it.

## Which version wins

Dependencies are exact, but two artifacts in the tree can ask for different versions of the same artifact. Weaver then picks the **highest** version, like Gradle does.

```text
your project
├── economy-contracts:1.4.0  → common-types:2.0.0
└── protection-contracts:1.0.0 → common-types:2.1.0

resolved: common-types:2.1.0
```

Only versions that are still part of the tree count. If picking a higher version of some artifact drops a dependency that asked for something else, that request no longer counts. The result doesn't depend on the order you declared things in.

Each settled conflict is reported. The Gradle plugin logs:

```text
Weaver resolved a version conflict: {"group":"dev.surf.common","name":"common-types","requested":["2.0.0","2.1.0"],"selected":"2.1.0"}
```

The CLI prints:

```text
warning: Version conflict: dev.surf.common:common-types requested at 2.0.0, 2.1.0; using 2.1.0
```

A conflict is not an error. It tells you that one of your dependencies compiles against a different version than the one you get. To stop the warning, align the versions in the artifacts you depend on, or declare the version you want directly.

## "Provided by both" errors

All files of the resolved artifacts go into one folder. If two different artifacts contain the same file path, there is no right answer, so the fetch fails:

```text
File surf/common/v1/ids.proto is provided by both dev.surf.common:common-types:2.1.0 and dev.surf.legacy:legacy-types:1.0.0
```

The CLI words it as `Path "…" is provided by both … and …`. It also fails when two paths differ only in upper and lower case, because they would overwrite each other on Windows and macOS.

To fix it:

- Drop one of the two artifacts if you don't need both.
- Otherwise, the owners of the two artifacts must move the file. Each `.proto` file should live in exactly one artifact, under a folder that matches its package (`surf/common/v1/`).

The same check runs when you publish. If your files and your dependencies' files share a path, the publish is rejected with `422 validation_failed` and the list of collisions. See [Validation on publish](/docs/validation).

## Resolution when publishing

When you publish, the server resolves your declared dependencies too, but with a different repository order:

1. The repository you publish to.
2. Every other hosted proto repository, by ascending **resolution priority** (lower wins), then by name.

Only hosted proto repositories your API key can read are used, directly or through a group. Mirrors are never consulted, because publishing never contacts an upstream. If a dependency only exists in a mirror, publish it into a hosted repository first. See [Publish your first artifact](/docs/publish#dependency-checks). An admin sets the priority per repository; the default is 100. See [Repositories](/docs/admin/repositories).

## Local modules in Gradle

In a multi-module Gradle build, `weaver(project(":contracts"))` uses the protos of another module directly, without publishing it first. If that module publishes the same `group:name` as a remote artifact in the tree, the module wins and the remote artifact is left out together with its dependencies. See [Gradle plugin](/docs/gradle#local-modules).

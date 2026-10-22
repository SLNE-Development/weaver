---
title: Validation on publish
description: Understand why a publish was rejected, such as a compile error, an undeclared import, a reserved path or a file conflict, and fix it.
section: Concepts
order: 3
---

Weaver never stores an artifact that doesn't compile. Every publish goes through the checks below. Any failing check rejects the publish, and nothing is stored. The sections group the checks by topic; the server runs some of them interleaved (for example, the archive size and the manifest are checked before the archive contents are unpacked).

## 1. The archive

The upload must be a `.tar.gz` that contains only `.proto` files. The Gradle plugin builds it for you from `weaver.publishing.source`.

| Rule | Error |
| --- | --- |
| Archive at most 10 MiB | `413 payload_too_large` |
| At most 1000 files | `413 payload_too_large` |
| Each file at most 1 MiB, all files together at most 32 MiB | `413 payload_too_large` |
| Only regular files ending in `.proto` (no symlinks, no other files) | `400 invalid_request` |
| Relative paths without `..`, backslashes or a leading `/` | `400 invalid_request` |
| No duplicate paths, at least one `.proto` file | `400 invalid_request` |
| Files are valid UTF-8 | `400 invalid_request` |

If Gradle reports `No .proto files found in …`, check that your files are under `src/main/proto` or set `weaver.publishing.source`.

## 2. The manifest

The coordinate must be valid and your key must be allowed to write it:

- group, name and version follow the [coordinate rules](/docs#artifacts-and-coordinates); otherwise `400 invalid_request` with `Invalid manifest`.
- An artifact can't depend on itself, and can't list the same `group:name` twice.
- Your key needs `write` access to the repository and group: otherwise `403 forbidden` (`No write access to <group> in <repository>`). If the key can't even read the repository, the answer is `404 not_found`, so private repositories stay hidden.
- The repository must accept the version kind (release or snapshot): otherwise `400 invalid_request`.
- An existing release can't be published again unless the repository allows redeploy: `409 immutable`. See [Versions and snapshots](/docs/versions#releases).

## 3. The dependencies

Your declared dependencies are [resolved](/docs/resolution#resolution-when-publishing) against the target repository first, then the other repositories your key can read.

| Problem | Error message (all `422 validation_failed`) |
| --- | --- |
| A dependency doesn't exist or your key can't read it | `Dependency not found: <coordinate>` |
| A release depends on a snapshot, directly or transitively | `A release may not depend on snapshot <coordinate>` |
| The artifact reaches itself through its dependencies | `<group>:<name> depends on itself through <coordinate>` |
| A file path exists in your artifact and a dependency, or in two dependencies | `N file path(s) are provided by more than one artifact` |

For a path conflict, `details.collisions` lists each path and the coordinates that contain it.

## 4. Compilation

Finally, Weaver compiles your files with [buf](https://buf.build), together with the files of every resolved dependency and the protobuf well-known types (`google/protobuf/*.proto`). An import is satisfied only by:

- a file in your own artifact,
- a file in a declared dependency, directly or transitively,
- a well-known type such as `google/protobuf/timestamp.proto`.

Anything else fails with `422 validation_failed` and the message `Proto validation failed`. `details.issues` lists every problem with its file, line and column:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Proto validation failed",
    "details": {
      "issues": [
        {
          "path": "surf/protection/v1/region.proto",
          "line": 3,
          "column": 1,
          "message": "imported file does not exist: surf/economy/v1/money.proto"
        }
      ]
    }
  }
}
```

Gradle prints the code and message (`validation_failed: Proto validation failed`). Call the REST API directly, or check the build log of your CI, to see the full `details`.

## Fixing common failures

**`imported file does not exist: …`.** The imported file isn't in your artifact or any declared dependency. Find the artifact that contains it under **Browse** and add it with `weaver("group:name:version")`. Files from transitive dependencies satisfy imports too, but declare every artifact you import from directly, so your artifact keeps compiling when a dependency drops one of its own.

**A compile error in your own file.** Fix the syntax or type error at the given line and column.

**A message starting with `in dependency:`.** The problem is in a dependency's file, usually because two dependencies don't fit together. Align their versions.

**`Reserved path: google/protobuf/… is reserved for protobuf well-known types`.** Don't ship your own copy of the well-known types. Import them; they are always available.

**`Invalid path: … must be a normalized relative path`.** Remove empty, `.` or `..` segments from the file's path.

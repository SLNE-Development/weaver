---
title: REST API
description: Call publish, resolve, list, download and delete directly, with request and response examples and every error code.
section: Clients
order: 6
---

The Gradle plugin and the CLI use a small JSON API under `{{url}}/api/v1`. You can call it directly from scripts or other build tools. The web app uses its own internal API; the endpoints below are the stable ones for clients.

## Authentication

Send an API key as a bearer token:

```http
Authorization: Bearer <your API key>
```

- Without a token, a request is anonymous and can read **public** repositories only.
- A token that is unknown, expired, revoked, or belongs to a banned user is rejected with `401 unauthorized`, even for public repositories. Leave the header out instead of sending an empty or stale token.
- A key can do what its permission entries allow, capped by its owner's current role. See [API keys and permissions](/docs/admin/keys).

Private repositories you can't read look exactly like missing ones: you get `404 not_found`, never `403`.

## Name rules

| Part | Pattern |
| --- | --- |
| repository | `^[a-z0-9][a-z0-9-]{0,62}$` |
| group | `^[a-z0-9_]+(\.[a-z0-9_-]+)*$` |
| name | `^[a-z0-9][a-z0-9._-]{0,99}$` |
| version | `^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$`, at most 64 characters |

A path segment that breaks these rules is answered with `400 invalid_request`.

## Publish a version

```http
PUT /api/v1/repos/{repo}/artifacts/{group}/{name}/{version}
Content-Type: multipart/form-data
```

The body has two fields:

- `manifest`: JSON with the coordinate and the declared dependencies. Group, name and version must equal the URL.
- `archive`: a `.tar.gz` of `.proto` files, at most 10 MiB. See [Validation on publish](/docs/validation#the-archive) for the limits.

Publishing needs an API key with `write` access. Signed-in browser sessions can't publish.

```sh
curl -X PUT "{{url}}/api/v1/repos/releases/artifacts/dev.surf.economy/economy-contracts/1.4.0" \
  -H "Authorization: Bearer $WEAVER_TOKEN" \
  -F 'manifest={"group":"dev.surf.economy","name":"economy-contracts","version":"1.4.0","dependencies":["dev.surf.common:common-types:2.0.0"]};type=application/json' \
  -F "archive=@protos.tar.gz;type=application/gzip"
```

Response `201 Created`:

```json
{
  "coordinate": "dev.surf.economy:economy-contracts:1.4.0",
  "buildNumber": 1,
  "sha256": "9f2c…e41a",
  "redeployed": false
}
```

For a snapshot, `buildNumber` counts up with every publish. `redeployed` is `true` when an existing release was replaced.

Add `?force=true` to redeploy a release that other versions depend on. Only an admin's key may do that; anyone else gets `403 forbidden`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | Bad multipart body, manifest not JSON or invalid, manifest and URL disagree, bad archive, the repository doesn't accept this version kind |
| 401 | `unauthorized` | No token, or an invalid one |
| 403 | `forbidden` | The key can read but not write this group, or `force` without admin |
| 404 | `not_found` | The repository doesn't exist or the key can't read it |
| 405 | `method_not_allowed` | Publishing or deleting through a group or a mirror. Both are read only; use a hosted repository. |
| 409 | `immutable` | The release exists and the repository doesn't allow redeploy |
| 409 | `has_dependents` | Redeploying a release that other versions depend on |
| 413 | `payload_too_large` | The body or archive is over the limits |
| 422 | `validation_failed` | Missing dependency, release on snapshot, path collision, compile error |

## Resolve dependencies

```http
POST /api/v1/resolve
Content-Type: application/json
```

```json
{
  "repositories": ["releases", "snapshots"],
  "dependencies": ["dev.surf.economy:economy-contracts:1.4.0"],
  "exclude": ["dev.surf.local:shared-protos"]
}
```

- `repositories`: up to 100 names, searched in order. Unknown names are skipped.
- `dependencies`: up to 1000 coordinates `group:name:version`.
- `exclude` (optional): up to 1000 `group:name` keys that you provide yourself. They are not looked up, their dependencies are not followed, and they never appear in the answer. The Gradle plugin uses this for local modules.

The body may be at most 1 MiB. Response `200 OK`:

```json
{
  "artifacts": [
    {
      "repository": "releases",
      "coordinate": "dev.surf.common:common-types:2.1.0",
      "group": "dev.surf.common",
      "name": "common-types",
      "version": "2.1.0",
      "buildNumber": 1,
      "sha256": "4be1…07c3",
      "archiveUrl": "{{url}}/api/v1/repos/releases/artifacts/dev.surf.common/common-types/2.1.0/archive?build=1"
    },
    {
      "repository": "releases",
      "coordinate": "dev.surf.economy:economy-contracts:1.4.0",
      "group": "dev.surf.economy",
      "name": "economy-contracts",
      "version": "1.4.0",
      "buildNumber": 1,
      "sha256": "9f2c…e41a",
      "archiveUrl": "{{url}}/api/v1/repos/releases/artifacts/dev.surf.economy/economy-contracts/1.4.0/archive?build=1"
    }
  ],
  "conflicts": [
    { "group": "dev.surf.common", "name": "common-types", "requested": ["2.0.0", "2.1.0"], "selected": "2.1.0" }
  ]
}
```

Artifacts are sorted by `group:name`. `archiveUrl` is always built from this instance's public URL and pins the resolved build (`?build=`), so a snapshot download matches `buildNumber` and `sha256` even if a newer build is published meanwhile. See [Dependencies and resolution](/docs/resolution) for how versions are chosen.

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | Body not JSON, wrong shape, a malformed coordinate or exclude key |
| 401 | `unauthorized` | An invalid token |
| 404 | `not_found` | A coordinate in the tree wasn't found in any readable repository; `details.path` shows the chain |
| 413 | `payload_too_large` | The body is over 1 MiB |

## List versions

```http
GET /api/v1/repos/{repo}/artifacts/{group}/{name}
```

```json
{
  "versions": [
    { "version": "1.5.0-SNAPSHOT", "isSnapshot": true, "latestBuild": 7, "updatedAt": "2026-10-20T14:03:11.000Z" },
    { "version": "1.4.0", "isSnapshot": false, "latestBuild": 1, "updatedAt": "2026-09-02T08:41:57.000Z" }
  ]
}
```

Newest version first. `404 not_found` when the artifact doesn't exist or you can't read it.

## Get a version

```http
GET /api/v1/repos/{repo}/artifacts/{group}/{name}/{version}
```

Describes the newest build; for a snapshot that is the latest publish. Add `?build=<n>` to describe a specific build (`404 not_found` once it was deleted). Dependencies are `group:name:version` strings, like `coordinate`.

```json
{
  "repository": "releases",
  "coordinate": "dev.surf.economy:economy-contracts:1.4.0",
  "buildNumber": 1,
  "sha256": "9f2c…e41a",
  "sizeBytes": 2318,
  "dependencies": ["dev.surf.common:common-types:2.0.0"],
  "files": ["surf/economy/v1/money.proto", "surf/economy/v1/wallet.proto"],
  "publishedBy": "Ada",
  "downloadCount": 42,
  "createdAt": "2026-09-02T08:41:57.000Z",
  "builds": [{ "buildNumber": 1, "createdAt": "2026-09-02T08:41:57.000Z", "sha256": "9f2c…e41a" }]
}
```

## Download an archive

```http
GET /api/v1/repos/{repo}/artifacts/{group}/{name}/{version}/archive
```

Returns the `.tar.gz` of the newest build as `application/gzip`, or of a specific build with `?build=<n>` (`404 not_found` once that build was deleted, for example by a cleanup policy), with its checksum in the `x-weaver-sha256` header. Each request counts as a download, which [cleanup policies](/docs/admin/cleanup) use to find unused versions.

```sh
curl -fLo economy-contracts-1.4.0.tar.gz \
  "{{url}}/api/v1/repos/releases/artifacts/dev.surf.economy/economy-contracts/1.4.0/archive"
```

## Delete a version

```http
DELETE /api/v1/repos/{repo}/artifacts/{group}/{name}/{version}
```

Deletes the version with all its builds. Needs a key with `write` access to the group, owned by a maintainer or admin, or a signed-in maintainer or admin session. Answers `204 No Content`.

If other versions depend on it, in any repository, the answer is `409 has_dependents`:

```json
{
  "error": {
    "code": "has_dependents",
    "message": "dev.surf.common:common-types:2.0.0 is depended on by 2 version(s)",
    "details": {
      "dependents": [
        {
          "repository": "releases",
          "coordinate": { "group": "dev.surf.economy", "name": "economy-contracts", "version": "1.4.0" }
        }
      ],
      "hiddenDependents": 1
    }
  }
}
```

`dependents` lists those you can read; `hiddenDependents` counts the rest. An admin can delete anyway with `?force=true`; the audit log marks it as forced.

## Errors

Every error has the same body:

```json
{ "error": { "code": "not_found", "message": "Repository internal was not found", "details": {} } }
```

`details` is only present for some errors. The Gradle plugin prints errors as `<code>: <message>`; the CLI prints `error: <message>`.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | The request is malformed. The message says what is wrong; `details.issues` lists fields for body validation errors. |
| 401 | `unauthorized` | Publishing or deleting without a key, or an invalid, expired or revoked key, or a banned owner. |
| 403 | `forbidden` | Authenticated, but not allowed: no write access, a viewer deleting, or `force` without admin. |
| 404 | `not_found` | The repository, artifact, version or a dependency doesn't exist, or you can't read it. Also any path that is not an API endpoint, and a mirror loop. |
| 405 | `method_not_allowed` | Publishing or deleting through a group or a mirror, or a method the endpoint doesn't support. The `allow` header lists the supported ones. |
| 409 | `immutable` | A release that already exists, in a repository without redeploy. |
| 409 | `has_dependents` | Deleting or redeploying a version that others depend on. `details.dependents` lists them. |
| 413 | `payload_too_large` | The body, the archive, a file, or the file count is over the limit. |
| 422 | `validation_failed` | The protos don't compile, or the dependency graph can't be used. `details.issues` or `details.collisions` explain why. |
| 502 | `upstream_unavailable` | A mirror's upstream did not answer, or answered with an error, and no cached copy exists. The message names the mirror, for example `Upstream of up-mirror did not answer`. |
| 500 | `internal_error` | Something went wrong on the server. The response reveals nothing; check the server logs. |

### Mirror hops

Weaver instances that mirror each other send an `x-weaver-hops` header with the requests they make upstream and raise it by one at every hop. An instance that receives more than 4 hops answers `404 not_found` with the message `Mirror loop detected` without doing any work, so a loop between mirrors cannot run forever (see [Troubleshooting](/docs/troubleshooting#mirrors)). Clients never need to send this header.

---
title: What is Weaver
description: Weaver is a self-hosted repository for Maven, npm, Docker/OCI and proto artifacts, with hosted, mirror and group repositories on one domain.
section: Getting started
order: 1
---

Weaver is a self-hosted artifact repository for four formats: **Maven**, **npm**, **Docker/OCI** and **proto**. Stock clients talk to it with no plugin and no special flag: `mvn`, Gradle, `npm`, `pnpm`, `yarn`, `bun`, `docker`, `podman`, `buildx` and `helm`, plus Weaver's own Gradle plugin and CLI for proto. One server, one web app, one sign-in.

This instance runs at `{{url}}`.

## Repositories

Everything lives in named **repositories**. A repository has one format and one kind:

| Kind | What it does |
| --- | --- |
| **Hosted** | Clients publish into it and read from it. It stores what you push. |
| **Mirror** | A read-only proxy of one or more upstream registries, such as Maven Central, `registry.npmjs.org` or Docker Hub. Upstreams are tried in order until one answers. |
| **Group** | One read URL in front of an ordered list of hosted and mirror repositories of the same format. The first member that has the item answers; Maven metadata and npm package documents are merged across members. |

Repository names are unique across all formats, because they appear in every URL. Admins create and configure repositories in the web app: see [Repositories](/docs/admin/repositories).

Two rules hold for every format:

- **Mirror caching is off by default.** A mirror then forwards each request upstream and stores nothing. Turn caching on per mirror to keep what was fetched and to serve it when the upstream is down.
- **Groups are read-only.** Publishing to a group is refused with the client's usual "not allowed" error. Publish to a hosted member instead.

## URLs

Every format lives on the same domain:

| Format | Client URL | Example |
| --- | --- | --- |
| Maven | `{{url}}/maven/<repo>/` | `{{url}}/maven/releases/` |
| npm | `{{url}}/npm/<repo>/` | `{{url}}/npm/npm-group/` |
| Docker/OCI | `{{host}}/<repo>/<image>:<tag>`, registry API under `{{url}}/v2/` | `{{host}}/apps/web:1.0` |
| proto | `{{url}}/api/v1/…`, with the repository names in the request | `repositories("releases")` in Gradle |

The browse page of every repository shows the client snippets filled in for that repository.

## Who can do what

- **People** sign in with GitHub or Discord and have one of three roles: `admin`, `maintainer` or `viewer`. Signed-in users can browse every repository in the web app. See [Users, roles and invites](/docs/admin/users).
- **Builds and clients** use **access tokens** (API keys). A token carries `read` or `write` access per repository; write includes read, and a token never does more than its owner's role allows. See [API keys and permissions](/docs/admin/keys).
- **Anonymous reads** work only on **public** repositories. Private repositories need a token with read access, and writing always needs a token with write access.
- **Read access to a group** grants reading everything served through it, also from private members. Give a build access to the group, not to each member.

## Clients

- **Maven and Gradle** (Java artifacts): [Maven and Gradle](/docs/maven).
- **npm, pnpm, yarn and bun**: [npm](/docs/npm).
- **docker, podman, buildx and helm**: [Docker and OCI](/docs/docker).
- **proto**: the [Gradle plugin](/docs/gradle) and the [Node CLI](/docs/cli).

## Proto artifacts

Proto is Weaver's own format for versioned bundles of `.proto` files. A team publishes its protos from Gradle; other projects fetch them, together with everything they import, into one folder, and code generation happens in their own build.

### Artifacts and coordinates

Each proto artifact has a Maven-style coordinate:

```text
dev.surf.economy:economy-contracts:1.4.0
group            name              version
```

- **group** is a reverse-DNS name such as `dev.surf.economy`. Segments of lowercase letters, digits and `_`, separated by dots; segments after the first may also contain `-`.
- **name** identifies the artifact inside the group, such as `economy-contracts`.
- **version** is a version number like `1.4.0`, optionally with a qualifier: `1.4.0-rc.1` or `1.4.0-SNAPSHOT`.

Each version stores its files under their import paths, for example `surf/economy/v1/money.proto`, so another artifact that depends on it can write `import "surf/economy/v1/money.proto";`.

Weaver compiles every upload together with its declared dependencies and rejects it if anything is wrong. A release never changes once published (unless the repository allows redeploy), while a `-SNAPSHOT` version can be published again and again while you iterate. See [Versions and snapshots](/docs/versions), [Dependencies and resolution](/docs/resolution) and [Validation on publish](/docs/validation).

## Where to go next

- New to this instance? Start with [Join an instance](/docs/join).
- Ready to ship protos? Read [Publish your first artifact](/docs/publish), then [Use protos in a project](/docs/consume).
- Running your own instance? Read [Docker Compose](/docs/self-host/compose).

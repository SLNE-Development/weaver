---
title: Configuration reference
description: Every environment variable, its default, and which service reads it.
section: Self-hosting
order: 3
---

Weaver is configured with environment variables only. The web app validates its variables when it starts and refuses to boot with a message that names the bad variables (never their values). Empty values count as unset.

**Reads** says which service uses a variable: `web` is the web app and REST API, `worker` the background worker. Both run from the same image.

## Database and queue

| Variable | Required | Reads | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | web, worker | PostgreSQL connection string, e.g. `postgres://weaver:<password>@postgres:5432/weaver`. |
| `VALKEY_URL` | worker: yes, web: no | worker, web | Valkey or Redis URL for the job queue, e.g. `redis://valkey:6379`. The worker refuses to start without it. The web app starts without it but needs it to queue cleanup runs (**Run now**). Valkey must use `maxmemory-policy noeviction`. |

## Storage

Weaver can use two stores at once: **local disk** and **S3**. Each is configured by environment variables only, and each is on when its variables are set:

- The local store is on when `STORAGE_LOCAL_PATH` is set. The image sets `/data/storage`, so it is always on in the published image.
- The S3 store is on when `S3_BUCKET` is set. Then `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are required too.

`STORAGE_DRIVER` names the **primary** store, which holds hosted content: everything published to a hosted repository. The primary store must be configured: otherwise the worker refuses to start and the web app fails its first request with `Missing required environment variable …`. The other store, if configured, is a **cache store** for mirrors: each mirror keeps its cache on the store chosen in its settings, or on **Default cache storage** from the admin settings, which defaults to the primary store. The settings page and the mirror form only offer stores that are configured. A mirror whose chosen store is no longer configured caches to the primary store.

| Variable | Required | Reads | Description |
| --- | --- | --- | --- |
| `STORAGE_DRIVER` | yes | web, worker | `local` or `s3`: the primary store, for hosted content. |
| `STORAGE_LOCAL_PATH` | with `local` | web, worker | Directory of the local store. The image sets `/data/storage`. Web and worker must see the same directory. |
| `S3_ENDPOINT` | no | web, worker | Endpoint URL of an S3-compatible store. Leave empty for AWS. When set, path-style addressing is used. |
| `S3_BUCKET` | with `s3` | web, worker | Bucket name. Setting it turns the S3 store on, also when it is not the primary. The bucket must exist. |
| `S3_REGION` | with `S3_BUCKET` | web, worker | Region, e.g. `us-east-1`. |
| `S3_ACCESS_KEY_ID` | with `S3_BUCKET` | web, worker | Access key. |
| `S3_SECRET_ACCESS_KEY` | with `S3_BUCKET` | web, worker | Secret key. |
| `WEAVER_DOCKER_UPLOAD_DIR` | no | web | Directory where Docker layer uploads are spooled before they are stored. Default: `weaver-uploads` in the system temp directory. Needs room for the largest layers you push. See [Docker Compose](/docs/self-host/compose#docker-registry-uploads). |

## Authentication

| Variable | Required | Reads | Description |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | yes | web, worker | Signs sessions and invite cookies, and is the key material for the encryption of stored upstream credentials. At least 32 characters; generate with `openssl rand -base64 48`. Changing it signs everyone out. |
| `BETTER_AUTH_URL` | yes | web | The public base URL, e.g. `{{url}}`. Must be **https** in production. See below. |
| `INITIAL_ADMIN` | first deploy | web | `github:<login>` or `discord:<user id>`. While no admin exists, that account may sign in and becomes admin. Ignored afterwards. |
| `GITHUB_CLIENT_ID` | one provider | web | GitHub OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | one provider | web | GitHub OAuth app secret. |
| `DISCORD_CLIENT_ID` | one provider | web | Discord application client id. |
| `DISCORD_CLIENT_SECRET` | one provider | web | Discord application secret. |

Each provider needs both its id and its secret, or neither. At least one provider must be complete; login is OAuth only. Only complete providers appear on the sign-in page.

### Upstream credentials

Mirrors can log in to their upstreams with Basic credentials or a bearer token. Weaver stores them encrypted with AES-256-GCM, under a key derived from `BETTER_AUTH_SECRET`. Rotating `BETTER_AUTH_SECRET` makes the stored upstream secrets unreadable: re-enter them in each mirror's settings afterwards.

### BETTER_AUTH_URL

`BETTER_AUTH_URL` is the only source of the public URL. It is used for:

- the OAuth callback URLs: `{{url}}/api/auth/callback/github` and `{{url}}/api/auth/callback/discord`,
- the trusted origin for sign-in requests,
- secure cookies (an `https://` URL turns on the `Secure` flag),
- the Docker token realm (`{{url}}/v2/token`) that registry clients log in at,
- every absolute URL the app produces: archive URLs in `/api/v1/resolve`, npm tarball URLs, invite links, snippets and these docs.

It is never derived from the request's `Host` or `X-Forwarded-*` headers or from a platform's service URL. `http://localhost:3000` is fine for development.

## Container

| Variable | Default | Reads | Description |
| --- | --- | --- | --- |
| `RUN_MIGRATIONS` | `true` for `web`, `false` for `worker` | entrypoint | Whether to apply database migrations before starting. |
| `PORT` | `3000` | web | Port the web app listens on inside the container. |

The image starts the web app by default. Pass `worker` as the command to start the worker. The built-in healthcheck follows the command: it calls `/api/health` on the web app and checks that the worker process is running.

## Compose files

| Variable | File | Description |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `docker-compose.prod.yml` | Password of the bundled Postgres, also used in its `DATABASE_URL`. Required. |
| `POSTGRES_USER`, `POSTGRES_DB` | `docker-compose.prod.yml` (`POSTGRES_DB` also `docker-compose.coolify.yml`) | User and database of the bundled Postgres. Default `weaver`. Only apply when the volume is first initialized, so an existing install keeps the names it was created with. |
| `WEAVER_IMAGE` | both | The image of `app`/`weaver` and `worker`. Default `ghcr.io/slne-development/weaver:latest`; set a version tag to pin a release. |
| `APP_PORT` | `docker-compose.prod.yml` | Host port for the web app. Default `3000`. |
| `SERVICE_FQDN_WEAVER_3000` | `docker-compose.coolify.yml` | Set by Coolify from the domain you assign. Routing only; the app never reads it. |
| `SERVICE_*` | `docker-compose.coolify.yml` | Generated by Coolify: database credentials, `BETTER_AUTH_SECRET`, SeaweedFS keys and admin login. |

In `docker-compose.coolify.yml`, `STORAGE_DRIVER` defaults to `s3` and the `S3_*` variables default to the bundled SeaweedFS. Setting `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` overrides the generated keys.

## Clients

These are read by the Gradle plugin and the CLI, not by the server.

| Variable | Description |
| --- | --- |
| `WEAVER_URL` | Server base URL, e.g. `{{url}}`. |
| `WEAVER_TOKEN` | API key, sent as `Authorization: Bearer <key>`. Only needed for private repositories and for publishing. The Maven, npm and Docker examples in these docs read the token from the same variable. |

See [Gradle plugin](/docs/gradle#environment-variables) and [Node CLI](/docs/cli).

## Example `.env`

```dotenv title=".env"
DATABASE_URL=postgres://weaver:change-me@postgres:5432/weaver
VALKEY_URL=redis://valkey:6379

STORAGE_DRIVER=local
STORAGE_LOCAL_PATH=/data/storage

BETTER_AUTH_SECRET=<openssl rand -base64 48>
BETTER_AUTH_URL={{url}}
INITIAL_ADMIN=github:<your login>

GITHUB_CLIENT_ID=<client id>
GITHUB_CLIENT_SECRET=<client secret>
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
```

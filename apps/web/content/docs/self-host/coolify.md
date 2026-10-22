---
title: Coolify
description: Deploy the Coolify compose file, set the public https BETTER_AUTH_URL behind a Cloudflare Tunnel, and register the OAuth apps.
section: Self-hosting
order: 2
---

The repository contains `docker-compose.coolify.yml`, made for Coolify's Docker Compose build pack. It runs everything Weaver needs, including S3 storage, and Coolify generates the passwords for you.

| Service | What it does |
| --- | --- |
| `weaver` | The web app, the REST API and the Maven, npm and Docker registries (port 3000). Applies database migrations on start. |
| `worker` | Background jobs: cleanup policies, mirror cache eviction, Docker garbage collection and usage statistics. Starts once `weaver` is healthy. |
| `postgres` | PostgreSQL 17. |
| `valkey` | Job queue for the worker. |
| `seaweedfs` | Bundled S3 storage. Internal only. |
| `seaweedfs-init` | One-shot container that creates the bucket. Safe on every redeploy. |
| `seaweedfs-admin` | The SeaweedFS admin panel, password protected. |

## 1. Create the resource

1. In Coolify, create a new resource from your Git repository (a fork or the Weaver repository).
2. Choose the **Docker Compose** build pack and set the compose file to `docker-compose.coolify.yml`.
3. Don't deploy yet.

## 2. Assign the domain

On the `weaver` service, set the domain people will open, for example `{{url}}`. Coolify stores it in `SERVICE_FQDN_WEAVER_3000` and routes traffic for it to port 3000.

Optionally give `seaweedfs-admin` its own domain (`SERVICE_FQDN_SEAWEEDFSADMIN_23646`). If you don't want the panel, delete the service from your copy of the compose file.

## 3. Set BETTER_AUTH_URL

In the **Environment Variables** tab, set `BETTER_AUTH_URL` to the public **https** URL, the same domain as above:

```dotenv
BETTER_AUTH_URL={{url}}
```

This is separate from the domain you assigned, on purpose. The service domain only tells Coolify's proxy where to route traffic. Behind a Cloudflare Tunnel, the URL Coolify knows is plain `http://`, while OAuth callbacks, secure cookies and every link Weaver produces must use `https://`. Weaver never derives its URL from the request or from `SERVICE_FQDN_*`; it uses `BETTER_AUTH_URL` only.

> [!WARNING]
> **Use https here, even if Coolify shows http.** With an `http://` value, sign-in cookies aren't marked secure and the OAuth callback URL won't match what you registered with GitHub or Discord.

## 4. Set the first admin and a provider

Still in **Environment Variables**:

| Variable | Value |
| --- | --- |
| `INITIAL_ADMIN` | `github:<your login>` or `discord:<your user id>`. Required for the first deploy; without it nobody can sign in. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | From your GitHub OAuth app. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | From your Discord application. |

Configure at least one complete provider pair. Coolify generates the rest: the Postgres user and password, `BETTER_AUTH_SECRET` (from `SERVICE_BASE64_64_BETTERAUTH`), the SeaweedFS S3 keys and the admin panel login (`SERVICE_USER_SEAWEEDFSADMIN`, `SERVICE_PASSWORD_SEAWEEDFSADMIN`, shown in the same tab).

## 5. Register the OAuth apps

Register these callback URLs with the providers you use:

| Provider | Callback URL |
| --- | --- |
| GitHub | `{{url}}/api/auth/callback/github` |
| Discord | `{{url}}/api/auth/callback/discord` |

They must start with exactly your `BETTER_AUTH_URL`. A mismatch shows up as a `redirect_uri` error on the provider's page. See [Troubleshooting](/docs/troubleshooting#oauth-callback-mismatch).

## 6. Deploy and sign in

Deploy. Coolify builds the image, starts Postgres, Valkey and SeaweedFS, waits for the bucket, runs the migrations in `weaver` and then starts the worker. `weaver` reports healthy once `/api/health` answers.

Open `{{url}}/login` and sign in with the `INITIAL_ADMIN` account. You are now admin. Create repositories and invite your team. You may remove `INITIAL_ADMIN` afterwards.

## Cloudflare Tunnel notes

- Point the tunnel's public hostname at Coolify's proxy, as for any other Coolify app.
- Keep **SSL/TLS** at the edge. The connection from the tunnel to Coolify may be http; `BETTER_AUTH_URL` still says https.
- Weaver ignores the `Host` and `X-Forwarded-*` headers when it builds URLs. Every URL comes from `BETTER_AUTH_URL`.
- Cloudflare limits request bodies to 100 MB on most plans. A Docker layer is pushed in one request, so `docker push` of a larger layer fails with `413`. Push large images through a second hostname that is **DNS-only** (unproxied, not through the tunnel) and points at your server, or keep layers below the limit.
- The npm browser login shows the client address from the rightmost `X-Forwarded-For` entry. Behind Cloudflare and Coolify's proxy there are two hops, so the page shows a proxy's address instead of the client's. See [Client addresses and X-Forwarded-For](/docs/self-host/compose#client-addresses-and-x-forwarded-for).

## Other storage

The bundled SeaweedFS is the default (`STORAGE_DRIVER=s3`). The local `storage-data` volume is configured too (`STORAGE_LOCAL_PATH=/data/storage`), so both stores are available: hosted content goes to the primary store named by `STORAGE_DRIVER`, and each mirror can keep its cache on either store. See [Storage](/docs/self-host/compose#storage).

**Dual storage.** To keep hosted content on the local volume and put only mirror caches on SeaweedFS, set `STORAGE_DRIVER=local` and keep the SeaweedFS services. Then pick **S3** as **Default cache storage** in the admin settings, or per mirror.

The `seaweedfs`, `seaweedfs-init` and `seaweedfs-admin` services always start, whatever `STORAGE_DRIVER` says, and `weaver` waits for `seaweedfs-init`. To use only local storage or an external S3 instead:

1. For an external S3, set `STORAGE_DRIVER=s3` with `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. For local storage only, set `STORAGE_DRIVER=local` and, in your copy of `docker-compose.coolify.yml`, change the `S3_BUCKET` line under `x-weaver-env` to `S3_BUCKET: ""`, so no S3 store is configured.
2. In your copy of `docker-compose.coolify.yml`, delete the `seaweedfs`, `seaweedfs-init` and `seaweedfs-admin` services, the `seaweedfs-init` entry under `weaver` → `depends_on`, and the `seaweedfs-data` and `seaweedfs-admin-data` volumes.

With local storage only, everything goes to the `storage-data` volume.

## Upgrade

Redeploy the resource. The new `weaver` container applies migrations before serving, and the worker waits for it. Back up the `postgres-data`, `seaweedfs-data` and `storage-data` volumes first. Read the [release notes](/docs/self-host/compose#upgrade) for changes in behaviour.

## Upgrading from Protoloom

Weaver was called Protoloom before. Upgrading keeps users and logins and drops repositories, artifacts, API keys, invites and cleanup policies; recreate your repositories and keys afterwards. See [Docker Compose](/docs/self-host/compose#upgrading-from-protoloom).

The Postgres volume of an existing install was initialized with the database `protoloom`, and `POSTGRES_DB` only applies on first init. Before you redeploy, set the environment variable `POSTGRES_DB=protoloom` on the resource so the existing database, and your users with it, is kept. A fresh install uses `weaver`.

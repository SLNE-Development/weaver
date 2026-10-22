---
title: Docker Compose
description: Run the web app, worker, Postgres and Valkey from one compose file, put nginx or Caddy in front, store files on a volume and S3, and upgrade safely.
section: Self-hosting
order: 1
---

Weaver ships as one Docker image, `ghcr.io/slne-development/weaver`. The same image runs the web app (`web`) and the background worker (`worker`). The repository's `docker-compose.prod.yml` wires them up with PostgreSQL and Valkey.

You need Docker with Compose, a domain with HTTPS in front of the server, and a GitHub or Discord OAuth app.

## 1. Get the compose file

```sh
git clone https://github.com/SLNE-Development/weaver.git
cd weaver
cp .env.example .env
```

`docker-compose.prod.yml` runs four services:

| Service | What it does |
| --- | --- |
| `app` | The web app, the REST API and the Maven, npm and Docker registries on port 3000. Applies database migrations on start. |
| `worker` | Background jobs: cleanup policies (daily and on demand), mirror cache eviction, Docker garbage collection and usage statistics. Starts once `app` is healthy. |
| `postgres` | PostgreSQL 17, data in the `postgres-data` volume. |
| `valkey` | Job queue for the worker, data in the `valkey-data` volume. |

Stored files (hosted artifacts and mirror caches) go to the `storage-data` volume, shared by `app` and `worker`, unless you add S3 (see [Storage](#storage)).

## 2. Fill in `.env`

Set at least these:

```dotenv title=".env"
POSTGRES_PASSWORD=<a long random password>
BETTER_AUTH_SECRET=<output of: openssl rand -base64 48>
BETTER_AUTH_URL={{url}}
INITIAL_ADMIN=github:<your GitHub login>
GITHUB_CLIENT_ID=<from your GitHub OAuth app>
GITHUB_CLIENT_SECRET=<from your GitHub OAuth app>
```

- `BETTER_AUTH_URL` is the public **https** URL people open. It is used for OAuth callbacks, secure cookies, the Docker token realm and every link the app produces, and is never taken from the request.
- `INITIAL_ADMIN` is required on a fresh instance. Without it nobody can sign in. See [Users, roles and invites](/docs/admin/users#the-first-admin).
- Configure at least one OAuth provider, GitHub or Discord, with both its id and secret. The app refuses to start otherwise.

Every variable is listed in the [Configuration reference](/docs/self-host/config).

## 3. Register the OAuth app

Create an OAuth app with your provider and set its callback URL:

| Provider | Where | Callback URL |
| --- | --- | --- |
| GitHub | Settings → Developer settings → OAuth Apps | `{{url}}/api/auth/callback/github` |
| Discord | Developer Portal → Applications → OAuth2 | `{{url}}/api/auth/callback/discord` |

Copy the client id and secret into `.env`.

## 4. Start the stack

```sh
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

This runs the published image `ghcr.io/slne-development/weaver:latest`. Set `WEAVER_IMAGE` in `.env` to pin a release, for example `WEAVER_IMAGE=ghcr.io/slne-development/weaver:0.1.0`, so upgrades happen only when you choose. To build the image from the checked-out source instead, run `docker compose -f docker-compose.prod.yml up -d --build`.

The app is healthy once `GET /api/health` answers. Check with:

```sh
docker compose -f docker-compose.prod.yml ps
```

## 5. Put a reverse proxy in front

The app listens on plain HTTP on port 3000 (`APP_PORT` changes the host port). Put a TLS-terminating reverse proxy in front of it, such as Caddy, nginx, Traefik or a Cloudflare Tunnel, and point your domain at it. `BETTER_AUTH_URL` must be that public https URL.

With the proxy on the same host, publish the port on localhost only, so the app can't be reached around the proxy: change the `app` ports entry to `"127.0.0.1:${APP_PORT:-3000}:3000"`.

Serve Weaver at the root of its domain and pass every path through. The registries live at `/v2/` (Docker), `/maven/` and `/npm/`, next to the web app and `/api/`. Docker clients always call `/v2/` at the root of the host, so a sub-path such as `https://example.com/weaver/` does not work.

Uploads can be large: a Docker layer or a Maven artifact may be several GB, and a single request carries it. The proxy must not limit or buffer request bodies, and must allow long transfers. Otherwise `docker push` or `mvn deploy` fails with `413 Request Entity Too Large` or a timeout.

### Caddy

Caddy needs no body-size setting: it has no request body limit and streams requests and responses by default.

```text title="Caddyfile"
{{host}} {
    reverse_proxy 127.0.0.1:3000
}
```

### nginx

nginx limits request bodies to 1 MB and buffers them by default. Turn both off for Weaver:

```nginx title="/etc/nginx/conf.d/weaver.conf"
server {
    listen 443 ssl;
    server_name {{host}};
    # ssl_certificate and ssl_certificate_key as usual

    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 900s;
    proxy_send_timeout 900s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`client_max_body_size 0` removes the size limit, `proxy_request_buffering off` streams uploads to Weaver instead of spooling them first, `proxy_buffering off` streams downloads, and the timeouts allow long pushes and pulls of big layers.

### Cloudflare

Cloudflare limits request bodies to 100 MB on most plans, and a Docker layer larger than that is pushed in one request. Push large images through a DNS-only (unproxied) hostname that points at your server, or keep them below the limit.

### Client addresses and X-Forwarded-For

Weaver builds no URL from request headers; every URL comes from `BETTER_AUTH_URL`. It reads one forwarded header: the npm browser login shows the address of the machine that started the login, taken from the **rightmost** `X-Forwarded-For` entry, so you can refuse a login you did not start. See [npm](/docs/npm#log-in).

That address is only right with **exactly one trusted proxy hop** in front of Weaver, and that proxy must **overwrite** `X-Forwarded-For` with the address it sees, not pass on what the client sent. Caddy does this by default for clients outside its `trusted_proxies`. In nginx, set `proxy_set_header X-Forwarded-For $remote_addr;` as above.

With two hops, such as Cloudflare in front of nginx or Coolify's proxy, the rightmost entry is the address of the outer proxy, not the client's. Let the inner proxy recover the client address first (for nginx behind Cloudflare: `set_real_ip_from` with Cloudflare's ranges and `real_ip_header CF-Connecting-IP;`), then overwrite the header with it. Never let clients reach port 3000 directly, or they can send any address they like.

### Docker needs HTTPS

Docker, podman and containerd talk to a registry over HTTPS only, except on `localhost`. Behind an https proxy this just works. A Weaver reachable only over plain http (on a LAN, say) needs every client daemon to list it under `insecure-registries`, or pushes fail with `http: server gave HTTP response to HTTPS client`:

```json title="/etc/docker/daemon.json"
{
  "insecure-registries": ["{{host}}"]
}
```

### Docker Hub pull-through

With a [root mirror](/docs/docker#root-mirror-and-registry-mirrors) set up, a Docker daemon can pull Docker Hub images through Weaver. Add Weaver to the daemon's mirrors and restart the daemon:

```json title="/etc/docker/daemon.json"
{
  "registry-mirrors": ["{{url}}"]
}
```

The entry is the scheme and host with no path. An `http://` mirror only works when the same host is also listed under `insecure-registries`.

## 6. Sign in as the first admin

Open `{{url}}/login` and sign in with the account from `INITIAL_ADMIN`. You become `admin`. Then:

1. Create your repositories: [Repositories](/docs/admin/repositories).
2. Invite your team: [Users, roles and invites](/docs/admin/users#invite-someone).
3. Optionally remove `INITIAL_ADMIN` from `.env`. It is ignored once an admin exists.

Each format's client URL:

| Format | URL |
| --- | --- |
| Maven | `{{url}}/maven/<repo>/` |
| npm | `{{url}}/npm/<repo>/` |
| Docker | `{{host}}/<repo>/<image>:<tag>` |
| proto | `{{url}}`, with the repository names in the Gradle plugin or CLI config |

## Storage

Weaver has two stores, both configured by environment variables only:

- **Local disk**, the directory `STORAGE_LOCAL_PATH`. The image sets `/data/storage`, the `storage-data` volume.
- **S3**, any S3-compatible bucket, configured by the `S3_*` variables. A non-empty `S3_BUCKET` turns it on.

`STORAGE_DRIVER` names the **primary** store, where hosted content goes. Mirror caches go to the store the mirror picks, or to **Default cache storage** in the admin settings, which defaults to the primary store. The settings page and the mirror form only offer stores that are configured. See [Configuration reference](/docs/self-host/config#storage).

To keep hosted artifacts on the local volume and put mirror caches on S3, set in `.env`:

```dotenv title=".env"
STORAGE_DRIVER=local
S3_ENDPOINT=https://s3.example.net   # leave empty for AWS
S3_BUCKET=weaver
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
```

Then choose **S3** as the default cache storage, or per mirror. To keep everything on S3 instead, set `STORAGE_DRIVER=s3` with the same variables.

With `S3_ENDPOINT` set, path-style addressing is used, which works with MinIO, SeaweedFS, Garage and most other providers. Create the bucket before you start. To run SeaweedFS next to Weaver, copy the `seaweedfs` and `seaweedfs-init` services from `docker-compose.coolify.yml`.

## Docker registry uploads

Docker layers are spooled to a temporary file on the `app` container before they are stored, so the upload directory needs room for the largest layers you push. Mount a volume there and point `WEAVER_DOCKER_UPLOAD_DIR` at it:

```yaml title="compose.override.yml"
services:
  app:
    environment:
      WEAVER_DOCKER_UPLOAD_DIR: /uploads
    volumes:
      - docker-uploads:/uploads
volumes:
  docker-uploads:
```

Start with `docker compose -f docker-compose.prod.yml -f compose.override.yml up -d`. Without it, uploads go to `weaver-uploads` in the container's temp directory. Leftover files of abandoned uploads are removed automatically. See [Docker and OCI](/docs/docker) for the clients, and [the reverse proxy section](#put-a-reverse-proxy-in-front) for body size limits.

## Back up

Back up two things:

- **The database.** `docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U weaver weaver > weaver.sql`
- **The stored files.** The `storage-data` volume, and your S3 bucket if you use one.

The database holds users, keys, repositories and the index of every stored file; the stores hold the files clients download. Restore both from the same point in time. Mirror caches can be left out: a lost cache is fetched again from the upstream.

## Upgrade

1. Back up, as above.
2. Get the new version: change `WEAVER_IMAGE` and run `docker compose -f docker-compose.prod.yml pull`, or `git pull` when you build from source.
3. Run `docker compose -f docker-compose.prod.yml up -d` (add `--build` when you build from source).

The `app` container applies pending database migrations before it starts serving, and `worker` waits until `app` is healthy. To skip migrations on a start, set `RUN_MIGRATIONS=false` on the `app` service.

Release notes that change behaviour:

- **Cleanup policies apply to hosted repositories only.** Proto mirrors are no longer cleaned by cleanup policies; a mirror's cache is trimmed by its eviction settings (max age and max size). See [Cleanup policies](/docs/admin/cleanup#mirrors-and-groups).

## Logs

```sh
docker compose -f docker-compose.prod.yml logs -f app worker
```

The image runs as the unprivileged `node` user. The worker logs `weaver-worker: processing cleanup jobs` when it is ready.

## Upgrading from Protoloom

Weaver was called Protoloom before. Upgrading keeps users and logins and drops repositories, artifacts, API keys, invites and cleanup policies. Users keep their OAuth logins and roles, and the server settings and audit log stay; everything published to Protoloom is gone from the database. Recreate your repositories and keys after the first start, and publish again what you need.

The Postgres volume of an existing install was initialized with the database `protoloom` and the user `protoloom`, and `POSTGRES_DB` and `POSTGRES_USER` only apply on first init. To keep that database, and your users with it, add these to `.env` before you start the new version:

```
POSTGRES_DB=protoloom
POSTGRES_USER=protoloom
```

A fresh install uses `weaver` for both.

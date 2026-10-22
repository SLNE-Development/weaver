---
title: Troubleshooting
description: Fix the common failures, including 401 and 403, 413 from a proxy, Docker without TLS, 502 from mirrors, invites that don't work, OAuth callback mismatches and storage errors.
section: Help
order: 1
---

Find the message you see, then follow the fix. Gradle prints server errors as `<code>: <message>`, the CLI as `error: <message>`. Every code is listed in the [REST API](/docs/api#errors) reference.

## 401 or 403 from Gradle or the CLI

| Message | Cause | Fix |
| --- | --- | --- |
| `unauthorized: Publishing requires an API key` | No token was sent. | Export `WEAVER_TOKEN`, or set `weaver.token`. In CI, check the secret is passed into the step's environment. |
| `unauthorized: Invalid API key` | The key is wrong, expired or revoked, or its owner was banned or removed. | Create a new key under **API keys** and replace the secret. |
| `forbidden: No write access to <group> in <repository>` | The key can read the repository but has no `write` entry covering the group. | Add a `write` entry for that repository with a group prefix that covers the group. Check the prefix: `dev.surf` covers `dev.surf.economy` but not `dev.surfboard`. |
| `forbidden: …` although the key has `write` | The key's owner is a `viewer`. Keys can't do more than their owner's role allows. | Ask an admin to make the owner a `maintainer`, or create the key from a maintainer account. |
| `not_found: Repository <name> was not found` | The repository doesn't exist, or the key has no entry for it. Private repositories you can't read look missing. | Check the spelling in `repositories(...)`/`publishing.repository`, then the key's entries. |
| `unauthorized` even for a public repository | A stale or empty token is sent. A bad token is rejected even where no token is needed. | Unset `WEAVER_TOKEN`, or fix it. |

To check a key quickly:

```sh
curl -i -X POST {{url}}/api/v1/resolve \
  -H "Authorization: Bearer $WEAVER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repositories":["releases"],"dependencies":[]}'
```

`200` with `{"artifacts":[],"conflicts":[]}` means the key is valid.

## "No Weaver server URL configured"

Gradle couldn't find a URL. Set `WEAVER_URL={{url}}`, or `weaver { url = "…" }`. The CLI says `No registry url: set WEAVER_URL or url in the config file`.

## "Could not reach" or a timeout

`Weaver publish failed: could not reach …` (Gradle) or `Cannot reach …` / `Request to … timed out after 60s` (CLI). Check the URL, your network or VPN, and that the server is up: `{{url}}/api/health` should answer.

## Publishing fails

| Message | Fix |
| --- | --- |
| `immutable: … already exists in … and releases are immutable` | Bump the version, or use a `-SNAPSHOT` version while iterating. See [Versions and snapshots](/docs/versions). |
| `has_dependents: … is depended on by N version(s)` | A redeploy of a release others use. Publish a new version instead. |
| `invalid_request: Repository … does not accept snapshots` (or releases) | Publish snapshots to the snapshot repository: set `publishing.snapshotRepository`. |
| `validation_failed: Proto validation failed` | A compile error or an import that no declared dependency provides. See [Validation on publish](/docs/validation). |
| `validation_failed: Dependency not found: …` | The dependency isn't published in any repository your key can read. Publish it first, or give the key read access. |
| `validation_failed: A release may not depend on snapshot …` | Release the dependency first. |
| `No .proto files found in …` | Your files aren't under `src/main/proto`. Move them or set `publishing.source`. |
| `weaver.publishing.<option> is not set.` | Add the option to the `publishing` block. `version` comes from `project.version` when that is set. |
| `payload_too_large: …` | Over 10 MiB, 1000 files or 1 MiB per file. Split the artifact. |

## Fetching fails

| Message | Fix |
| --- | --- |
| `not_found: Dependency … was not found` | The coordinate isn't in any listed repository you can read. Check the version, add the repository to your list, or use a key with read access. |
| `File … is provided by both … and …` / `Path "…" is provided by both …` | Two artifacts contain the same file. See [Dependencies and resolution](/docs/resolution#provided-by-both-errors). |
| `weaver.repositories is empty` | Add `repositories("…")` to the `weaver` block. |
| `… exists and wasn't created by weaver` (CLI) | `outDir` points at an existing folder the CLI didn't create. Choose another `outDir` or delete the folder. |
| `Checksum mismatch for …` | The download was corrupted or changed on the way. Run again; if it persists, check proxies between you and the server. |
| `warning: Version conflict: …` | Not an error. Two artifacts ask for different versions; the highest wins. |

## Mirrors

### Mirror loop detected

Mirrors forward requests to each other and the hop count (`x-weaver-hops`) passed 4. Weaver then answers `404 not_found` with the message `Mirror loop detected`, so clients report the artifact as missing. Check the upstream URLs for a cycle, such as A mirroring B while B mirrors A, and point one of them at a hosted repository.

### 502 upstream_unavailable

A mirror answers HTTP `502` when no upstream gave a usable answer (network errors, timeouts, `5xx` or `429`) and it has no cached copy. A Docker mirror whose upstreams only answered `429` passes that on as `429 TOOMANYREQUESTS` instead. With caching on, content the mirror already cached is still served, even after its metadata TTL expired.

The Gradle plugin prints `upstream_unavailable: Upstream of <mirror> did not answer`, the `weaver` CLI `error: Upstream of <mirror> did not answer`. Maven, npm and Docker clients report the HTTP status `502` (Docker with the code `UNAVAILABLE`).

Check the upstream URL and credentials in the mirror's settings, and that the upstream is up. Turn on caching to keep serving what was fetched once. A group answers `502` too when a member failed and no other member has the item, because the item may exist on the member that could not answer.

### Other mirror and group messages

| Message | Cause | Fix |
| --- | --- | --- |
| `method_not_allowed` when publishing | The target is a group or a mirror, which are read only. | Publish to a hosted repository. |
| `npm ERR! code E405` (newer npm: `npm error code E405`) on `npm publish` | The registry in `.npmrc` or `publishConfig` is a group or a mirror. | Publish to a hosted repository: set `publishConfig.registry` to `{{url}}/npm/<hosted repo>/`. See [npm](/docs/npm#publish-dist-tags-deprecate-and-unpublish). |
| `405` from `mvn deploy` or Gradle `publish` | The repository URL is a group or a mirror. | Deploy to a hosted repository. See [Maven and Gradle](/docs/maven#errors). |
| `validation_failed: Dependency not found: …` although a mirror has it | Publishing never consults mirrors. | Publish the dependency into a hosted repository first. |

## Uploads and the reverse proxy

### 413 Request Entity Too Large

`docker push` retries and fails, `mvn deploy` reports `status code: 413`, or `npm publish` fails with `E413`. The `413` comes from your reverse proxy, not from Weaver: its request body limit is smaller than the upload. nginx allows 1 MB by default and Cloudflare 100 MB.

- nginx: set `client_max_body_size 0;` and `proxy_request_buffering off;`.
- Cloudflare: push large Docker layers through a DNS-only (unproxied) hostname.

See [Put a reverse proxy in front](/docs/self-host/compose#put-a-reverse-proxy-in-front). An npm publish is also limited by Weaver itself to 256 MiB per request.

### http: server gave HTTP response to HTTPS client

Docker, podman or containerd talk to a registry over HTTPS only, except on `localhost`, and Weaver answered on plain http. Put an https reverse proxy in front of Weaver, or add the host to `insecure-registries` in `/etc/docker/daemon.json` on every client and restart the daemon. A plain-http entry in `registry-mirrors` needs the same `insecure-registries` entry. See [Docker needs HTTPS](/docs/self-host/compose#docker-needs-https).

## Invite not working

| What you see | Cause | Fix |
| --- | --- | --- |
| "You need an invite to join this Weaver." after signing in | The invite wasn't remembered by your browser: more than 15 minutes passed since you opened the link, you used another browser or a private window, or cookies are blocked. | Open the invite link again in the same browser and sign in right away. |
| The invite page says the invite is expired or used | Invites work once and expire after 1 to 30 days. | Ask an admin for a new invite. |
| "You need an invite …" when signing in with your second provider | You never connected that provider. Weaver doesn't link accounts by email. | Sign in with the provider you joined with and connect the other one on **Account**. See [Join an instance](/docs/join#connect-a-second-provider). |
| Nobody can sign in to a new instance | No admin exists and `INITIAL_ADMIN` isn't set or doesn't match. | Set `INITIAL_ADMIN=github:<login>` or `discord:<user id>` and restart. See [The first admin](/docs/admin/users#the-first-admin). |

## OAuth callback mismatch

GitHub shows "The redirect_uri is not associated with this application", or Discord shows "Invalid OAuth2 redirect_uri".

The callback URL Weaver sends is built from `BETTER_AUTH_URL`. It must match the one registered with the provider exactly, including `https`, the host, the port and no trailing slash:

- GitHub: `{{url}}/api/auth/callback/github`
- Discord: `{{url}}/api/auth/callback/discord`

Common causes:

- `BETTER_AUTH_URL` is `http://…` behind a proxy or Cloudflare Tunnel. Set it to the public `https://` URL. See [Coolify](/docs/self-host/coolify#set-better_auth_url).
- The OAuth app was registered for another domain, or for `localhost` during testing.
- `BETTER_AUTH_URL` has a path or a different subdomain than the one people open.

If sign-in completes but you land signed out, the cookie was rejected: the site was opened on a different host than `BETTER_AUTH_URL`, or `BETTER_AUTH_URL` is https but the site is opened over http.

## The app doesn't start

The web app checks its configuration on start and logs `Invalid environment variables: …` with the names of the problems:

- `configure at least one OAuth provider (GitHub or Discord); login is OAuth only`: set one complete pair.
- `GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together` (or the Discord pair): set both or neither.
- `INITIAL_ADMIN: must be github:<login> or discord:<user id>`: fix the format.
- `BETTER_AUTH_SECRET`: at least 32 characters.

The worker exits at start when `VALKEY_URL` or `DATABASE_URL` is missing.

## Storage errors

| Message | Fix |
| --- | --- |
| `Missing required environment variable STORAGE_LOCAL_PATH` (worker or first request) | With `STORAGE_DRIVER=local`, set the path (the image uses `/data/storage`) and mount a volume there. |
| `Missing required environment variable S3_BUCKET` (or `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) | Set every `S3_*` variable for `STORAGE_DRIVER=s3`. |
| `Invalid environment variables: STORAGE_DRIVER: …` (web) or `Invalid or missing STORAGE_DRIVER` | Use `local` or `s3`. |
| Publishes fail with `internal_error` and the log shows `NoSuchBucket` | Create the bucket. On Coolify, check that `seaweedfs-init` completed. |
| `Archive blob … is missing from storage` in the log | The database points at an archive the store doesn't have: storage was reset or web and worker use different volumes. Restore the storage backup that matches the database. |
| `EACCES` writing to `/data/storage` | The container runs as `node` (uid 1000). Make the mounted directory writable for it. |

## Cleanup doesn't delete anything

- Check the worker is running: `docker compose logs worker` should show `processing cleanup jobs`.
- Use **Preview** on the repository's settings page. If it lists nothing, the rules don't match: releases are only deleted by a "not downloaded" rule with **Include releases**, the newest snapshot build is always kept, and anything a remaining version depends on is kept. See [Cleanup policies](/docs/admin/cleanup#what-is-never-deleted).

---
title: npm
description: Configure npm, pnpm, yarn and bun for Weaver, log in from the browser, publish, tag, deprecate and unpublish packages, and use npm mirrors and groups.
section: Clients
order: 3
---

Weaver serves npm repositories at `{{url}}/npm/<repo>/`. Stock `npm`, `pnpm`, `yarn` and `bun` talk to them with only a `registry` setting and a token; no plugin and no flag are needed. The Maven and Gradle side is described in [Maven and Gradle](/docs/maven).

A repository is one of three kinds:

- **Hosted.** You publish packages to it and install from it.
- **Mirror.** A read-only proxy of an upstream registry such as `registry.npmjs.org`. Mirror caching is off by default.
- **Group.** A read-only view over several hosted and mirror repositories.

## Configure the registry

Put the registry and a token in the project's config file. The token is read from the `WEAVER_TOKEN` environment variable (see [API keys and permissions](/docs/admin/keys) for creating one). Public repositories can be read without a token; publishing always needs one.

### npm, pnpm and yarn classic

In `.npmrc`:

```ini
registry={{url}}/npm/npm-group/
//{{host}}/npm/npm-group/:_authToken=${WEAVER_TOKEN}
```

To send only one scope to Weaver and keep everything else on the default registry, scope the first line:

```ini
@acme:registry={{url}}/npm/npm-group/
//{{host}}/npm/npm-group/:_authToken=${WEAVER_TOKEN}
```

pnpm and yarn classic read the same `.npmrc`. Yarn classic sends the token for unscoped packages only when `always-auth` is set, so for a private repository add this line too (npm warns that it does not know the key, and ignores it):

```ini
//{{host}}/npm/npm-group/:always-auth=true
```

### yarn berry

In `.yarnrc.yml`:

```yaml
npmRegistryServer: "{{url}}/npm/npm-group/"
npmAuthToken: "${WEAVER_TOKEN}"
npmAlwaysAuth: true
```

For one scope only:

```yaml
npmScopes:
  acme:
    npmRegistryServer: "{{url}}/npm/npm-group/"
    npmAuthToken: "${WEAVER_TOKEN}"
    npmAlwaysAuth: true
```

Without `npmAlwaysAuth`, yarn berry sends the token only for scoped packages and every unscoped install from a private repository fails with `Invalid authentication`. On a plain-http address other than `localhost`, yarn berry also needs the host in `unsafeHttpWhitelist`.

### bun

In `bunfig.toml`:

```toml
[install]
registry = { url = "{{url}}/npm/npm-group/", token = "$WEAVER_TOKEN" }
```

For one scope only:

```toml
[install.scopes]
acme = { url = "{{url}}/npm/npm-group/", token = "$WEAVER_TOKEN" }
```

The browse page of every npm repository shows these snippets filled in for that repository.

## Log in

There are three ways to authenticate.

**Browser login (`npm login`).** `npm login --registry={{url}}/npm/<repo>/` opens a page on `{{url}}` where you sign in to Weaver and approve the request. npm then receives a new access token and stores it in your `.npmrc`. The approval page shows the address of the machine that started the login and its user agent, so you can refuse a login you did not start. Approve only logins you recognise.

The address is the rightmost entry of the `X-Forwarded-For` header. It is the client's address only when exactly one trusted reverse proxy sits in front of Weaver and that proxy overwrites `X-Forwarded-For` with the address it sees. Behind two proxies (Cloudflare in front of nginx, say) it is the outer proxy's address, and without a proxy that overwrites the header a client can put any address there, which makes the check worthless. See [Client addresses and X-Forwarded-For](/docs/self-host/compose#client-addresses-and-x-forwarded-for). A login session is valid for 10 minutes, and only a limited number can be pending at once.

**Token as password (`yarn npm login`).** Yarn berry and other clients that ask for a username and password accept any username and an access token as the password.

**Token from the keys page.** Create a token on the keys page and put it in `WEAVER_TOKEN`, as in the snippets above. This is the way to authenticate CI.

`npm whoami --registry={{url}}/npm/<repo>/` prints the owner of the token.

## Publish, dist-tags, deprecate and unpublish

All of these need a token with write access to a hosted repository. Groups and mirrors are read-only and answer `405` to a write.

```sh
npm publish --registry={{url}}/npm/releases/
```

Scoped and unscoped packages both work. A published version never changes: publishing a version that exists, or one that was ever published and unpublished, fails with `409`. To fix a mistake, publish a new version.

Dist-tags work as with any registry:

```sh
npm dist-tag add my-package@1.2.0 next
npm dist-tag ls my-package
npm dist-tag rm my-package next
```

Deprecate a version, or clear the notice with an empty message:

```sh
npm deprecate my-package@1.1.0 "use 1.2.0, 1.1.0 loses data"
npm deprecate my-package@1.1.0 ""
```

Unpublish removes a version, or the whole package with `--force`:

```sh
npm unpublish my-package@1.1.0
npm unpublish my-package --force
```

An unpublished version leaves a tombstone in the package's history, so its number can never be reused (the no-republish rule). Tags that pointed at the version are dropped and `latest` moves to the highest remaining version. Unpublishing the whole package frees the name.

## Mirrors and groups

**Tarball URLs.** Every package document Weaver serves points its tarballs back at Weaver (`{{url}}/npm/<repo>/<name>/-/<file>`), also when it comes from a mirror. Lockfiles therefore resolve through Weaver and keep working.

**Caching.** A mirror proxies the upstream registry. With caching off it stores nothing and every request goes upstream; with caching on it keeps the tarballs it served and the metadata for a while, and serves the stored copy when the upstream cannot be reached. Browsing a mirror lists only what Weaver has stored; the rest lives upstream.

**Groups.** A group lists its members in order. The earlier member wins: for a package, a version or a tarball, the first member that has it answers. If a member fails (for example an unreachable upstream) and no member has the package, the group answers `502` instead of `404`, because the package may exist on the member that could not answer. Read permission on a group grants reading everything served through it.

**Search.** `npm search` finds packages that Weaver stores. It does not search the upstream registry behind a mirror.

**Audit.** `npm audit` is sent to the repository. A hosted repository knows no advisories and reports none. A mirror forwards the request to its upstream, so the upstream learns the package names in your dependency tree. A group forwards it to its first mirror member, or reports none when it has no mirror member. To keep private names private, Weaver removes names before forwarding: names that the mirror's rules exclude, and in a group the names served by hosted members.

The audit fails with `502` instead of reporting a clean result in two cases:

- **The upstream audit failed.** The upstream could not be reached, timed out or answered with an error, so the answer is `502 upstream_unavailable`. A broken upstream never reads as "no advisories". An offline mirror, or one whose upstreams all answer `404`, reports none.
- **The tree cannot be filtered.** The full and quick audits (`audits` and `audits/quick`, used by older npm versions) send the whole dependency tree. Weaver does not forward them from a mirror with allow or deny rules, or from a group with hosted members or with such a mirror member. Current npm uses the bulk advisory endpoint, which Weaver filters.

## Limits

A publish request, which carries the tarball as base64 inside JSON, may be at most 256 MiB.

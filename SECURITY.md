# Security policy

## Reporting a vulnerability

Please don't open a public issue for security problems. Report them privately through
[GitHub's private vulnerability reporting](https://github.com/SLNE-Development/weaver/security/advisories/new).

Include what you found, how to reproduce it, and which version or commit you tested. We'll confirm
receipt, keep you updated while we work on a fix, and credit you in the advisory if you'd like.

## Supported versions

Security fixes go into the latest release. Run the newest `ghcr.io/slne-development/weaver` image,
the newest `@slne/weaver-cli` CLI and the newest `dev.slne.weaver` Gradle plugin.

## Scope

In scope is everything in this repository: the web app, the REST API and the Maven, npm, Docker/OCI and
proto registries, the worker, the CLI, the Gradle plugin, the Docker image and the compose files. We are
especially interested in:

- **Access tokens and sessions.** A token used beyond the read or write access it carries per repository, or
  beyond its owner's role; a revoked or expired token that keeps working (Docker registry tokens live up to
  5 minutes by design); sign-in, invite or npm browser-login flows that grant access to the wrong account.
- **Upstream credentials.** Mirror credentials are encrypted at rest with AES-256-GCM under a key derived
  from `BETTER_AUTH_SECRET`. Reports of them leaking in plain text, to clients, into logs, or to an upstream
  they don't belong to are in scope.
- **Anonymous access.** Requests without a token may only read public repositories. Any way to read a private
  repository, to read a private group member other than through a group you may read, or to write without a
  token with write access.
- **Mirrors as a request forwarder.** A mirror fetches from the upstream URLs an admin configured. Ways to make
  Weaver send requests elsewhere (SSRF-style issues), to send client credentials upstream, or to make a
  response point clients at another host are in scope.
- **Storage and parsing.** Path traversal, reading or overwriting other repositories' content, and archives,
  manifests or package documents that crash or exhaust the server.

Out of scope:

- Content served by upstream registries (Maven Central, registry.npmjs.org, Docker Hub and others) through a
  mirror. Weaver passes it on as it is; report malicious packages to the upstream registry.
- Problems that need admin access, or control over the server's environment variables, to exploit.
- Deployments that ignore the documented setup, for example without HTTPS or with the app port reachable
  around the reverse proxy.

---
title: Node CLI
description: Set up weaver.json, run weaver fetch from a pnpm script or CI, and understand the cache and the output folder.
section: Clients
order: 2
---

The `weaver` CLI fetches proto dependencies into a folder for Node and TypeScript projects. It doesn't publish; publishing happens from Gradle. It needs Node 22 or newer.

## Install

Add it to the project, so every developer and CI run uses the same version:

```sh
pnpm add --save-dev @slne/weaver-cli
```

Or run it once without installing: `npx @slne/weaver-cli fetch`.

## `weaver.json`

```json title="weaver.json"
{
  "url": "{{url}}",
  "repositories": ["releases", "snapshots"],
  "dependencies": [
    "dev.surf.economy:economy-contracts:1.4.0",
    "dev.surf.common:common-types:2.1.0-SNAPSHOT"
  ],
  "outDir": "./protos"
}
```

An entry can also be a mirror or a group, which searches its members in order:

```json title="weaver.json"
{ "repositories": ["proto-all"] }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `url` | no | Server base URL. `WEAVER_URL` overrides it. One of the two must be set. |
| `repositories` | yes | Repositories to search, in order. |
| `dependencies` | yes | Exact coordinates `group:name:version`. Their dependencies are fetched too. |
| `outDir` | no | Output folder, relative to the current directory. Default `protos`. |

Unknown fields are ignored. A wrong type fails with `Invalid config <absolute path to the config file>: …` and names the field.

## Run it

```sh
weaver fetch
```

```text
Fetched 12 file(s) from 3 artifact(s)
```

| Option | Meaning |
| --- | --- |
| `--config <file>` | Config file. Default `weaver.json` in the current directory. |
| `--out <dir>` | Output folder. Overrides `outDir`. |
| `-h`, `--help` | Show help. |

| Environment variable | Meaning |
| --- | --- |
| `WEAVER_URL` | Server base URL. Wins over `url` in the config. |
| `WEAVER_TOKEN` | API key, sent as a bearer token. Needed for private repositories. |

The exit code is `0` on success and `1` on any error. Errors print one line, `error: <message>`, without a stack trace. Version conflicts print `warning: Version conflict: …` and don't fail the run.

## From a pnpm script

```json title="package.json"
{
  "scripts": {
    "protos": "weaver fetch",
    "postinstall": "weaver fetch",
    "generate": "pnpm protos && buf generate protos"
  }
}
```

`postinstall` keeps the folder current after every `pnpm install`. Drop it if installs must work offline; run `pnpm protos` by hand instead.

## In CI

```yaml title=".github/workflows/build.yml"
- run: pnpm install --frozen-lockfile
  env:
    WEAVER_URL: {{url}}
    WEAVER_TOKEN: ${{ secrets.WEAVER_READ_TOKEN }}
```

Use a key with `read` access only. Public repositories need no token at all.

## The output folder

`outDir` holds the merged files of every resolved artifact, with their import paths:

```text
protos/
├── .weaver-output
├── surf/economy/v1/money.proto
└── surf/common/v1/ids.proto
```

- The folder is **replaced on every fetch**. Don't edit files in it, and add it to `.gitignore`.
- The new folder is written next to the old one and swapped in only when every download verified, so a failed fetch leaves the previous files in place.
- `.weaver-output` marks the folder as managed by the CLI. The CLI refuses to replace an existing, non-empty folder without it (`… exists and wasn't created by weaver`), so a typo in `outDir` can't wipe your sources.
- It also refuses an `outDir` that is or contains the current directory, the config file, `node_modules` or the cache.
- A file path that would be unsafe on Windows (reserved names such as `con.proto`, characters like `:` or `?`, trailing dots) fails the fetch, so the same config works on every OS.

## The cache

Downloaded archives are stored by their SHA-256 checksum:

- in `node_modules/.cache/weaver/` when the current directory has a `node_modules` folder,
- otherwise in `~/.cache/weaver/`.

A release downloads once. Snapshots are resolved again on every run and downloaded when there is a new build. Every download is checked against the checksum from the server, and a cached file that doesn't match is downloaded again. Delete the cache folder at any time; the next fetch fills it again.

## Requests and timeouts

The CLI calls `POST /api/v1/resolve` and then downloads each archive. Each request times out after 60 seconds. Archive downloads always go to the server in `url` or `WEAVER_URL`, so your token is never sent anywhere else.

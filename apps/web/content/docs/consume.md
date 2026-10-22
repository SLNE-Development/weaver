---
title: Use protos in a project
description: Add a dependency in Gradle or weaver.json, fetch it with everything it imports, and point your code generator at the output folder.
section: Getting started
order: 4
---

Fetching downloads an artifact and all of its dependencies into one folder, with the import paths intact. Your code generator (surf-tide, protobuf-es, `buf generate`, `protoc` …) reads that folder. Weaver itself never generates code.

Find the coordinate of what you need under **Browse**. The **Usage** tab of every version shows a ready-made snippet.

## Do you need a key?

- **Public repositories** can be read without a key, from anywhere, including CI.
- **Private repositories** need an API key with `read` access to that repository. Create one under **API keys** (any role can create read keys) and export it as `WEAVER_TOKEN`.

```sh
export WEAVER_URL={{url}}
export WEAVER_TOKEN=<your API key>   # only for private repositories
```

## In a Gradle project

Apply the plugin (see [Publish your first artifact](/docs/publish#apply-the-plugin) for the plugin repository), list the repositories to search, and declare the dependency:

```kotlin title="build.gradle.kts"
plugins {
    id("dev.slne.weaver") version "0.1.0"
}

weaver {
    repositories("releases", "snapshots")   // searched in this order
}

dependencies {
    weaver("dev.surf.economy:economy-contracts:1.4.0")
}
```

Fetch:

```sh
./gradlew fetchProtos
```

The files land in `build/weaver/protos/`. Hand that folder to your generator through `weaver.protosDir`. It is a `Provider<Directory>` that carries the task dependency, so Gradle runs `fetchProtos` first:

```kotlin title="build.gradle.kts"
tasks.register<Exec>("generateContracts") {
    val protos = weaver.protosDir
    inputs.dir(protos)
    commandLine("buf", "generate", protos.get().asFile.path)
}
```

With surf-tide or another proto plugin, pass `weaver.protosDir` wherever it accepts a source or include directory.

To search a group, list it like any repository. The group looks in its members in order:

```kotlin
weaver {
    repositories("proto-all")
}
```

## In a Node project

Add `weaver.json` next to `package.json`:

```json title="weaver.json"
{
  "url": "{{url}}",
  "repositories": ["releases"],
  "dependencies": ["dev.surf.economy:economy-contracts:1.4.0"],
  "outDir": "./protos"
}
```

Install the CLI as a dev dependency and run it from a script, so everyone gets the same files after `pnpm install`:

```sh
pnpm add --save-dev @slne/weaver-cli
```

```json title="package.json"
{
  "scripts": {
    "protos": "weaver fetch",
    "postinstall": "weaver fetch"
  }
}
```

```sh
pnpm protos
```

```text
Fetched 12 file(s) from 3 artifact(s)
```

The files land in `./protos`. Point your generator at it, for example `buf generate protos` with protobuf-es. Add `protos/` to `.gitignore`: the folder is replaced on every fetch.

See [Node CLI](/docs/cli) for every option.

## What you get

For `economy-contracts:1.4.0`, which depends on `dev.surf.common:common-types:2.0.0`, the folder looks like this:

```text
protos/
├── surf/economy/v1/money.proto        ← economy-contracts
├── surf/economy/v1/wallet.proto       ← economy-contracts
└── surf/common/v1/ids.proto           ← common-types (transitive)
```

Every artifact's files are merged into one root. If two artifacts contain the same path, the fetch fails and names both. See [Dependencies and resolution](/docs/resolution).

## Snapshots and caching

Both clients cache downloaded archives by checksum. A release is downloaded once. A `-SNAPSHOT` dependency is checked against the server on every fetch, and the newest build is downloaded when it changed.

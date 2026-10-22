---
title: Maven and Gradle
description: Resolve and publish Maven artifacts with mvn and Gradle, use mirrors and groups, and fix 401, 403, 405 and 409 errors.
section: Clients
order: 5
---

Weaver serves Maven repositories at `{{url}}/maven/<repo>/`. Stock `mvn` and Gradle talk to them with no plugin and no special flag. This page is about Maven-format repositories; the proto plugin is described in [Gradle plugin](/docs/gradle).

## Repository URLs

Every Maven repository has one URL, `{{url}}/maven/<repo>/`, with a trailing slash. What it does depends on the repository kind:

- **Hosted.** You publish to it and resolve from it. It stores what you deploy.
- **Mirror.** A read-only proxy of one or more upstream repositories, such as Maven Central. Artifacts are fetched on demand, and cached when the mirror has caching turned on.
- **Group.** A read-only view over several hosted and mirror repositories of the same format. A client points at the group and gets one merged repository. Members are searched in order, the first member that has a file wins, and `maven-metadata.xml` is merged across all members.

Reading a group grants reading everything served through it, even from private members.

## Access tokens

A private repository needs an access token (see [API keys and permissions](/docs/admin/keys)). Maven clients send it as HTTP Basic credentials: use any username and the token as the password. Publishing needs a token with write access to the hosted repository.

Public repositories can be read without credentials. Publishing always needs a token.

In `~/.m2/settings.xml`, the `<id>` must match the `<id>` of the repository in the `pom.xml`:

```xml
<settings>
  <servers>
    <server>
      <id>weaver-releases</id>
      <username>token</username>
      <password>${env.WEAVER_TOKEN}</password>
    </server>
  </servers>
</settings>
```

For Gradle, put the credentials in `~/.gradle/gradle.properties`. For a repository named `releases`, the plugin-free convention is `weaver` plus the repository name in PascalCase, then `Username` and `Password`:

```properties
weaverReleasesUsername=token
weaverReleasesPassword=<your token>
```

A repository named `my-releases` becomes `weaverMyReleases`. Any username works; only the token is checked.

## Resolve with Maven

Declare the repository in your `pom.xml`:

```xml
<repositories>
  <repository>
    <id>weaver-releases</id>
    <url>{{url}}/maven/releases/</url>
  </repository>
</repositories>
```

To send every request through one group, which is the usual setup for a team, mirror everything to it in `settings.xml`:

```xml
<mirrors>
  <mirror>
    <id>weaver-all</id>
    <mirrorOf>*</mirrorOf>
    <url>{{url}}/maven/all/</url>
  </mirror>
</mirrors>
```

Add a matching `<server>` with the id `weaver-all` when the group is private. Put hosted repositories first in the group and a mirror of Maven Central last, so your own artifacts win and the rest comes from Central.

## Resolve with Gradle

```kotlin
repositories {
    maven("{{url}}/maven/releases/") {
        name = "weaverReleases"
        credentials(PasswordCredentials::class)
    }
}

dependencies {
    implementation("org.example:lib:1.0")
}
```

`credentials(PasswordCredentials::class)` reads `weaverReleasesUsername` and `weaverReleasesPassword` from `gradle.properties`, which is why the repository name matters. Leave `credentials` out for a public repository.

## Publish with Maven

Add a `distributionManagement` section to the `pom.xml`, using the same `<id>` as the `<server>`:

```xml
<distributionManagement>
  <repository>
    <id>weaver-releases</id>
    <url>{{url}}/maven/releases/</url>
  </repository>
  <snapshotRepository>
    <id>weaver-releases</id>
    <url>{{url}}/maven/releases/</url>
  </snapshotRepository>
</distributionManagement>
```

Then run:

```bash
mvn deploy
```

Maven first tries the upload without credentials, gets a `401` with a challenge, and retries with the token. This is normal and shows up once per file. Metadata files that Maven uploads next to your artifact are accepted; Weaver generates the real `maven-metadata.xml` itself from what is stored.

## Publish with Gradle

Use `maven-publish`, and `signing` if you sign:

```kotlin
plugins {
    `java-library`
    `maven-publish`
    signing
}

publishing {
    publications {
        create<MavenPublication>("lib") {
            from(components["java"])
        }
    }
    repositories {
        maven("{{url}}/maven/releases/") {
            name = "weaverReleases"
            credentials(PasswordCredentials::class)
        }
    }
}

signing {
    sign(publishing.publications["lib"])
}
```

Run `./gradlew publish`. Signature files (`.asc`) are stored exactly as uploaded, and Weaver does not verify them. Gradle module metadata (`.module` files) is stored and served like any other file, so Gradle consumers get variant-aware resolution.

## Snapshots

A version ending in `-SNAPSHOT` is a snapshot. Maven and Gradle upload each build with a timestamped name such as `lib-1.0-20261022.101010-3.jar`, and consumers resolve the newest build through the version-level `maven-metadata.xml`. Weaver builds that metadata from what is stored.

Snapshots can always be overwritten, whatever the redeploy setting. Whether a hosted repository takes releases, snapshots or both is its **version policy**:

- **Releases and snapshots** (the default).
- **Releases only.** A snapshot upload fails with `400`.
- **Snapshots only.** A release upload fails with `400`.

Consumers pick up a newer snapshot when Maven checks for updates (`mvn -U`) or Gradle's cache expires (`--refresh-dependencies`).

## Checksums

Clients ask for `.md5`, `.sha1`, `.sha256` and `.sha512` files next to every artifact. If you uploaded a checksum file, Weaver serves it as uploaded. Otherwise it generates the checksum from the stored file, so strict checksum checking (`mvn -C`) works either way. Checksums of generated metadata are always generated.

## Errors

| Status | Meaning | What to do |
| --- | --- | --- |
| 401 | No token, or an invalid or expired one. | Add the `<server>` or `credentials` for the repository and check the token. |
| 403 | The token is valid but has no access to this repository, or no write access for an upload. | Give the key access in [API keys and permissions](/docs/admin/keys). |
| 400 | The upload breaks the repository's version policy, or the path is not a valid Maven path. | Publish releases to a repository that accepts them, or fix the path. |
| 405 | You tried to publish to a mirror or a group. | Publish to a hosted repository and keep the group for reading. |
| 409 | The release already exists and redeploy is off. | Publish a new version, or ask an admin to allow redeploy on the repository. |
| 502 | The upstream of a mirror could not be reached and nothing is cached. | Try again later, or turn on caching on the mirror so the next outage is covered. |

The same file that returns `404` on a plain `mvn` run may be missing from the repository, or filtered out by a mirror's allow and deny rules. A group answers `502` instead of `404` when a member failed, because Maven remembers a `404` for a while and would otherwise keep failing after the outage ends.

For problems that are not about the status code, see [Troubleshooting](/docs/troubleshooting).

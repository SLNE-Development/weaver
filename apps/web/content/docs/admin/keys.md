---
title: API keys and permissions
description: Scope a key to a repository and group prefix, rotate it, and give CI the least access it needs.
section: Administration
order: 3
---

Builds talk to Weaver with API keys. Every key belongs to a user, has a name, an optional expiry and a list of **permission entries**. The secret is shown once and stored only as a hash.

## Create a key

1. Open **API keys** in the sidebar and choose **Create key** (or press `Ctrl K` and choose "Create API key").
2. Enter a **name** that says where the key is used, such as `economy-contracts GitHub Actions`.
3. Optionally set an **expiry** in days. Expired keys stop working automatically.
4. Add one or more permission entries (below).
5. Copy the key from the dialog. "You won't see this key again": after closing the dialog, nobody can read it, not even an admin.

Store it as a secret in your CI and as `WEAVER_TOKEN` locally.

## Permission entries

Each entry grants access to one repository:

| Field | Meaning |
| --- | --- |
| **Repository** | The repository the entry applies to. |
| **Group prefix** | Optional. Limits the entry to groups that equal the prefix or start with it followed by a dot. Empty means every group. |
| **Access** | `read`, or `write`. Write includes read. |

The group prefix matches at dot boundaries: `dev.surf` covers `dev.surf` and `dev.surf.economy`, but not `dev.surfboard`.

A key may have several entries. It can do something when at least one entry allows it.

### Examples

| Purpose | Entries |
| --- | --- |
| CI of one contracts project publishes releases | `releases` · `dev.surf.economy` · write |
| Same, plus snapshots | `releases` · `dev.surf.economy` · write, and `snapshots` · `dev.surf.economy` · write |
| A service build fetches private contracts | `internal` · (any group) · read |
| A team's builds fetch everything they own | `internal` · `dev.surf` · read |

Public repositories need no entry for reading.

## What roles allow

The access a key can use is capped by its owner's **current** role, checked on every request:

- **viewer**: keys can only read. The dialog offers only `read`.
- **maintainer** and **admin**: keys can read and write, and keys with write access can delete versions.

When a maintainer is demoted to viewer, their write keys keep working for reads only. When a user is banned or removed, all their keys are rejected with `401 unauthorized`.

Signed-in users can read every repository in the web app, but publishing always needs a key.

## Least access for CI

- Make one key per project and per purpose, not one key for everything.
- Give publishing keys `write` only on the repository and group prefix they publish to.
- Give fetch-only builds `read` keys, or no key at all for public repositories.
- Set an expiry, and put a reminder in your calendar to rotate before it.
- A key stops working when its owner is banned or removed. Before someone leaves, replace the CI keys they created.

## Rotate a key

Keys can't be edited or shown again, so rotation means replacing:

1. Create a new key with the same entries.
2. Update the secret in CI (and anywhere else it is used).
3. Run a build to check it.
4. **Revoke** the old key in the key list.

The list shows each key's last use, which helps you spot keys that are no longer needed.

## Revoke a key

Choose **Revoke** next to the key. It stops working on the next request. Admins can see and revoke every user's keys; everyone else sees their own.

## How keys are sent

```http
Authorization: Bearer <your API key>
```

The Gradle plugin and the CLI send `WEAVER_TOKEN` this way, and only to the configured server URL. A rejected key fails with `401 unauthorized`. A key without access to a private repository gets `404 not_found`, as if the repository didn't exist. See [Troubleshooting](/docs/troubleshooting#401-or-403-from-gradle-or-the-cli).

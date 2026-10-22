---
title: Cleanup policies
description: Keep the last N snapshot builds, expire old snapshots, preview before running, and know what is never deleted.
section: Administration
order: 4
---

Snapshots pile up: every publish of `1.5.0-SNAPSHOT` adds a build. Cleanup policies delete what nobody needs anymore. Each repository has its own list of rules. Only admins manage them.

## The rules

| Rule | Deletes | Value |
| --- | --- | --- |
| **Keep last N snapshot builds** | Older builds of each snapshot version, keeping the newest N | N builds (at least 1) |
| **Delete stale snapshots** | Whole snapshot versions with no new publish in X days | X days (at least 1) |
| **Delete versions not downloaded** | Whole versions not downloaded in X days. Snapshots only, unless you tick **Include releases** | X days (at least 1) |

Every rule can also have:

- a **group prefix**, so it applies only to groups that equal the prefix or start with it followed by a dot,
- an **enabled** switch, to pause it without deleting it.

"Not downloaded" counts from the last archive download of any build of the version. A version that was never downloaded counts from when it was first published.

## Add a policy

1. Open **Repositories**, choose the repository and then **Settings**.
2. In **Cleanup policies**, choose **Add** and pick the rule, its value, an optional group prefix and, for the download rule, whether it includes releases.
3. Save.

A sensible start for a `snapshots` repository:

- Keep last **5** snapshot builds.
- Delete stale snapshots after **30** days.

## Preview before running

Choose **Preview** to see exactly what the enabled policies would delete right now: every version or build, with the rule that selected it, for example `keep last 5 snapshot builds` or `not downloaded for 90 days`. Preview never deletes anything.

## When policies run

- **Daily** at 03:00 server time, for every repository that has an enabled policy. The worker service runs this job; without a running worker, nothing is cleaned up.
- **Run now** on the repository's settings page, after a confirmation. It queues a job for that repository on the worker and shows its progress and the number of deletions.

The worker runs one cleanup job at a time, and a daily run that finds another one still going skips. Every deletion is written to the audit log as `cleanup.delete`, with the reason.

## What is never deleted

- **Releases**, unless a "Delete versions not downloaded" rule has **Include releases** ticked. No other rule touches a release.
- **The newest build of a snapshot** by the "Keep last N" rule. It keeps at least one build, even if you enter 0.
- **Anything another version depends on.** A version that a version staying behind depends on (in any repository) is kept, and so are its own dependencies. A version whose only dependents are deleted in the same run is deleted after them.
- **A version published again since the run planned it.** A fresh publish wins over a pending deletion.

A misconfigured `0` days is treated as `1`, so a typo can't wipe a repository.

> [!WARNING]
> **Include releases deletes releases for good.** Builds that pin an old release fail once it is gone. Use it only in repositories whose consumers always move to new versions, and check the preview first. A deleted release can only be restored with identical content unless the repository allows redeploy (see [Publishing a deleted release again](/docs/versions#publishing-a-deleted-release-again)).

## Mirrors and groups

Cleanup policies apply to **hosted repositories only**. A mirror's or a group's settings page has no cleanup section, and policies cannot be added to them.

- **Mirrors** are trimmed by the eviction settings of their cache instead: **Max age (days)** since last access and **Max size (GiB)**, least recently used content first. The worker runs eviction every hour.
- **Groups** store nothing of their own; clean up their hosted members.

Proto mirrors are no longer cleaned by cleanup policies. Use the mirror's eviction settings to limit its cache.

## Removing versions by hand

To remove a single version now, open it under **Browse** and choose **Delete** (maintainers and admins). Unlike cleanup, a manual delete of a depended-on version can be forced by an admin. See [Versions and snapshots](/docs/versions#deleting-a-version).

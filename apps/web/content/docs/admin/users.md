---
title: Users, roles and invites
description: Invite people, choose admin, maintainer or viewer, ban or remove users, and set the first admin of a new instance.
section: Administration
order: 2
---

People sign in with GitHub or Discord. There are no passwords and no open sign-up: every account is created from an invite link, except the very first admin.

## Roles

| | viewer | maintainer | admin |
| --- | :-: | :-: | :-: |
| Browse every repository in the web app | yes | yes | yes |
| Create API keys with `read` access | yes | yes | yes |
| Create API keys with `write` access (publish) | | yes | yes |
| Delete artifact versions | | yes | yes |
| Force a delete or redeploy past dependents | | | yes |
| Manage repositories and cleanup policies | | | yes |
| Manage users, invites, settings; view the audit log | | | yes |

Keys follow their owner's role at the time of each request. If you demote a maintainer to viewer, their write keys can only read from then on. If you ban someone, all their keys stop working at once.

## Invite someone

1. Open **Users** and switch to the **Invites** tab.
2. Choose **Create invite**.
3. Pick the **role** the new user gets, an **expiry** between 1 and 30 days, and optionally a **note** so you remember who it's for.
4. Copy the link and send it to the person. It looks like `{{url}}/invite/<token>` and is shown only once.

The person opens the link and signs in with GitHub or Discord. That creates their account with the chosen role and uses up the invite. They have 15 minutes from opening the link to finish signing in. See [Join an instance](/docs/join).

Each invite works for one account. The **Invites** tab lists open, used and expired invites. Revoke an open invite if the link was sent to the wrong place.

> [!NOTE]
> **Invites aren't bound to a person.** Anyone with the link can use it until it is used or expires. Send it through a private channel and keep expiries short.

## Change a role

On the **Users** tab, change the role in the user's row. The change applies to the user's next request, including their API keys.

The last remaining admin can't be demoted, banned or removed, so the instance always has someone who can manage it.

## Ban or remove a user

- **Ban** blocks sign-in and every API key of the user. Their artifacts stay. Unban to restore access.
- **Remove** deletes the account. Published versions stay; they keep their checksum and history. To come back, the person needs a new invite.

Every change to users, roles and invites is written to the audit log.

## The first admin

A new instance has no users and no admin to create invites. The `INITIAL_ADMIN` environment variable solves that:

```sh
INITIAL_ADMIN=github:octocat        # a GitHub login (case-insensitive)
INITIAL_ADMIN=discord:80351110224678912   # a Discord user id (numeric)
```

While no admin exists, a sign-in with exactly that provider account creates the user with the role `admin`. Everyone else still needs an invite. Once an admin exists the variable is ignored, so you can remove it after the first sign-in.

To find a Discord user id, turn on Developer Mode in Discord (Settings, Advanced), then right-click the user and choose **Copy User ID**.

Without `INITIAL_ADMIN`, nobody can sign in to a fresh instance. See [Configuration reference](/docs/self-host/config).

## Sign-in rules

- A provider signs a user in only if that user connected it, either by joining with it or on the **Account** page.
- Weaver never links accounts by email. Someone who joined with GitHub and tries Discord without connecting it first is asked for an invite.
- Users can connect and disconnect providers on **Account**, but can't disconnect the last one.

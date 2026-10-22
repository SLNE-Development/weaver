---
title: Join an instance
description: Accept an invite, sign in with GitHub or Discord, and connect a second provider to your account.
section: Getting started
order: 2
---

Weaver has no passwords and no open sign-up. You join with an **invite link** from an admin and sign in with GitHub or Discord. This takes about two minutes.

## 1. Get an invite link

Ask an admin of this instance for an invite. The link looks like this:

```text
{{url}}/invite/<token>
```

The admin picks your role when creating the invite: `viewer`, `maintainer` or `admin`. An invite works once and expires after the number of days the admin chose (1 to 30). See [Users, roles and invites](/docs/admin/users) for what each role can do.

## 2. Open the link and sign in

Open the link in your browser. The page shows the role you are about to get and a button for each sign-in provider this instance supports, such as **Continue with GitHub** or **Continue with Discord**.

Choose a provider and approve the request on GitHub or Discord. You come back to Weaver signed in, with the role from the invite. The invite is now used up.

> [!WARNING]
> **Finish within 15 minutes.** Opening the invite link remembers it in your browser for 15 minutes. If the sign-in takes longer, or you switch browsers in between, open the link again. It still works as long as nobody has used it.

If you see "You need an invite to join this Weaver.", the invite was not found in your browser. It may be expired, already used, or opened in a different browser. Ask the admin for a new link.

## 3. Connect a second provider

Signing in with a provider only works for accounts you have connected yourself. Weaver never links accounts by matching email addresses. If you joined with GitHub and later sign in with Discord, Weaver treats that as a new person and asks for an invite.

To use both providers:

1. Sign in with the provider you joined with.
2. Open **Account** (`{{url}}/account`).
3. Under **Connected accounts**, choose **Connect** next to the other provider and approve it.

From now on either provider signs you in. You can disconnect a provider on the same page, but not the last one, so you can always sign in.

## Sign in later

Go to `{{url}}/login` and choose a provider you connected. Only the providers this instance has configured are shown.

## Next steps

- Browse what's published under **Browse**.
- To publish, ask an admin for the `maintainer` role or a key with write access, then follow [Publish your first artifact](/docs/publish).
- To fetch protos in a project, follow [Use protos in a project](/docs/consume).

import type { Metadata } from "next";
import Link from "next/link";
import { CircleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Badge } from "@weaver/ui/components/badge";
import { Button } from "@weaver/ui/components/button";
import { AuthFrame } from "@/components/auth-frame";
import { ProviderButtons } from "@/components/provider-buttons";
import { DASHBOARD_PATH } from "@/lib/access";
import { getEnabledSocialProviders } from "@/server/auth";
import { getServerContext } from "@/server/context";
import { getInviteStatus } from "@/server/invite-status";
import { getAppSession } from "@/server/session";
import { prepareInviteSignIn } from "./actions";

export const metadata: Metadata = { title: "Invite" };

const ROLE_SUMMARY = {
  admin: "Full control: repositories, users, settings and the audit log.",
  maintainer: "Browse everything, delete versions and create keys that can publish.",
  viewer: "Browse everything and create read-only keys.",
} as const;

const UNUSABLE = {
  used: { title: "Invite already used", text: "Each invite link creates one account. Ask an admin for a new invite." },
  expired: { title: "Invite expired", text: "This invite is no longer valid. Ask an admin for a new invite." },
  unknown: { title: "Invite not found", text: "Check that you copied the whole link, or ask an admin for a new invite." },
} as const;

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Landing page of a one-time invite link: shows the role it grants and starts the sign-up. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [status, { user }] = await Promise.all([getInviteStatus(getServerContext().db, token), getAppSession()]);

  if (status.kind !== "valid") {
    const copy = UNUSABLE[status.kind];
    return (
      <AuthFrame title={copy.title} description="This invite link can't be used.">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.text}</AlertDescription>
        </Alert>
        <Button variant="outline" asChild>
          <Link href="/login">Go to sign in</Link>
        </Button>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="You're invited to Weaver"
      description="Sign in with one of the accounts below to create your account."
      footer={
        <>
          This link works once and expires on <time dateTime={status.expiresAt.toISOString()}>{dateFormat.format(status.expiresAt)} UTC</time>.
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3 rounded-md border bg-surface p-4 text-sm">
        <dt className="text-muted-foreground">Role</dt>
        <dd className="flex flex-col gap-1">
          <Badge variant="outline" className="font-mono" data-testid="invite-role">
            {status.role}
          </Badge>
          <span className="text-muted-foreground">{ROLE_SUMMARY[status.role]}</span>
        </dd>
        {status.note && (
          <>
            <dt className="text-muted-foreground">Note</dt>
            <dd className="break-words">{status.note}</dd>
          </>
        )}
      </dl>
      {user ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>You&apos;re already signed in</AlertTitle>
          <AlertDescription>
            <p>
              You&apos;re signed in as {user.name}. An invite creates a new account; sign out first to use it.
            </p>
            <Link href={DASHBOARD_PATH} className="text-link underline-offset-4 hover:underline">
              Go to the dashboard
            </Link>
          </AlertDescription>
        </Alert>
      ) : (
        <ProviderButtons
          providers={getEnabledSocialProviders()}
          callbackURL={DASHBOARD_PATH}
          errorCallbackURL="/login"
          prepare={prepareInviteSignIn.bind(null, token)}
        />
      )}
    </AuthFrame>
  );
}

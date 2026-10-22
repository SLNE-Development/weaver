import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CircleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { AuthFrame } from "@/components/auth-frame";
import { ProviderButtons } from "@/components/provider-buttons";
import { safeNextPath } from "@/lib/access";
import { getEnabledSocialProviders } from "@/server/auth";
import { getAppSession } from "@/server/session";
import { INVITE_REQUIRED_MESSAGE } from "@/server/user-gate";

export const metadata: Metadata = { title: "Sign in" };

/** Better Auth error codes that mean "no account and no invite". */
const INVITE_ERRORS = new Set(["invite_required", "signup_disabled"]);

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** OAuth-only sign-in: one button per configured provider. Signed-in visitors go straight on. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  const { user } = await getAppSession();
  if (user) redirect(next);

  const error = first(params.error);
  const providers = getEnabledSocialProviders();
  const loginURL = `/login?next=${encodeURIComponent(next)}`;

  return (
    <AuthFrame
      title="Sign in to Weaver"
      description="Use the account you connected to this registry."
      footer="New here? Access is by invitation. Ask an admin of this Weaver for an invite link."
    >
      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{INVITE_ERRORS.has(error) ? "No account for this sign-in" : "Sign-in failed"}</AlertTitle>
          <AlertDescription>
            {INVITE_ERRORS.has(error) ? (
              INVITE_REQUIRED_MESSAGE
            ) : (
              <p>
                Please try again. Error code: <code className="font-mono">{error}</code>
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <ProviderButtons providers={providers} callbackURL={next} errorCallbackURL={loginURL} />
    </AuthFrame>
  );
}

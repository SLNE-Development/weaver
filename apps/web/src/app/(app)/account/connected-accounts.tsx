"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@weaver/ui/components/badge";
import { Button } from "@weaver/ui/components/button";
import { Spinner } from "@weaver/ui/components/spinner";
import { ProviderIcon } from "@/components/provider-icon";
import { PROVIDER_NAMES, authClient, type ProviderId } from "@/lib/auth-client";

/** A connected OAuth account: Better Auth's account row id and its provider. */
export interface LinkedAccount {
  id: string;
  providerId: string;
}

const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user: "That account is already connected to another Weaver user.",
};

/**
 * One row per enabled provider with Connect (`linkSocial`, which returns here after OAuth) or
 * Disconnect (`unlinkAccount`). The last connected account can't be disconnected; the server
 * refuses that as well.
 */
export function ConnectedAccounts({
  providers,
  linked,
  error,
}: {
  providers: ProviderId[];
  linked: LinkedAccount[];
  /** `error` query parameter from a failed link round trip. */
  error: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, setPending] = useState<ProviderId | null>(null);

  useEffect(() => {
    if (!error) return;
    toast.error("Couldn't connect the account", { description: LINK_ERRORS[error] ?? `Error code: ${error}` });
    router.replace(pathname);
  }, [error, pathname, router]);

  async function connect(provider: ProviderId) {
    setPending(provider);
    const { error: failure } = await authClient.linkSocial({ provider, callbackURL: "/account", errorCallbackURL: "/account" });
    if (failure) {
      toast.error("Couldn't connect the account", { description: failure.message });
      setPending(null);
    }
  }

  async function disconnect(provider: ProviderId, accountId: string) {
    setPending(provider);
    const { error: failure } = await authClient.unlinkAccount({ accountId });
    setPending(null);
    if (failure) {
      toast.error("Couldn't disconnect the account", { description: failure.message });
      return;
    }
    toast.success(`${PROVIDER_NAMES[provider]} disconnected`);
    router.refresh();
  }

  // Only accounts of enabled providers can still sign the user in.
  const usable = linked.filter((entry) => (providers as string[]).includes(entry.providerId));

  return (
    <ul className="divide-y border-t">
      {providers.map((provider) => {
        const account = usable.find((entry) => entry.providerId === provider);
        const connected = account !== undefined;
        // Never offer to disconnect the only remaining sign-in method.
        const lastOne = connected && usable.length <= 1;
        return (
          <li key={provider} data-testid={`provider-${provider}`} className="flex items-center gap-3 px-4 py-3">
            <ProviderIcon provider={provider} className="size-5 shrink-0" />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-sm font-medium">{PROVIDER_NAMES[provider]}</span>
              <span className="text-xs text-muted-foreground">
                {lastOne ? "Your only sign-in method; connect another account before disconnecting it." : connected ? "Connected" : "Not connected"}
              </span>
            </div>
            {connected && (
              <Badge variant="outline" className="border-release/40 bg-release-soft text-release">
                Connected
              </Badge>
            )}
            {account ? (
              <Button
                variant="outline"
                size="sm"
                disabled={lastOne || pending !== null}
                onClick={() => void disconnect(provider, account.id)}
              >
                {pending === provider && <Spinner />}
                Disconnect
              </Button>
            ) : (
              <Button size="sm" disabled={pending !== null} onClick={() => void connect(provider)}>
                {pending === provider && <Spinner />}
                Connect
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

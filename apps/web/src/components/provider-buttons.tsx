"use client";

import { useState } from "react";
import { Button } from "@weaver/ui/components/button";
import { Spinner } from "@weaver/ui/components/spinner";
import { PROVIDER_NAMES, signInWith, type ProviderId } from "@/lib/auth-client";
import { ProviderIcon } from "./provider-icon";

/**
 * One "Continue with …" button per enabled OAuth provider. `prepare` runs first (the invite page
 * uses it to set the invite cookie); when it returns a message the sign-in doesn't start and the
 * message is shown instead.
 */
export function ProviderButtons({
  providers,
  callbackURL,
  errorCallbackURL,
  prepare,
}: {
  providers: ProviderId[];
  callbackURL: string;
  errorCallbackURL: string;
  prepare?: () => Promise<string | null>;
}) {
  const [pending, setPending] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(provider: ProviderId) {
    setPending(provider);
    setError(null);
    const refused = prepare ? await prepare() : null;
    const result = refused ? { error: refused } : await signInWith(provider, { callbackURL, errorCallbackURL });
    // On success the browser is already navigating to the provider; keep the spinner until it leaves.
    if (result.error) {
      setError(result.error);
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          key={provider}
          variant={provider === providers[0] ? "default" : "outline"}
          size="lg"
          className="w-full justify-start gap-3"
          disabled={pending !== null}
          onClick={() => void start(provider)}
        >
          {pending === provider ? <Spinner className="size-4" /> : <ProviderIcon provider={provider} className="size-4" />}
          <span className="flex-1 text-left">Continue with {PROVIDER_NAMES[provider]}</span>
        </Button>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

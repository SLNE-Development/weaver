"use client";

import { useState } from "react";
import { Button } from "@weaver/ui/components/button";
import { Spinner } from "@weaver/ui/components/spinner";
import { cn } from "@weaver/ui/lib/utils";
import type { SocialProviderId } from "@/server/auth";
import { authClient } from "@/lib/auth-client";
import { DiscordIcon, GitHubIcon } from "./provider-icons";

const PROVIDERS: Record<SocialProviderId, { label: string; Icon: typeof GitHubIcon }> = {
  github: { label: "Continue with GitHub", Icon: GitHubIcon },
  discord: { label: "Continue with Discord", Icon: DiscordIcon },
};

/**
 * One button per configured OAuth provider; the first is the primary action. Sign-up is requested
 * explicitly (providers disable implicit sign-up); the server gate decides via invite or first admin.
 * Refused or failed sign-ins land on /login, which explains them.
 */
export function SignInButtons({ providers, className }: { providers: SocialProviderId[]; className?: string }) {
  const [pending, setPending] = useState<SocialProviderId | null>(null);

  async function signIn(provider: SocialProviderId) {
    setPending(provider);
    try {
      const result = await authClient.signIn.social({
        provider,
        requestSignUp: true,
        callbackURL: "/dashboard",
        errorCallbackURL: "/login",
      });
      if (result.error) setPending(null);
    } catch {
      setPending(null);
    }
  }

  return (
    <div className={cn("contents", className)}>
      {providers.map((provider, index) => {
        const { label, Icon } = PROVIDERS[provider];
        return (
          <Button
            key={provider}
            type="button"
            size="lg"
            variant={index === 0 ? "default" : "outline"}
            disabled={pending !== null}
            onClick={() => void signIn(provider)}
            className="px-4"
          >
            {pending === provider ? <Spinner /> : <Icon />}
            {label}
          </Button>
        );
      })}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { CheckIcon, GlobeIcon, LockIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@weaver/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@weaver/ui/components/card";
import { Label } from "@weaver/ui/components/label";
import { Spinner } from "@weaver/ui/components/spinner";
import { Switch } from "@weaver/ui/components/switch";
import { cn } from "@weaver/ui/lib/utils";
import { useTRPC } from "@/trpc/client";

const VISIBLE = ["The dashboard", "Public repositories and their artifacts, versions and .proto files"];
const HIDDEN = ["Private repositories", "Repository settings and API keys", "Users, settings and the audit log"];

function Item({ visible, children }: { visible: boolean; children: string }) {
  const Icon = visible ? CheckIcon : XIcon;
  return (
    <li className="flex items-start gap-2">
      <Icon className={cn("mt-0.5 size-4 shrink-0", visible ? "text-release" : "text-muted-foreground")} aria-hidden />
      <span className="sr-only">{visible ? "Visible:" : "Not visible:"}</span>
      {children}
    </li>
  );
}

/**
 * The "Allow anonymous view" switch with what it does and doesn't open up. It only gates the web
 * UI; anonymous REST reads of public repositories always work.
 */
export function AnonymousViewSetting({ initial }: { initial: boolean }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (settings) => {
        setEnabled(settings.anonymousView);
        toast.success(settings.anonymousView ? "Anonymous view allowed" : "Anonymous view turned off");
        router.refresh();
      },
      onError: (error) => toast.error("Couldn't change the setting", { description: error.message }),
    }),
  );

  return (
    <Card className="gap-4 rounded-md py-4 shadow-none">
      <CardHeader className="px-4">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Label htmlFor="anonymous-view" className="cursor-pointer">
                Allow anonymous view
              </Label>
              <Badge
                variant="outline"
                className={cn(
                  "font-mono text-[10px]",
                  enabled ? "border-release/40 bg-release-soft text-release" : "text-muted-foreground",
                )}
              >
                {enabled ? <GlobeIcon /> : <LockIcon />}
                {enabled ? "on" : "off"}
              </Badge>
            </CardTitle>
            <CardDescription>
              Let people who aren&apos;t signed in browse this registry&apos;s public repositories in the web UI.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {update.isPending && <Spinner className="text-muted-foreground" />}
            <Switch
              id="anonymous-view"
              checked={enabled}
              disabled={update.isPending}
              onCheckedChange={(checked) => update.mutate({ anonymousView: checked })}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 px-4 text-sm">
        <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
          <div className="grid content-start gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Anonymous visitors can see</h3>
            <ul className="grid gap-1.5">
              {VISIBLE.map((text) => (
                <Item key={text} visible>
                  {text}
                </Item>
              ))}
            </ul>
          </div>
          <div className="grid content-start gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Always requires signing in</h3>
            <ul className="grid gap-1.5">
              {HIDDEN.map((text) => (
                <Item key={text} visible={false}>
                  {text}
                </Item>
              ))}
            </ul>
          </div>
        </div>
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          This setting only affects the web UI. The REST API (<span className="font-mono">/api/v1</span>) is unaffected: anonymous reads of
          public repositories always work there, so build tools can fetch public protos without a key.
        </p>
        <p className="text-xs text-muted-foreground" role="status">
          {enabled
            ? "Anonymous view is on: visitors who aren't signed in can browse public repositories."
            : "Anonymous view is off: visitors have to sign in to see anything."}
        </p>
      </CardContent>
    </Card>
  );
}

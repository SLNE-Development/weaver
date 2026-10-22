"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@weaver/ui/components/button";
import { Spinner } from "@weaver/ui/components/spinner";
import { useTRPCClient } from "@/trpc/client";
import { copyText } from "./copy-button";

/**
 * Copies a proto file of a version. The content is fetched (`browse.file`) when clicked, so large
 * files never travel to the browser as a component prop.
 */
export function CopyFileButton({ repository, coordinate, path }: { repository: string; coordinate: string; path: string }) {
  const client = useTRPCClient();
  const [state, setState] = useState<"idle" | "loading" | "copied">("idle");
  const label = `Copy ${path}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      disabled={state === "loading"}
      className="text-muted-foreground hover:text-foreground"
      onClick={async () => {
        setState("loading");
        try {
          const file = await client.browse.file.query({ repository, coordinate, path });
          if (await copyText(file.content, `Copied ${path.split("/").at(-1)}`)) {
            setState("copied");
            setTimeout(() => setState("idle"), 1500);
            return;
          }
        } catch {
          toast.error("Couldn't load the file");
        }
        setState("idle");
      }}
    >
      {state === "loading" ? <Spinner /> : state === "copied" ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

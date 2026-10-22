"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@weaver/ui/components/button";
import { cn } from "@weaver/ui/lib/utils";

/** Copies `text` to the clipboard and shows a toast; reports failures (e.g. no clipboard permission). */
export async function copyText(text: string, what = "Copied to clipboard"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
    return true;
  } catch {
    toast.error("Couldn't copy to the clipboard");
    return false;
  }
}

/** Icon button that copies `text`; the icon turns into a check for a moment after copying. */
export function CopyButton({
  text,
  label,
  toastText,
  className,
  size = "icon-xs",
}: {
  text: string;
  /** Accessible name, e.g. "Copy sha256". */
  label: string;
  toastText?: string;
  className?: string;
  size?: "icon-xs" | "icon-sm";
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={async () => {
        if (await copyText(text, toastText)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

"use client";

import { ClipboardCopyIcon, CopyIcon } from "lucide-react";
import { Button } from "@weaver/ui/components/button";
import { useCommandActions } from "./command-actions";
import { copyText } from "./copy-button";

/**
 * The version page's copy actions: a "Copy coordinate" button, plus "Copy coordinate" and "Copy
 * Gradle snippet" in the command dialog while the page is open.
 */
export function VersionActions({ coordinate, gradle }: { coordinate: string; gradle: string }) {
  useCommandActions([
    {
      id: "copy-coordinate",
      label: "Copy coordinate",
      icon: CopyIcon,
      keywords: ["clipboard"],
      onSelect: () => void copyText(coordinate, `Copied ${coordinate}`),
    },
    {
      id: "copy-gradle-snippet",
      label: "Copy Gradle snippet",
      icon: ClipboardCopyIcon,
      keywords: ["gradle", "kotlin", "dependency"],
      onSelect: () => void copyText(gradle, "Copied Gradle snippet"),
    },
  ]);

  return (
    <Button variant="outline" size="sm" onClick={() => void copyText(coordinate, `Copied ${coordinate}`)}>
      <CopyIcon />
      Copy coordinate
    </Button>
  );
}

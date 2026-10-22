"use client";

import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@weaver/ui/components/button";
import { StatusPage } from "./status-page";

/** Error boundary content of the app pages: what went wrong (digest only), retry and a way out. */
export function AppError({
  error,
  reset,
  backHref,
  backLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  backHref: string;
  backLabel: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <StatusPage
      icon={TriangleAlertIcon}
      title="Something went wrong"
      description={
        <>
          The page couldn&apos;t be loaded. Try again in a moment.
          {error.digest && <span className="mt-1 block font-mono text-xs">Error {error.digest}</span>}
        </>
      }
    >
      <Button size="sm" onClick={reset}>
        Try again
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href={backHref}>{backLabel}</Link>
      </Button>
    </StatusPage>
  );
}

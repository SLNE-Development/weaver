import Link from "next/link";
import { CompassIcon } from "lucide-react";
import { Button } from "@weaver/ui/components/button";
import { StatusPage } from "@/components/status-page";

/** 404 inside the app shell. */
export default function NotFound() {
  return (
    <StatusPage icon={CompassIcon} title="Page not found" description="This page doesn't exist, or you don't have access to it.">
      <Button asChild size="sm">
        <Link href="/dashboard">Go to the dashboard</Link>
      </Button>
    </StatusPage>
  );
}

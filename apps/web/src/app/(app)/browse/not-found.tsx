import Link from "next/link";
import { PackageSearchIcon } from "lucide-react";
import { Button } from "@weaver/ui/components/button";
import { StatusPage } from "@/components/status-page";

/** 404 of the artifact browser: an unknown repository, artifact or version, or one the visitor can't read (they look the same). */
export default function BrowseNotFound() {
  return (
    <StatusPage
      icon={PackageSearchIcon}
      title="Not found"
      description="There is no such repository, artifact or version, or it isn't visible to you."
    >
      <Button asChild size="sm">
        <Link href="/browse">Browse repositories</Link>
      </Button>
    </StatusPage>
  );
}

import { GlobeIcon, LockIcon } from "lucide-react";
import { Badge } from "@weaver/ui/components/badge";

/** `public` / `private` marker of a repository. */
export function VisibilityBadge({ visibility }: { visibility: "public" | "private" }) {
  return (
    <Badge variant="outline" className="gap-1 font-mono text-[11px] text-muted-foreground">
      {visibility === "public" ? <GlobeIcon /> : <LockIcon />}
      {visibility}
    </Badge>
  );
}

/** Which version kinds a repository accepts, as release (green) / snapshot (amber) chips. */
export function AcceptsBadges({ releases, snapshots }: { releases: boolean; snapshots: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {releases && (
        <Badge className="bg-release-soft font-mono text-[11px] text-release" title="Accepts releases">
          release
        </Badge>
      )}
      {snapshots && (
        <Badge className="bg-snapshot-soft font-mono text-[11px] text-snapshot" title="Accepts snapshots">
          snapshot
        </Badge>
      )}
      {!releases && !snapshots && <span className="text-xs text-muted-foreground">nothing</span>}
    </div>
  );
}

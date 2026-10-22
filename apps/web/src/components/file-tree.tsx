import Link from "next/link";
import { FileCodeIcon, FolderIcon } from "lucide-react";
import { cn } from "@weaver/ui/lib/utils";
import type { FileTreeNode } from "@/lib/browse";

function Nodes({ nodes, depth, selected, hrefFor }: { nodes: FileTreeNode[]; depth: number; selected: string; hrefFor: (path: string) => string }) {
  return (
    <ul className="flex flex-col">
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <li key={node.path}>
            <div
              className="flex items-center gap-1.5 py-1 pr-2 font-mono text-xs text-muted-foreground"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              title={node.path}
            >
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="truncate">{node.name}</span>
            </div>
            <Nodes nodes={node.children} depth={depth + 1} selected={selected} hrefFor={hrefFor} />
          </li>
        ) : (
          <li key={node.path}>
            <Link
              href={hrefFor(node.path)}
              scroll={false}
              aria-current={node.path === selected ? "page" : undefined}
              title={node.path}
              className={cn(
                "flex items-center gap-1.5 rounded-sm py-1 pr-2 font-mono text-xs transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                node.path === selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              <FileCodeIcon className="size-3.5 shrink-0" />
              <span className="truncate">{node.name}</span>
            </Link>
          </li>
        ),
      )}
    </ul>
  );
}

/** A version's files as a tree; each file links to `hrefFor(path)` and the open one is highlighted. */
export function FileTree({ nodes, selected, hrefFor }: { nodes: FileTreeNode[]; selected: string; hrefFor: (path: string) => string }) {
  return (
    <nav aria-label="Files" className="p-1">
      <Nodes nodes={nodes} depth={0} selected={selected} hrefFor={hrefFor} />
    </nav>
  );
}

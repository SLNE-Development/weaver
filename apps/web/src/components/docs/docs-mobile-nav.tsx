"use client";

import { MenuIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@weaver/ui/components/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@weaver/ui/components/sheet";
import type { DocNavGroup } from "@/lib/docs";
import { DocsNav } from "./docs-nav";

/** Menu button for small screens that opens the docs navigation in a sheet from the left. */
export function DocsMobileNav({ groups }: { groups: DocNavGroup[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open docs menu">
          <MenuIcon />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[85vw] max-w-xs gap-0 overflow-y-auto">
        <SheetHeader className="border-b">
          <SheetTitle>Docs</SheetTitle>
          <SheetDescription className="sr-only">All documentation pages</SheetDescription>
        </SheetHeader>
        <div className="p-3">
          <DocsNav groups={groups} onNavigate={() => setOpen(false)} />
        </div>
        <div className="mt-auto border-t p-3">
          <Button asChild variant="outline" className="w-full">
            <Link href="/dashboard" onClick={() => setOpen(false)}>
              Open app
            </Link>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

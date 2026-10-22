"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@weaver/ui/components/tabs";
import { InvitesPanel } from "./invites-panel";
import { UsersTable } from "./users-table";

type Tab = "users" | "invites";

/** The Users and Invites tabs; the selected tab is mirrored into `?tab=` so reloads keep it. */
export function UsersTabs({ initialTab, currentUserId }: { initialTab: Tab; currentUserId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<Tab>(initialTab);

  function change(value: string) {
    const next: Tab = value === "invites" ? "invites" : "users";
    setTab(next);
    router.replace(next === "invites" ? `${pathname}?tab=invites` : pathname, { scroll: false });
  }

  return (
    <Tabs value={tab} onValueChange={change} className="gap-4">
      <TabsList>
        <TabsTrigger value="users">Users</TabsTrigger>
        <TabsTrigger value="invites">Invites</TabsTrigger>
      </TabsList>
      <TabsContent value="users">
        <UsersTable currentUserId={currentUserId} />
      </TabsContent>
      <TabsContent value="invites">
        <InvitesPanel />
      </TabsContent>
    </Tabs>
  );
}

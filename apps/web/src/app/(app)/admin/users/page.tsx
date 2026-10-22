import type { Metadata } from "next";
import { requireRole } from "@/server/session";
import { AdminPage } from "../_components/admin-page";
import { UsersTabs } from "./users-tabs";

export const metadata: Metadata = { title: "Users" };

/** User administration: the users table and the invites that let new people join. */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ user }, params] = await Promise.all([requireRole("admin", "/admin/users"), searchParams]);
  const tab = params.tab === "invites" ? "invites" : "users";
  return (
    <AdminPage title="Users" description="Who can sign in to this Weaver, with which role, and the invites that let new people join.">
      <UsersTabs initialTab={tab} currentUserId={user.id} />
    </AdminPage>
  );
}

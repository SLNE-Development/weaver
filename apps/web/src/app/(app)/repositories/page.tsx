import type { Metadata } from "next";
import { requireRole } from "@/server/session";
import { RepositoryList } from "./repository-list";

export const metadata: Metadata = { title: "Repositories" };

/** Every repository; admins also get storage numbers, settings and "New repository". `?create=1` opens the create dialog. */
export default async function RepositoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ user }, params] = await Promise.all([requireRole("viewer", "/repositories"), searchParams]);
  return <RepositoryList isAdmin={user.role === "admin"} openCreate={params.create === "1"} />;
}

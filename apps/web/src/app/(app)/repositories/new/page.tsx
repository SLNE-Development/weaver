import { redirect } from "next/navigation";
import { requireRole } from "@/server/session";

/** Old link target: repositories are created in a dialog on the list (admins only). */
export default async function NewRepositoryPage() {
  await requireRole("admin", "/repositories/new");
  redirect("/repositories?create=1");
}

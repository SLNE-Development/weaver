import type { Metadata } from "next";
import { requireRole } from "@/server/session";
import { api } from "@/trpc/server";
import { AdminPage } from "../_components/admin-page";
import { AnonymousViewSetting } from "./anonymous-view-setting";
import { DefaultCacheStorageSetting } from "./default-cache-storage-setting";

export const metadata: Metadata = { title: "Settings" };

/** Server-wide settings: anonymous view and the default cache storage of mirrors. */
export default async function SettingsPage() {
  const { settings } = await requireRole("admin", "/admin/settings");
  const storage = await api.settings.storage();
  return (
    <AdminPage title="Settings" description="Server-wide settings of this Weaver.">
      <div className="grid max-w-3xl gap-4">
        <AnonymousViewSetting initial={settings.anonymousView} />
        <DefaultCacheStorageSetting initial={settings.defaultCacheStore} primary={storage.primary} configured={storage.configured} />
      </div>
    </AdminPage>
  );
}

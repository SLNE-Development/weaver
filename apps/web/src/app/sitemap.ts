import type { MetadataRoute } from "next";
import { getSettings } from "@weaver/core";
import { listDocsPaths, listPublicBrowsePages, type BrowsePage } from "@/lib/public-catalog";
import { siteUrl } from "@/lib/seo";
import { getServerContext } from "@/server/context";

// URLs come from BETTER_AUTH_URL and the database at request time.
export const dynamic = "force-dynamic";

/**
 * Browse pages are listed only while "Allow anonymous view" is on (otherwise they need a login).
 * A database failure leaves them out instead of failing the whole sitemap.
 */
async function browsePages(): Promise<BrowsePage[]> {
  try {
    const { db, stores } = getServerContext();
    const settings = await getSettings(db, { primaryStore: stores.primary.id, configuredStores: stores.configured() });
    return settings.anonymousView ? await listPublicBrowsePages(db) : [];
  } catch (error) {
    console.error("sitemap: could not list browse pages", error);
    return [];
  }
}

/** sitemap.xml: the landing page, every docs page, and public browse pages when anonymous view is on. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [docs, browse] = await Promise.all([listDocsPaths(), browsePages()]);
  return [
    { url: siteUrl("/"), changeFrequency: "weekly", priority: 1 },
    ...docs.map((path) => ({ url: siteUrl(path), changeFrequency: "monthly" as const, priority: 0.7 })),
    ...browse.map((page) => ({
      url: siteUrl(page.path),
      ...(page.lastModified && { lastModified: page.lastModified }),
      changeFrequency: "daily" as const,
      priority: 0.5,
    })),
  ];
}

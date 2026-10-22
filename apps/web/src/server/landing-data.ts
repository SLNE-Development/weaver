import { getSettings } from "@weaver/core";
import { getPublicStats, type PublicStats } from "@/lib/public-catalog";
import { getServerContext } from "@/server/context";

export interface LandingData {
  signedIn: boolean;
  /** "Allow anonymous view": shows Browse links and public counts. */
  anonymousView: boolean;
  /** Public counts, only while anonymous view is on. */
  stats: PublicStats | null;
}

/**
 * Session, settings and public counts for the landing page. The page stays up when the database
 * isn't reachable: it then renders as for an anonymous visitor with anonymous view off.
 */
export async function loadLandingData(requestHeaders: Headers): Promise<LandingData> {
  const { auth, db, stores } = getServerContext();
  const [session, settings] = await Promise.all([
    auth.api.getSession({ headers: requestHeaders }).catch((error: unknown) => {
      console.error("landing: could not read the session", error);
      return null;
    }),
    getSettings(db, { primaryStore: stores.primary.id, configuredStores: stores.configured() }).catch((error: unknown) => {
      console.error("landing: could not read settings", error);
      return { anonymousView: false };
    }),
  ]);
  if (session) return { signedIn: true, anonymousView: settings.anonymousView, stats: null };
  if (!settings.anonymousView) return { signedIn: false, anonymousView: false, stats: null };
  const stats = await getPublicStats(db).catch((error: unknown) => {
    console.error("landing: could not count public artifacts", error);
    return null;
  });
  return { signedIn: false, anonymousView: true, stats };
}

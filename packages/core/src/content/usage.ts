import { eq, sql } from "drizzle-orm";
import { asset, component, usageEvent, type Db } from "@weaver/db";
import type { Principal } from "../permissions.js";

/** One download, upload or delete to record. */
export interface UsageInput {
  repositoryId: string | null;
  /** Defaults to the component of `assetId` when omitted. */
  componentId?: string | null;
  assetId?: string | null;
  path: string;
  action: "download" | "upload" | "delete";
  cache?: "hit" | "miss" | "bypass" | "stale";
  bytes?: number;
  principal: Principal;
}

/** The user and API key behind a principal, as stored on a usage event. */
function actorOf(p: Principal): { userId: string | null; apiKeyId: string | null } {
  switch (p.kind) {
    case "anonymous":
      return { userId: null, apiKeyId: null };
    case "user":
      return { userId: p.userId, apiKeyId: null };
    case "apikey":
      return { userId: p.userId, apiKeyId: p.keyId };
  }
}

/** Inserts a usage event and, for downloads, increments asset/component download counters and lastDownloadedAt. Never throws (logs). */
export async function recordUsage(db: Db, input: UsageInput): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const download = input.action === "download";
      let componentId = input.componentId;
      if (input.assetId) {
        const [row] = download
          ? await tx
              .update(asset)
              .set({ downloadCount: sql`${asset.downloadCount} + 1` })
              .where(eq(asset.id, input.assetId))
              .returning({ componentId: asset.componentId })
          : await tx.select({ componentId: asset.componentId }).from(asset).where(eq(asset.id, input.assetId));
        if (componentId === undefined) componentId = row?.componentId ?? null;
      }
      await tx.insert(usageEvent).values({
        repositoryId: input.repositoryId,
        componentId: componentId ?? null,
        path: input.path,
        action: input.action,
        cache: input.cache ?? null,
        bytes: input.bytes ?? 0,
        ...actorOf(input.principal),
      });
      if (download && componentId) {
        await tx
          .update(component)
          .set({ downloadCount: sql`${component.downloadCount} + 1`, lastDownloadedAt: new Date() })
          .where(eq(component.id, componentId));
      }
    });
  } catch (error) {
    console.warn(`weaver: failed to record ${input.action} of ${input.path}`, error);
  }
}

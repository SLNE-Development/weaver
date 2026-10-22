import { sql } from "drizzle-orm";
import type { Db, Tx } from "@weaver/db";

/**
 * Makes the components of image `image` in hosted repository `repoId` match its tags: one component per tag
 * (namespace "", name the image, version the tag), so package search finds pushed images. Tags of the cosign
 * tag scheme (`sha256-<hex>…`) are signatures and attestations, not versions. Run it after every tag write or
 * delete, inside the same transaction where there is one.
 */
export async function syncImageComponents(q: Db | Tx, repoId: string, image: string): Promise<void> {
  await q.execute(sql`
    DELETE FROM component c
    WHERE c.repository_id = ${repoId} AND c.namespace = '' AND c.name = ${image}
      AND NOT EXISTS (
        SELECT 1 FROM docker_tag t
        WHERE t.repository_id = c.repository_id AND t.image = c.name AND t.tag = c.version
          AND t.tag !~ '^sha256-[0-9a-f]{64}'
      )`);
  await q.execute(sql`
    INSERT INTO component (repository_id, namespace, name, version)
    SELECT t.repository_id, '', t.image, t.tag FROM docker_tag t
    WHERE t.repository_id = ${repoId} AND t.image = ${image} AND t.tag !~ '^sha256-[0-9a-f]{64}'
    ON CONFLICT (repository_id, namespace, name, version) DO NOTHING`);
}

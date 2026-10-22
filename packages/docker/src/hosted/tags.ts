import { and, asc, eq, gt, sql } from "drizzle-orm";
import { dockerBlobLink, dockerManifest, dockerTag, type Db } from "@weaver/db";
import { DockerError } from "../errors.js";
import { API_VERSION, type HostedReadCtx } from "./blobs.js";

/** The most tags one `tags/list` page returns. */
export const MAX_TAGS_PAGE = 1000;

/** Tags compare by bytes, not by the database locale. */
const tagC = sql`${dockerTag.tag} COLLATE "C"`;

/**
 * One page of the tags of repo/image in lexical (byte) order: at most `n` tags (unlimited when null, capped at
 * {@link MAX_TAGS_PAGE}) after `last`; `more` tells whether further tags follow.
 */
export async function listTags(
  db: Db,
  repoId: string,
  image: string,
  n: number | null,
  last: string | null,
): Promise<{ tags: string[]; more: boolean }> {
  const limit = Math.min(n ?? MAX_TAGS_PAGE, MAX_TAGS_PAGE);
  if (limit <= 0) return { tags: [], more: false };
  const rows = await db
    .select({ tag: dockerTag.tag })
    .from(dockerTag)
    .where(
      and(
        eq(dockerTag.repositoryId, repoId),
        eq(dockerTag.image, image),
        last === null ? undefined : gt(tagC, sql`${last} COLLATE "C"`),
      ),
    )
    .orderBy(asc(tagC))
    .limit(limit + 1);
  return { tags: rows.slice(0, limit).map((r) => r.tag), more: rows.length > limit };
}

/** Whether repo/image holds anything: a manifest or a linked blob. */
async function imageExists(db: Db, repoId: string, image: string): Promise<boolean> {
  const [manifest] = await db
    .select({ id: dockerManifest.id })
    .from(dockerManifest)
    .where(and(eq(dockerManifest.repositoryId, repoId), eq(dockerManifest.image, image)))
    .limit(1);
  if (manifest) return true;
  const [link] = await db
    .select({ digest: dockerBlobLink.digest })
    .from(dockerBlobLink)
    .where(and(eq(dockerBlobLink.repositoryId, repoId), eq(dockerBlobLink.image, image)))
    .limit(1);
  return link !== undefined;
}

/**
 * `GET .../tags/list?n=&last=`: `{name, tags}` with a `Link: <...>; rel="next"` header when more tags follow.
 * An image holding nothing is `404 NAME_UNKNOWN`; a non-numeric `n` is `400 UNSUPPORTED`.
 */
export async function serveTags(ctx: HostedReadCtx, req: Request): Promise<Response> {
  const { deps, target } = ctx;
  const params = new URL(req.url).searchParams;
  const rawN = params.get("n");
  if (rawN !== null && rawN !== "" && !/^\d+$/.test(rawN)) {
    throw new DockerError(400, "UNSUPPORTED", "n must be a non-negative integer", { n: rawN });
  }
  const n = rawN ? Number(rawN) : null;
  const last = params.get("last") || null;
  const page = await listTags(deps.db, target.repo.id, target.image, n, last);
  if (page.tags.length === 0 && !(await imageExists(deps.db, target.repo.id, target.image))) {
    throw new DockerError(404, "NAME_UNKNOWN", "repository name not known to registry", { name: target.name });
  }
  const headers: Record<string, string> = { ...API_VERSION, "content-type": "application/json" };
  if (page.more) {
    const pageSize = Math.min(n ?? MAX_TAGS_PAGE, MAX_TAGS_PAGE);
    const next = `n=${pageSize}&last=${encodeURIComponent(page.tags[page.tags.length - 1]!)}`;
    headers.link = `</v2/${target.name}/tags/list?${next}>; rel="next"`;
  }
  return new Response(JSON.stringify({ name: target.name, tags: page.tags }), { status: 200, headers });
}

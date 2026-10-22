import { env } from "@/env";
import { getDoc } from "@/lib/docs";
import { renderDocsOgCard } from "@/lib/docs-og";

export const runtime = "nodejs";
// The footer shows the instance host from the runtime BETTER_AUTH_URL, so never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * `GET /og/docs/<page path>`: the 1200×630 share card of a docs page ("Docs · <section>", title,
 * description). Unknown paths get a generic docs card. The docs pages reference it from their
 * metadata; it lives outside `/docs` because Next.js doesn't allow `opengraph-image` below an
 * optional catch-all segment.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params;
  const doc = getDoc(slug);
  return renderDocsOgCard(
    {
      eyebrow: doc ? `Docs · ${doc.section}` : "Docs",
      title: doc?.title ?? "Weaver docs",
      subtitle: doc?.description ?? "Host, mirror and group Maven, npm, Docker and proto repositories.",
      host: new URL(env.BETTER_AUTH_URL).host,
      path: doc?.path ?? "/docs",
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}

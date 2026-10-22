import { renderOgCard } from "@/lib/og";
import { OG_IMAGE_SIZE } from "@/lib/seo";

// The footer shows the instance host from BETTER_AUTH_URL, so render at request time.
export const dynamic = "force-dynamic";
export const alt = "Weaver: one registry for Maven, npm, Docker and proto";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

/** Share card of the landing page. */
export default function OpengraphImage() {
  return renderOgCard(
    {
      eyebrow: "Self-hosted repository manager",
      title: "One registry for Maven, npm, Docker and proto.",
      subtitle: "Host your own artifacts, mirror Maven Central, npmjs and Docker Hub with optional caching, and serve them all from one place.",
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}

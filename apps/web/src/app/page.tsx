import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { BrowsePreview } from "@/components/landing/browse-preview";
import { Clients } from "@/components/landing/clients";
import { loadLandingData } from "@/server/landing-data";
import { Features } from "@/components/landing/features";
import { Footer } from "@/components/landing/footer";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { InviteCta } from "@/components/landing/invite-cta";
import { SelfHosting } from "@/components/landing/self-hosting";
import { TopBar } from "@/components/landing/top-bar";
import { instanceHost, pageMetadata, SITE_DESCRIPTION, SITE_NAME, siteUrl } from "@/lib/seo";
import { getEnabledSocialProviders } from "@/server/auth";

// Session, settings and the instance URL are read per request.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return pageMetadata({
    title: "Weaver · Self-hosted Maven, npm, Docker and proto registry",
    absoluteTitle: true,
    description: SITE_DESCRIPTION,
    path: "/",
  });
}

/** schema.org description of the product for search engines. */
function JsonLd({ url }: { url: string }) {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url,
    description: SITE_DESCRIPTION,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Linux (Docker)",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
  // Escape "<" so the JSON can never close the script element.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

/** The public landing page. Signed-in users go straight to their dashboard. */
export default async function LandingPage() {
  const data = await loadLandingData(await headers());
  if (data.signedIn) redirect("/dashboard");

  const providers = getEnabledSocialProviders();
  const host = instanceHost();
  const origin = new URL(siteUrl()).origin;

  return (
    <>
      <JsonLd url={siteUrl()} />
      <TopBar showBrowse={data.anonymousView} />
      <main data-testid="landing">
        <Hero host={host} origin={origin} stats={data.stats} providers={providers} showBrowse={data.anonymousView} />
        <HowItWorks origin={origin} host={host} />
        <Clients origin={origin} />
        <BrowsePreview />
        <Features />
        <SelfHosting origin={origin} />
        <InviteCta providers={providers} />
      </main>
      <Footer host={host} />
    </>
  );
}

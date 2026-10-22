import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { DocsArticle } from "@/components/docs/docs-article";
import { DocsToc } from "@/components/docs/docs-toc";
import { env } from "@/env";
import { getDoc, listDocs, renderDoc, type DocMeta } from "@/lib/docs";

type Props = { params: Promise<{ slug?: string[] }> };

/** Every docs page. Pages render per request, because `{{url}}` comes from the runtime `BETTER_AUTH_URL`. */
export function generateStaticParams() {
  return listDocs().map((doc) => ({ slug: doc.slug }));
}

function publicUrl(path: string): string {
  return `${env.BETTER_AUTH_URL.replace(/\/+$/, "")}${path}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug = [] } = await params;
  const doc = getDoc(slug);
  if (!doc) return {};
  const url = publicUrl(doc.path);
  // Share card from /og/docs/…: Next.js doesn't allow opengraph-image below an optional catch-all.
  const image = { url: publicUrl(`/og${doc.path}`), width: 1200, height: 630, alt: `${doc.title} · Weaver docs` };
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      url,
      siteName: "Weaver",
      title: doc.title,
      description: doc.description,
      section: doc.section,
      images: [image],
    },
    twitter: { card: "summary_large_image", title: doc.title, description: doc.description, images: [image] },
  };
}

/** TechArticle and BreadcrumbList structured data for a page. */
function jsonLd(doc: DocMeta): string {
  const url = publicUrl(doc.path);
  const crumbs = [{ name: "Docs", path: "/docs" }, ...(doc.path === "/docs" ? [] : [{ name: doc.title, path: doc.path }])];
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: doc.title,
      description: doc.description,
      url,
      articleSection: doc.section,
      inLanguage: "en",
      isPartOf: { "@type": "WebSite", name: "Weaver", url: publicUrl("/") },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map((crumb, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: crumb.name,
        item: publicUrl(crumb.path),
      })),
    },
  ];
  // `<` is escaped so the JSON can never close the script element.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function DocPage({ params }: Props) {
  await connection();
  const { slug = [] } = await params;
  const doc = await renderDoc(slug, { url: env.BETTER_AUTH_URL });
  if (!doc) notFound();

  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_220px]">
      <article className="min-w-0 px-4 pt-8 pb-16 sm:px-8 lg:px-12">
        <div className="mx-auto max-w-[720px]">
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(doc) }} />
          <nav aria-label="Breadcrumb" className="mb-3 font-mono text-xs text-muted-foreground">
            <ol className="flex flex-wrap items-center gap-1.5">
              <li>
                <Link href="/docs" className="rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                  Docs
                </Link>
              </li>
              <li aria-hidden="true">/</li>
              <li>{doc.section}</li>
            </ol>
          </nav>
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.025em] sm:text-[32px]">{doc.title}</h1>
          <p className="mt-3 mb-8 text-[16px] leading-relaxed text-muted-foreground">{doc.description}</p>
          <DocsArticle html={doc.html} />
          {(doc.prev || doc.next) && (
            <nav aria-label="Previous and next page" className="mt-14 grid gap-3 border-t pt-8 sm:grid-cols-2">
              {doc.prev ? (
                <Link
                  href={doc.prev.path}
                  rel="prev"
                  className="grid gap-0.5 rounded-md border px-4 py-3 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span className="text-xs text-muted-foreground">Previous</span>
                  <span className="font-medium">{doc.prev.title}</span>
                </Link>
              ) : (
                <span className="hidden sm:block" />
              )}
              {doc.next && (
                <Link
                  href={doc.next.path}
                  rel="next"
                  className="grid gap-0.5 rounded-md border px-4 py-3 text-right transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span className="text-xs text-muted-foreground">Next</span>
                  <span className="font-medium">{doc.next.title}</span>
                </Link>
              )}
            </nav>
          )}
        </div>
      </article>
      <aside className="hidden border-l xl:block">
        <div className="sticky top-14 max-h-[calc(100svh-3.5rem)] overflow-y-auto px-5 py-8">
          <DocsToc headings={doc.headings} />
        </div>
      </aside>
    </div>
  );
}

import type { Metadata } from "next";
import { env } from "@/env";

export const SITE_NAME = "Weaver";
/** Meta description; at most 160 characters so search results show it whole. */
export const SITE_DESCRIPTION =
  "Self-hosted repository manager for Maven, npm, Docker and proto: host your artifacts, mirror upstream registries with optional caching and group them.";

/** Size of every share card (Open Graph and Twitter). */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

/**
 * The public base URL of this instance. Always `BETTER_AUTH_URL`, never the request host. The
 * localhost fallback only applies while `next build` runs without an environment
 * (`SKIP_ENV_VALIDATION`); at runtime the variable is validated as required.
 */
function baseUrl(): string {
  return env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

/** Absolute URL of `path` on this instance. */
export function siteUrl(path = "/"): string {
  return new URL(path.startsWith("/") ? path : `/${path}`, baseUrl()).toString();
}

/** Host (and port, if any) of this instance, as shown on share cards and in the footer. */
export function instanceHost(): string {
  return new URL(baseUrl()).host;
}

/**
 * Site-wide metadata for the root layout (`export function generateMetadata() { return defaultMetadata(); }`).
 * A function, not a constant, so the base URL is read at request time.
 */
export function defaultMetadata(): Metadata {
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    openGraph: { type: "website", siteName: SITE_NAME },
    twitter: { card: "summary_large_image" },
  };
}

export interface PageMetadataInput {
  title: string;
  description: string;
  /** Path of the page on this instance, e.g. `/docs/gradle`; becomes the canonical URL. */
  path: string;
  /** Share image path or URL. Omit to use the segment's `opengraph-image` file. */
  image?: string;
  /** For private pages: `noindex, nofollow`. */
  noindex?: boolean;
  /** Use `title` as is, without the "· Weaver" template. */
  absoluteTitle?: boolean;
}

/** Metadata of one page: title, description, canonical URL, Open Graph, Twitter card and robots. */
export function pageMetadata({ title, description, path, image, noindex, absoluteTitle }: PageMetadataInput): Metadata {
  const url = siteUrl(path);
  const images = image
    ? [{ url: image.startsWith("http") ? image : siteUrl(image), ...OG_IMAGE_SIZE, alt: title }]
    : undefined;
  return {
    // Repeated here (not only in the layout) so file-convention share images resolve on BETTER_AUTH_URL.
    metadataBase: new URL(siteUrl()),
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, siteName: SITE_NAME, title, description, ...(images && { images }) },
    twitter: { card: "summary_large_image", title, description, ...(images && { images }) },
    ...(noindex && { robots: { index: false, follow: false } }),
  };
}

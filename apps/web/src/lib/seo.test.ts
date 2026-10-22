import { describe, expect, it } from "vitest";
import { defaultMetadata, instanceHost, pageMetadata, SITE_DESCRIPTION, siteUrl } from "./seo";

// vitest.config.ts sets BETTER_AUTH_URL=http://localhost:3000.
describe("siteUrl", () => {
  it("builds absolute URLs on BETTER_AUTH_URL", () => {
    expect(siteUrl()).toBe("http://localhost:3000/");
    expect(siteUrl("/docs/gradle")).toBe("http://localhost:3000/docs/gradle");
    expect(siteUrl("docs")).toBe("http://localhost:3000/docs");
  });

  it("names the instance host", () => {
    expect(instanceHost()).toBe("localhost:3000");
  });
});

describe("SITE_DESCRIPTION", () => {
  it("fits a search result snippet (at most 160 characters)", () => {
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(160);
  });
});

describe("defaultMetadata", () => {
  it("sets the base URL, the title template and the share defaults", () => {
    const meta = defaultMetadata();
    expect(meta.metadataBase?.toString()).toBe("http://localhost:3000/");
    expect(meta.title).toEqual({ default: "Weaver", template: "%s · Weaver" });
    expect(meta.openGraph).toMatchObject({ siteName: "Weaver", type: "website" });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });
});

describe("pageMetadata", () => {
  it("fills title, description, canonical, Open Graph and Twitter for a public page", () => {
    const meta = pageMetadata({ title: "Gradle plugin", description: "Configure the plugin.", path: "/docs/gradle" });
    expect(meta.title).toBe("Gradle plugin");
    expect(meta.description).toBe("Configure the plugin.");
    expect(meta.alternates?.canonical).toBe("http://localhost:3000/docs/gradle");
    expect(meta.metadataBase?.toString()).toBe("http://localhost:3000/");
    expect(meta.openGraph).toMatchObject({
      type: "website",
      url: "http://localhost:3000/docs/gradle",
      siteName: "Weaver",
      title: "Gradle plugin",
      description: "Configure the plugin.",
    });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", title: "Gradle plugin" });
    expect(meta.robots).toBeUndefined();
  });

  it("uses an explicit share image for Open Graph and Twitter, made absolute", () => {
    const meta = pageMetadata({
      title: "economy-contracts 1.4.0",
      description: "d",
      path: "/browse/releases/dev.surf.economy/economy-contracts/1.4.0",
      image: "/og/artifact/releases/dev.surf.economy/economy-contracts/1.4.0",
    });
    const image = {
      url: "http://localhost:3000/og/artifact/releases/dev.surf.economy/economy-contracts/1.4.0",
      width: 1200,
      height: 630,
      alt: "economy-contracts 1.4.0",
    };
    expect(meta.openGraph?.images).toEqual([image]);
    expect(meta.twitter?.images).toEqual([image]);
  });

  it("leaves images to the opengraph-image file convention when none is given", () => {
    const meta = pageMetadata({ title: "t", description: "d", path: "/" });
    expect(meta.openGraph?.images).toBeUndefined();
    expect(meta.twitter?.images).toBeUndefined();
  });

  it("marks private pages noindex, nofollow", () => {
    const meta = pageMetadata({ title: "t", description: "d", path: "/browse/secret", noindex: true });
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it("can opt out of the title template", () => {
    const meta = pageMetadata({ title: "Weaver · registry", absoluteTitle: true, description: "d", path: "/" });
    expect(meta.title).toEqual({ absolute: "Weaver · registry" });
  });
});

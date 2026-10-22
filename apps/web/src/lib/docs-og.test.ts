import { afterEach, describe, expect, it, vi } from "vitest";

const og = vi.hoisted(() => ({ renderOgCard: vi.fn(async () => new Response("png")) }));

vi.mock("./og", () => og);

const { docsOgCardInput, renderDocsOgCard } = await import("./docs-og");

describe("docs share cards", () => {
  afterEach(() => {
    og.renderOgCard.mockClear();
  });

  it("map the docs content onto the shared card: host bottom left, page path bottom right", () => {
    expect(
      docsOgCardInput({
        eyebrow: "Docs · Clients",
        title: "Gradle plugin",
        subtitle: "Every option.",
        host: "protos.example.com",
        path: "/docs/clients/gradle",
      }),
    ).toEqual({
      eyebrow: "Docs · Clients",
      title: "Gradle plugin",
      subtitle: "Every option.",
      footer: "protos.example.com",
      meta: ["/docs/clients/gradle"],
    });
  });

  it("shorten long descriptions to 150 characters", () => {
    const input = docsOgCardInput({ eyebrow: "Docs", title: "t", subtitle: "x".repeat(200), host: "h", path: "/docs" });
    expect(input.subtitle).toBe(`${"x".repeat(147)}…`);
  });

  it("render through the one shared template, passing headers on", async () => {
    await renderDocsOgCard(
      { eyebrow: "Docs", title: "Weaver docs", subtitle: "s", host: "h", path: "/docs" },
      { headers: { "cache-control": "public, max-age=3600" } },
    );
    expect(og.renderOgCard).toHaveBeenCalledWith(
      { eyebrow: "Docs", title: "Weaver docs", subtitle: "s", footer: "h", meta: ["/docs"] },
      { headers: { "cache-control": "public, max-age=3600" } },
    );
  });
});

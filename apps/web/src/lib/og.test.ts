import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGO_INVERTED_SVG, renderOgCard } from "./og";

function normalizeSvg(svg: string): string {
  return svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

describe("share cards", () => {
  it("inline the same logo as packages/ui", async () => {
    const asset = await readFile(join(process.cwd(), "..", "..", "packages", "ui", "src", "assets", "weaver-icon-inverted.svg"), "utf8");
    expect(normalizeSvg(LOGO_INVERTED_SVG)).toBe(normalizeSvg(asset));
  });

  it("default to a short Cache-Control instead of next/og's immutable year", async () => {
    const response = await renderOgCard({ eyebrow: "e", title: "t" });
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
  });

  it("render a 1200×630 PNG with the bundled fonts", async () => {
    const response = await renderOgCard(
      { eyebrow: "Docs · Clients", title: "Gradle plugin", subtitle: "Every option.", meta: ["3 files"] },
      { headers: { "cache-control": "public, max-age=300" } },
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const png = Buffer.from(await response.arrayBuffer());
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    // IHDR: width and height as big-endian 32-bit integers at bytes 16..23.
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
});

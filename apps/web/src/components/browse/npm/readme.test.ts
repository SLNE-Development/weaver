import { describe, expect, it } from "vitest";
import { renderReadmeHtml } from "./readme";

describe("renderReadmeHtml", () => {
  it("script tags are stripped", async () => {
    const html = await renderReadmeHtml("<script>x</script># Hi");
    expect(html).not.toContain("<script");
    expect(await renderReadmeHtml("# Hi")).toContain("<h1>Hi</h1>");
  });

  it("drops event handlers and javascript links", async () => {
    const html = await renderReadmeHtml('[a](javascript:alert(1)) <img src=x onerror=alert(1)>\n\n[ok](https://example.com)');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
    expect(html).toContain('href="https://example.com"');
  });
});

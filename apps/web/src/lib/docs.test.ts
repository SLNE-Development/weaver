import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DOC_SECTIONS,
  docNavigation,
  docPath,
  fillUrl,
  findBrokenDocLinks,
  getDoc,
  listDocs,
  parseFrontmatter,
  renderDoc,
  searchIndex,
  slugFromFile,
} from "./docs";

/** The pages of the docs plan (plus server settings and the format client pages), in reading order. */
const PLAN = [
  "/docs",
  "/docs/join",
  "/docs/publish",
  "/docs/consume",
  "/docs/versions",
  "/docs/resolution",
  "/docs/validation",
  "/docs/gradle",
  "/docs/cli",
  "/docs/npm",
  "/docs/maven",
  "/docs/docker",
  "/docs/api",
  "/docs/admin/repositories",
  "/docs/admin/users",
  "/docs/admin/keys",
  "/docs/admin/cleanup",
  "/docs/admin/settings",
  "/docs/self-host/compose",
  "/docs/self-host/coolify",
  "/docs/self-host/config",
  "/docs/troubleshooting",
];

describe("parseFrontmatter", () => {
  it("reads title, description, section and order", () => {
    const { meta, body } = parseFrontmatter(
      "---\ntitle: Publish\ndescription: Ship it.\nsection: Getting started\norder: 3\n---\n\n# Body\n",
      "publish.md",
    );
    expect(meta).toEqual({ title: "Publish", description: "Ship it.", section: "Getting started", order: 3 });
    expect(body.trim()).toBe("# Body");
  });

  it("rejects a file without frontmatter", () => {
    expect(() => parseFrontmatter("# No frontmatter", "x.md")).toThrow(/x\.md.*frontmatter/);
  });

  it("rejects missing fields and unknown sections, naming the file", () => {
    expect(() => parseFrontmatter("---\ntitle: A\nsection: Concepts\norder: 1\n---\n", "a.md")).toThrow(/a\.md.*description/);
    expect(() =>
      parseFrontmatter("---\ntitle: A\ndescription: B\nsection: Recipes\norder: 1\n---\n", "a.md"),
    ).toThrow(/a\.md.*section/);
    expect(() =>
      parseFrontmatter("---\ntitle: A\ndescription: B\nsection: Concepts\norder: first\n---\n", "a.md"),
    ).toThrow(/a\.md.*order/);
  });
});

describe("slug mapping", () => {
  it("maps file paths to slugs and URLs", () => {
    expect(slugFromFile("index.md")).toEqual([]);
    expect(slugFromFile("publish.md")).toEqual(["publish"]);
    expect(slugFromFile("admin/keys.md")).toEqual(["admin", "keys"]);
    expect(slugFromFile("admin\\keys.md")).toEqual(["admin", "keys"]);
    expect(slugFromFile("admin/index.md")).toEqual(["admin"]);
    expect(docPath([])).toBe("/docs");
    expect(docPath(["admin", "keys"])).toBe("/docs/admin/keys");
  });
});

describe("fillUrl", () => {
  it("replaces every {{url}} with the instance URL without a trailing slash", () => {
    expect(fillUrl("export WEAVER_URL={{url}}\nopen {{url}}/docs", "https://protos.test/")).toBe(
      "export WEAVER_URL=https://protos.test\nopen https://protos.test/docs",
    );
  });

  it("replaces {{host}} with the host and port of the instance URL", () => {
    expect(fillUrl("{{host}} {", "https://protos.test:8443/")).toBe("protos.test:8443 {");
  });

  it("leaves text without placeholders alone", () => {
    expect(fillUrl("no placeholder {url}", "https://protos.test")).toBe("no placeholder {url}");
  });
});

describe("with a fixture docs directory", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "weaver-docs-"));
    await mkdir(join(dir, "admin"));
    const page = (title: string, section: string, order: number, body = "") =>
      `---\ntitle: ${title}\ndescription: About ${title}.\nsection: ${section}\norder: ${order}\n---\n\n${body}`;
    await writeFile(join(dir, "index.md"), page("Intro", "Getting started", 1, "See [keys](/docs/admin/keys#scopes)."));
    await writeFile(join(dir, "second.md"), page("Second", "Getting started", 2, "## Step one\n\n## Step two\n\n### Detail\n"));
    await writeFile(join(dir, "admin", "keys.md"), page("Keys", "Administration", 1, "## Scopes\n\nBroken [link](/docs/nope)."));
    await writeFile(join(dir, "concept.md"), page("Concept", "Concepts", 1, "Bad anchor [here](/docs/second#missing)."));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("orders pages by section, then order", () => {
    expect(listDocs(dir).map((d) => d.path)).toEqual(["/docs", "/docs/second", "/docs/concept", "/docs/admin/keys"]);
  });

  it("finds a page by slug", () => {
    expect(getDoc(["admin", "keys"], dir)?.title).toBe("Keys");
    expect(getDoc(["missing"], dir)).toBeUndefined();
  });

  it("groups the navigation by section in section order", () => {
    expect(docNavigation(dir).map((g) => [g.section, g.items.map((i) => i.title)])).toEqual([
      ["Getting started", ["Intro", "Second"]],
      ["Concepts", ["Concept"]],
      ["Administration", ["Keys"]],
    ]);
  });

  it("links each page to its neighbours", async () => {
    const first = await renderDoc([], { url: "https://x.test", dir });
    const middle = await renderDoc(["concept"], { url: "https://x.test", dir });
    const last = await renderDoc(["admin", "keys"], { url: "https://x.test", dir });
    expect(first?.prev).toBeUndefined();
    expect(first?.next?.path).toBe("/docs/second");
    expect(middle?.prev?.path).toBe("/docs/second");
    expect(middle?.next?.path).toBe("/docs/admin/keys");
    expect(last?.next).toBeUndefined();
  });

  it("collects h2 and h3 headings with ids for the table of contents", async () => {
    const doc = await renderDoc(["second"], { url: "https://x.test", dir });
    expect(doc?.headings).toEqual([
      { depth: 2, id: "step-one", text: "Step one" },
      { depth: 2, id: "step-two", text: "Step two" },
      { depth: 3, id: "detail", text: "Detail" },
    ]);
    expect(doc?.html).toContain('id="step-one"');
  });

  it("reports links to missing pages and missing anchors", async () => {
    expect(await findBrokenDocLinks(dir)).toEqual([
      { from: "/docs/admin/keys", href: "/docs/nope" },
      { from: "/docs/concept", href: "/docs/second#missing" },
    ]);
  });

  it("builds a search index with headings", async () => {
    const index = await searchIndex(dir);
    expect(index.find((e) => e.path === "/docs/second")).toMatchObject({
      title: "Second",
      section: "Getting started",
      headings: [
        { id: "step-one", text: "Step one" },
        { id: "step-two", text: "Step two" },
        { id: "detail", text: "Detail" },
      ],
    });
  });
});

describe("rendering", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "weaver-render-"));
    await writeFile(
      join(dir, "index.md"),
      [
        "---",
        "title: Render",
        "description: Rendering test.",
        "section: Help",
        "order: 1",
        "---",
        "",
        "Open {{url}}/login.",
        "",
        '```kotlin title="build.gradle.kts"',
        'weaver { url = "{{url}}" }',
        "```",
        "",
        "> [!WARNING]",
        "> **Careful.** Releases are permanent.",
        "",
        "| A | B |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "[External](https://example.com) and `inline code`.",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "steps.md"),
      "---\ntitle: Steps\ndescription: Steps test.\nsection: Help\norder: 2\n---\n\n## 2. Store the key\n",
    );
    await writeFile(
      join(dir, "unsafe.md"),
      [
        "---\ntitle: Unsafe\ndescription: Unsafe test.\nsection: Help\norder: 3\n---\n",
        "<script>alert(1)</script>",
        "",
        '<img src="x" onerror="alert(1)"> <iframe src="https://evil.test"></iframe>',
        "",
        "[js](javascript:alert(1)) [JS](JavaScript:alert(1)) [data](data:text/html,hi) ![img](javascript:alert(1))",
        "",
        "[mail](mailto:ops@protos.test) [docs](/docs)",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fills the instance URL into text and code", async () => {
    const doc = await renderDoc([], { url: "https://protos.test", dir });
    expect(doc?.html.replace(/<[^>]+>/g, "")).toContain("Open https://protos.test/login.");
    expect(doc?.html).not.toContain("{{url}}");
    // Highlighted code splits text into spans; strip tags to check the code content.
    expect(doc?.html.replace(/<[^>]+>/g, "")).toContain('weaver { url = "https://protos.test" }');
  });

  it("highlights code with light and dark colours, a title and a copy button", async () => {
    const doc = await renderDoc([], { url: "https://protos.test", dir });
    expect(doc?.html).toContain("--shiki-dark");
    expect(doc?.html).toContain("build.gradle.kts");
    expect(doc?.html).toContain("data-copy");
  });

  it("turns [!WARNING] blockquotes into callouts", async () => {
    const doc = await renderDoc([], { url: "https://protos.test", dir });
    expect(doc?.html).toMatch(/<div class="docs-callout docs-callout-warning" role="note">/);
    expect(doc?.html).not.toContain("[!WARNING]");
  });

  it("wraps tables for horizontal scrolling and marks external links", async () => {
    const doc = await renderDoc([], { url: "https://protos.test", dir });
    expect(doc?.html).toContain('<div class="docs-table">');
    expect(doc?.html).toContain('href="https://example.com" rel="noreferrer"');
  });

  it("renders a leading step number of a heading as a step marker", async () => {
    const doc = await renderDoc(["steps"], { url: "https://protos.test", dir });
    expect(doc?.headings).toEqual([{ depth: 2, id: "store-the-key", text: "Store the key" }]);
    expect(doc?.html).toContain('<h2 id="store-the-key"><span class="docs-step" aria-hidden="true">2</span>Store the key');
  });

  it("drops raw HTML and unsafe link schemes", async () => {
    const doc = await renderDoc(["unsafe"], { url: "https://protos.test", dir });
    expect(doc?.html).not.toMatch(/<script|onerror|<iframe/i);
    expect(doc?.html).not.toMatch(/javascript:|data:text/i);
    expect(doc?.html).toContain('<a href="mailto:ops@protos.test">');
    expect(doc?.html).toContain('<a href="/docs">');
  });

  it("keeps heading anchors out of the heading's accessible name", async () => {
    const doc = await renderDoc(["steps"], { url: "https://protos.test", dir });
    expect(doc?.html).toContain('<a class="docs-anchor" href="#store-the-key" aria-hidden="true" tabindex="-1">#</a>');
  });

  it("returns null for an unknown page", async () => {
    expect(await renderDoc(["nope"], { url: "https://protos.test", dir })).toBeNull();
  });
});

describe("the real docs", () => {
  let docs: ReturnType<typeof listDocs> = [];

  beforeAll(() => {
    docs = listDocs();
  });

  it("contain every page of the docs plan", () => {
    const paths = docs.map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(PLAN));
    expect(docs.length).toBeGreaterThanOrEqual(PLAN.length);
  });

  it("give every page a title, description, known section and order", () => {
    for (const doc of docs) {
      expect(doc.title.length, doc.file).toBeGreaterThan(0);
      expect(doc.description.length, doc.file).toBeGreaterThan(20);
      expect(DOC_SECTIONS, doc.file).toContain(doc.section);
      expect(Number.isFinite(doc.order), doc.file).toBe(true);
    }
  });

  it("keep orders unique within a section", () => {
    for (const section of DOC_SECTIONS) {
      const orders = docs.filter((d) => d.section === section).map((d) => d.order);
      expect(new Set(orders).size, section).toBe(orders.length);
    }
  });

  it("have no broken internal /docs links or anchors", async () => {
    expect(await findBrokenDocLinks()).toEqual([]);
  });

  it("never hardcode an instance URL", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const doc of docs) {
      const text = await readFile(doc.file, "utf8");
      expect(text, doc.file).not.toMatch(/weaver\.slne\.dev|protos\.example\.com|weaver\.example\.com/);
    }
  });

  it("config page documents every environment variable", async () => {
    const { readFile } = await import("node:fs/promises");
    const envFiles = [join(process.cwd(), "src", "env.ts"), join(process.cwd(), "..", "worker", "src", "env.ts")];
    const keys = new Set<string>();
    for (const file of envFiles) {
      for (const match of (await readFile(file, "utf8")).matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*z\./gm)) keys.add(match[1]!);
    }
    expect(keys.size).toBeGreaterThan(10);
    const config = await readFile(join(process.cwd(), "content", "docs", "self-host", "config.md"), "utf8");
    for (const key of keys) expect(config, key).toContain(`\`${key}\``);
  });

  it("self-hosting docs cover proxy body limits", async () => {
    const { readFile } = await import("node:fs/promises");
    const compose = await readFile(join(process.cwd(), "content", "docs", "self-host", "compose.md"), "utf8");
    const troubleshooting = await readFile(join(process.cwd(), "content", "docs", "troubleshooting.md"), "utf8");
    expect(compose).toContain("client_max_body_size 0");
    expect(compose).toContain("proxy_request_buffering off");
    expect(troubleshooting).toContain("413");
  });

  it("docs describe the upgrade from protoloom only as a data reset", async () => {
    const { readFile } = await import("node:fs/promises");
    const upgradePages = ["/docs/self-host/compose", "/docs/self-host/coolify"];
    for (const doc of docs) {
      const text = await readFile(doc.file, "utf8");
      if (!upgradePages.includes(doc.path)) {
        expect(text, doc.file).not.toMatch(/protoloom/i);
        continue;
      }
      expect(text, doc.file).toContain("drops repositories");
      // Protoloom is named only in the page's closing "Upgrading from Protoloom" section.
      const start = text.indexOf("## Upgrading from Protoloom");
      expect(start, doc.file).toBeGreaterThan(0);
      const section = text.slice(start);
      expect(section.slice(3).includes("\n## "), doc.file).toBe(false);
      expect(text.slice(0, start), doc.file).not.toMatch(/protoloom/i);
    }
  });

  it("render every page", async () => {
    for (const doc of docs) {
      const rendered = await renderDoc(doc.slug, { url: "https://protos.test" });
      expect(rendered?.html.length, doc.file).toBeGreaterThan(200);
      expect(rendered?.html, doc.file).not.toMatch(/\{\{(url|host)\}\}/);
    }
  }, 60_000);
});

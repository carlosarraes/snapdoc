import { describe, expect, it } from "vitest";
import { parseFrontmatter, renderMarkdown } from "../src/markdown";

describe("renderMarkdown", () => {
  it("produces a self-contained HTML document with rendered content", async () => {
    const { html } = await renderMarkdown("# Hello\n\nSome *emphasis* and `code`.", "My Doc");
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<style>");
    expect(html).toContain("<h1");
    expect(html).toContain("Hello");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<title>My Doc</title>");
  });

  it("escapes the title", async () => {
    const { html } = await renderMarkdown("body", "<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to a default title when none is given", async () => {
    const { html } = await renderMarkdown("body");
    expect(html).toMatch(/<title>.+<\/title>/);
  });

  it("renders tables and code blocks (GFM)", async () => {
    const { html } = await renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```");
    expect(html).toContain("<table>");
    expect(html).toContain("<pre>");
  });

  it("adds slug ids to headings", async () => {
    const { html } = await renderMarkdown("## Getting Started\n\ntext");
    expect(html).toContain('<h2 id="getting-started">');
  });

  it("disambiguates duplicate heading slugs", async () => {
    const { html } = await renderMarkdown("## Setup\n\na\n\n## Setup\n\nb");
    expect(html).toContain('<h2 id="setup">');
    expect(html).toContain('<h2 id="setup-2">');
  });

  describe("frontmatter", () => {
    it("uses the frontmatter title and strips the block", async () => {
      const { html, title } = await renderMarkdown("---\ntitle: From Frontmatter\n---\n# Body");
      expect(title).toBe("From Frontmatter");
      expect(html).toContain("<title>From Frontmatter</title>");
      expect(html).not.toContain("---");
      expect(html).not.toContain("title: From Frontmatter");
    });

    it("lets an explicit title override the frontmatter title", async () => {
      const { html, title } = await renderMarkdown("---\ntitle: FM\n---\n# Body", "Explicit");
      expect(html).toContain("<title>Explicit</title>");
      // returned title still reflects the frontmatter, for caller fallback logic
      expect(title).toBe("FM");
    });

    it("returns null title when there is no frontmatter", async () => {
      const { title } = await renderMarkdown("# Just a doc");
      expect(title).toBeNull();
    });
  });

  describe("table of contents", () => {
    it("emits a ToC of h2/h3 links when toc: true", async () => {
      const { html } = await renderMarkdown(
        "---\ntoc: true\n---\n## First\n\n### Nested\n\n## Second",
      );
      expect(html).toContain('<nav class="toc">');
      expect(html).toContain('href="#first"');
      expect(html).toContain('href="#nested"');
      expect(html).toContain('href="#second"');
    });

    it("omits the ToC when not requested", async () => {
      const { html } = await renderMarkdown("## First\n\n## Second");
      expect(html).not.toContain('<nav class="toc">');
    });
  });
});

describe("parseFrontmatter", () => {
  it("parses title and toc and returns the body", () => {
    const { meta, body } = parseFrontmatter('---\ntitle: "Quoted"\ntoc: true\n---\n# Hi\n');
    expect(meta.title).toBe("Quoted");
    expect(meta.toc).toBe(true);
    expect(body).toBe("# Hi\n");
  });

  it("returns the input unchanged when there is no frontmatter", () => {
    const { meta, body } = parseFrontmatter("# No frontmatter\n");
    expect(meta).toEqual({});
    expect(body).toBe("# No frontmatter\n");
  });

  it("treats an unterminated block as no frontmatter", () => {
    const src = "---\ntitle: oops\n# never closed";
    expect(parseFrontmatter(src).meta).toEqual({});
  });
});

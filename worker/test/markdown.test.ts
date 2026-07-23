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

  it("renders a mermaid fence as an accessible figure with escaped source fallback", async () => {
    const source = 'flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B';
    const { html } = await renderMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``);

    expect(html).toContain('data-snapdoc-mermaid="pending"');
    expect(html).toContain('id="snapdoc-mermaid-1"');
    expect(html).toContain('<details class="sd-mermaid-source" open>');
    expect(html).toContain('<code class="language-mermaid">');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('/review/mermaid-11.15.0.min.js');
    expect(html).toContain('integrity="sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF"');
    // SRI in the sandboxed review iframe (opaque origin) needs a CORS-mode
    // fetch, or the integrity check rejects the tainted response outright.
    expect(html).toMatch(/<script src="\/review\/mermaid-[^"]+" integrity="[^"]+" crossorigin="anonymous" defer>/);
    expect(html).toContain("securityLevel: \"strict\"");
    expect(html).toContain("htmlLabels: false");
  });

  it("loads the pinned runtime once for multiple mermaid fences", async () => {
    const { html } = await renderMarkdown(
      "```mermaid\nflowchart LR\nA-->B\n```\n\n```MERMAID\nsequenceDiagram\nA->>B: Hi\n```",
    );

    expect(html.match(/data-snapdoc-mermaid="pending"/g)).toHaveLength(2);
    expect(html).toContain('id="snapdoc-mermaid-1"');
    expect(html).toContain('id="snapdoc-mermaid-2"');
    expect(html.match(/\/review\/mermaid-11\.15\.0\.min\.js/g)).toHaveLength(1);
  });

  it("wraps schema references in later code blocks and inline code", async () => {
    const md = [
      "```python",
      "class QuoteResult(BaseModel):",
      "    id: UUID",
      "```",
      "",
      "```python",
      "async def get(self) -> QuoteResult: ...",
      "```",
      "",
      "The `QuoteResult` payload is returned as-is.",
    ].join("\n");
    const { html } = await renderMarkdown(md);

    const span = '<span class="sd-ref" data-sd-ref="QuoteResult" tabindex="0" role="button">QuoteResult</span>';
    // Later block + inline code span; the definition site itself stays plain
    // (hovering a declaration would just show the code already on screen).
    expect(html.match(/data-sd-ref="QuoteResult"/g)).toHaveLength(2);
    expect(html).toContain("class QuoteResult(BaseModel):");
    expect(html).toContain(`-&gt; ${span}: ...`);
    expect(html).toContain(`<code>${span}</code>`);
    // Undefined names stay completely unstyled.
    expect(html).not.toContain('data-sd-ref="BaseModel"');
    expect(html).not.toContain('data-sd-ref="UUID"');
    // Word boundaries hold at render level too.
    expect(html).not.toContain('data-sd-ref="Quote"');
    // Payload + bootstrap ship in <head>.
    expect(html).toContain('<script type="application/json" id="sd-ref-defs">');
    expect(html).toContain("class QuoteResult(BaseModel)");
  });

  it("keeps foreign schema names hoverable inside another definition", async () => {
    const md = [
      "```python",
      "class QuoteSummary(BaseModel):",
      "    id: UUID",
      "```",
      "",
      "```python",
      "class QuoteResult(QuoteSummary):",
      "    line_items: list",
      "```",
    ].join("\n");
    const { html } = await renderMarkdown(md);
    // The base-class mention references another schema — still hoverable.
    expect(html).toContain('data-sd-ref="QuoteSummary"');
    // Neither class is a ref at its own declaration.
    expect(html).not.toContain('data-sd-ref="QuoteResult"');
    expect(html.match(/data-sd-ref="QuoteSummary"/g)).toHaveLength(1);
  });

  it("emits no schema-ref markup, payload, or bootstrap without definitions", async () => {
    const { html } = await renderMarkdown("Just `SomeName` prose.\n\n```go\ntype S struct{}\n```");
    expect(html).not.toContain("data-sd-ref");
    expect(html).not.toContain('id="sd-ref-defs"');
    expect(html).not.toContain("getElementById"); // bootstrap absent
    expect(html).toContain("<code>SomeName</code>");
  });

  it("never wraps schema names inside mermaid figures", async () => {
    const md = [
      "```python",
      "class Browser:",
      "    pass",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  Browser-->API",
      "```",
    ].join("\n");
    const { html } = await renderMarkdown(md);
    const figure = html.slice(html.indexOf('<figure class="sd-mermaid"'), html.indexOf("</figure>"));
    expect(figure).toContain("Browser");
    expect(figure).not.toContain("sd-ref");
  });

  it("keeps escaping intact around wrapped names", async () => {
    const md = "```ts\ntype Flag = boolean;\n```\n\n```ts\nconst ok: Flag = a < b;\n```";
    const { html } = await renderMarkdown(md);
    expect(html).toContain("a &lt; b");
    expect(html).toContain('data-sd-ref="Flag"');
  });

  it("keeps ordinary fenced code behavior unchanged", async () => {
    const { html } = await renderMarkdown("```js\nconst diagram = 'mermaid';\n```");

    expect(html).toContain('<pre><code class="language-js">');
    expect(html).not.toContain("data-snapdoc-mermaid");
    expect(html).not.toContain("/review/mermaid-");
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

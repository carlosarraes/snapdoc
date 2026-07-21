import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";
import { htmlToMarkdown } from "../src/html-to-markdown";

// Round-trip-ish: markdown -> renderMarkdown (HTML) -> htmlToMarkdown (markdown).
// Output need not be byte-identical to the source; it must carry the semantic
// markdown and drop the HTML document wrapper (doctype/head/style) and the
// generated table of contents.
async function roundTrip(md: string): Promise<string> {
  const { html } = await renderMarkdown(md);
  return htmlToMarkdown(html);
}

describe("htmlToMarkdown", () => {
  it("drops the HTML document wrapper (doctype, head, style, tags)", async () => {
    const out = await roundTrip("# Hello\n\nWorld.");
    expect(out).not.toMatch(/<!doctype/i);
    expect(out).not.toContain("<style>");
    expect(out).not.toContain("color-scheme");
    expect(out).not.toContain("<h1");
    expect(out).toContain("World.");
  });

  it("converts headings to ATX markdown and strips the id attribute", async () => {
    const out = await roundTrip("# Title\n\n## Section");
    expect(out).toContain("# Title");
    expect(out).toContain("## Section");
    expect(out).not.toContain('id="');
  });

  it("converts inline emphasis, strong, and code", async () => {
    const out = await roundTrip("Some *emphasis*, **strong**, and `code`.");
    expect(out).toContain("*emphasis*");
    expect(out).toContain("**strong**");
    expect(out).toContain("`code`");
  });

  it("converts links and images", async () => {
    const out = await roundTrip("A [link](https://example.com) and ![alt](/img.png).");
    expect(out).toContain("[link](https://example.com)");
    expect(out).toContain("![alt](/img.png)");
  });

  it("converts GFM strikethrough", async () => {
    const out = await roundTrip("This is ~~gone~~.");
    expect(out).toContain("~~gone~~");
  });

  it("converts bullet and ordered lists", async () => {
    const out = await roundTrip("- one\n- two\n\n1. first\n2. second");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
    expect(out).toContain("1. first");
    expect(out).toContain("2. second");
  });

  it("converts blockquotes", async () => {
    const out = await roundTrip("> quoted line");
    expect(out).toContain("> quoted line");
  });

  it("preserves fenced code blocks with language and verbatim, unescaped content", async () => {
    const out = await roundTrip("```js\nconst x = 1 < 2;\n```");
    expect(out).toContain("```js");
    expect(out).toContain("const x = 1 < 2;");
  });

  it("reconstructs mermaid source without generated figure chrome", async () => {
    const source = "sequenceDiagram\n  Browser->>API: GET /deals\n  API-->>Browser: 200 OK";
    const out = htmlToMarkdown(`
      <figure class="sd-mermaid" data-snapdoc-mermaid="pending">
        <div class="sd-mermaid-output">generated label</div>
        <p class="sd-mermaid-error">Diagram could not be rendered.</p>
        <details class="sd-mermaid-source" open>
          <summary>Diagram source</summary>
          <pre><code class="language-mermaid">${source}</code></pre>
        </details>
      </figure>
    `);

    expect(out).toBe(`\`\`\`mermaid\n${source}\n\`\`\`\n`);
    expect(out).not.toContain("Diagram source");
    expect(out).not.toContain("could not be rendered");
  });

  it("converts GFM tables to pipe tables", async () => {
    const out = await roundTrip("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("| a | b |");
    expect(out).toMatch(/\|\s*---\s*\|/);
    expect(out).toContain("| 1 | 2 |");
  });

  it("drops the generated table of contents", async () => {
    const out = await roundTrip("---\ntoc: true\n---\n## First\n\n## Second");
    expect(out).not.toContain("Contents");
    expect(out).not.toContain("(#first)");
    expect(out).toContain("## First");
    expect(out).toContain("## Second");
  });

  it("handles arbitrary HTML-authored content (no body wrapper) without throwing", () => {
    const out = htmlToMarkdown("<h1>Raw</h1><p>Hello <b>world</b></p>");
    expect(out).toContain("# Raw");
    expect(out).toContain("Hello **world**");
  });
});

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

describe("renderMarkdown", () => {
  it("produces a self-contained HTML document with rendered content", async () => {
    const html = await renderMarkdown("# Hello\n\nSome *emphasis* and `code`.", "My Doc");
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("<style>");
    expect(html).toContain("<h1");
    expect(html).toContain("Hello");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<title>My Doc</title>");
  });

  it("escapes the title", async () => {
    const html = await renderMarkdown("body", '<script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to a default title when none is given", async () => {
    const html = await renderMarkdown("body");
    expect(html).toMatch(/<title>.+<\/title>/);
  });

  it("renders tables and code blocks (GFM)", async () => {
    const html = await renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```");
    expect(html).toContain("<table>");
    expect(html).toContain("<pre>");
  });
});

import { Marked } from "marked";

// Replaceable renderer: trusted markdown text -> self-contained styled HTML document.

const THEME_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 46rem;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1f2328; background: #ffffff;
}
h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 1.9rem; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.3em; }
h2 { font-size: 1.45rem; border-bottom: 1px solid #d1d9e0; padding-bottom: 0.3em; }
a { color: #0969da; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; background: #f0f1f3; padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: #f6f8fa; padding: 1rem; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 0; padding: 0 1em; color: #59636e; border-left: 0.25em solid #d1d9e0; }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid #d1d9e0; padding: 0.4em 0.8em; }
th { background: #f6f8fa; }
img { max-width: 100%; }
hr { border: none; border-top: 1px solid #d1d9e0; margin: 2rem 0; }
.toc { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 8px; padding: 0.75rem 1rem; margin: 0 0 1.75rem; }
.toc-title { font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: #59636e; margin-bottom: 0.4rem; }
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 0.15rem 0; }
.toc li.toc-h3 { padding-left: 1.1rem; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  h1, h2 { border-color: #30363d; }
  a { color: #4493f8; }
  code { background: #2a2f37; }
  pre { background: #161b22; }
  blockquote { color: #9198a1; border-color: #30363d; }
  th, td { border-color: #30363d; }
  th { background: #161b22; }
  hr { border-color: #30363d; }
  .toc { background: #161b22; border-color: #30363d; }
  .toc-title { color: #9198a1; }
}
`;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface Frontmatter {
  title?: string;
  toc?: boolean;
}

// Minimal leading `---` frontmatter parser. Recognizes only simple `key: value`
// scalars for the keys `title` and `toc`; no nested YAML, no dependency.
export function parseFrontmatter(src: string): { meta: Frontmatter; body: string } {
  const lines = src.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: src };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { meta: {}, body: src };

  const meta: Frontmatter = {};
  for (let i = 1; i < end; i++) {
    const colon = lines[i].indexOf(":");
    if (colon === -1) continue;
    const key = lines[i].slice(0, colon).trim();
    let val = lines[i].slice(colon + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "title") meta.title = val;
    else if (key === "toc") meta.toc = val === "true" || val === "yes";
  }
  return { meta, body: lines.slice(end + 1).join("\n") };
}

function slugify(text: string, seen: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

interface CollectedHeading {
  depth: number;
  slug: string;
  text: string;
}

function buildToc(headings: CollectedHeading[]): string {
  if (headings.length === 0) return "";
  const items = headings
    .map((h) => `<li class="toc-h${h.depth}"><a href="#${h.slug}">${h.text}</a></li>`)
    .join("");
  return `<nav class="toc"><div class="toc-title">Contents</div><ul>${items}</ul></nav>\n`;
}

// Renders trusted markdown into a self-contained HTML document. Adds slug ids to
// every heading; when frontmatter sets `toc: true`, prepends a table of contents
// for h2/h3. Returns the resolved frontmatter title so callers can fall back to
// it when no explicit title was supplied.
export async function renderMarkdown(
  markdown: string,
  title?: string,
): Promise<{ html: string; title: string | null }> {
  const { meta, body: src } = parseFrontmatter(markdown);

  // Request-local state: a fresh instance + closures keep heading/slug state
  // from leaking across requests (Workers reuse module globals).
  const headings: CollectedHeading[] = [];
  const seen = new Map<string, number>();
  const md = new Marked({ async: true, gfm: true });
  md.use({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        const slug = slugify(token.text, seen);
        if (token.depth === 2 || token.depth === 3) {
          headings.push({ depth: token.depth, slug, text: inner });
        }
        return `<h${token.depth} id="${slug}">${inner}</h${token.depth}>\n`;
      },
    },
  });

  const rendered = (await md.parse(src)) as string;
  const tocHtml = meta.toc ? buildToc(headings) : "";
  const effectiveTitle = title?.trim() || meta.title || "snapdoc artifact";
  const safeTitle = escapeHtml(effectiveTitle);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${safeTitle}</title>
<style>${THEME_CSS}</style>
</head>
<body>
${tocHtml}${rendered}</body>
</html>
`;
  return { html, title: meta.title ?? null };
}

import { Marked } from "marked";
import { extractDefinitions, serializeDefs, wrapCode } from "./schema-refs";

// Replaceable renderer: trusted markdown text -> self-contained styled HTML document.

export const MERMAID_VERSION = "11.15.0";
export const MERMAID_RUNTIME_PATH = `/review/mermaid-${MERMAID_VERSION}.min.js`;
export const MERMAID_RUNTIME_INTEGRITY =
  "sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF";
export const MERMAID_DOCUMENT_MARKER = `<meta name="snapdoc-mermaid" content="${MERMAID_VERSION}">`;

const MERMAID_BOOTSTRAP = `<script>
(() => {
  const figures = () => Array.from(document.querySelectorAll("[data-snapdoc-mermaid]"));
  const settle = () => {
    document.documentElement.dataset.snapdocMermaidSettled = "1";
    document.dispatchEvent(new CustomEvent("snapdoc:mermaid-settled"));
  };
  const fail = (figure) => {
    figure.dataset.snapdocMermaid = "failed";
    const error = figure.querySelector(".sd-mermaid-error");
    const source = figure.querySelector(".sd-mermaid-source");
    if (error) error.hidden = false;
    if (source) source.open = true;
  };
  const render = async () => {
    const diagrams = figures();
    const mermaidApi = globalThis.mermaid;
    if (!mermaidApi) {
      diagrams.forEach(fail);
      settle();
      return;
    }
    mermaidApi.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: 50000,
      maxEdges: 500,
      theme: "neutral",
      look: "classic",
      layout: "dagre",
      deterministicIds: true,
      secure: [
        "secure", "securityLevel", "startOnLoad", "htmlLabels",
        "suppressErrorRendering", "maxTextSize", "maxEdges",
        "dompurifyConfig", "theme", "themeCSS", "themeVariables",
        "fontFamily", "look", "layout", "deterministicIds"
      ]
    });
    for (let index = 0; index < diagrams.length; index++) {
      const figure = diagrams[index];
      const output = figure.querySelector(".sd-mermaid-output");
      const source = figure.querySelector(".sd-mermaid-source code")?.textContent ?? "";
      try {
        if (!output || !source) throw new Error("Missing Mermaid source or output target.");
        const result = await mermaidApi.render("snapdoc-mermaid-svg-" + (index + 1), source);
        output.innerHTML = result.svg;
        figure.dataset.snapdocMermaid = "rendered";
        const details = figure.querySelector(".sd-mermaid-source");
        if (details) details.open = false;
      } catch {
        fail(figure);
      }
    }
    settle();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void render(), { once: true });
  } else {
    void render();
  }
})();
</script>`;

// One shared tooltip driven by delegated events: hover/focus shows the
// definition, click (or Enter/Space) pins it so it can be scrolled and
// copied from, Esc or clicking away dismisses. Content is set via
// textContent only — the JSON payload never becomes markup.
const SCHEMA_REF_BOOTSTRAP = `<script>
(() => {
  const setup = () => {
    const holder = document.getElementById("sd-ref-defs");
    if (!holder || !document.querySelector(".sd-ref")) return;
    let defs;
    try { defs = JSON.parse(holder.textContent); } catch { return; }
    let tip = null, pinned = null;
    const ensure = () => {
      if (tip) return tip;
      tip = document.createElement("div");
      tip.className = "sd-ref-tooltip";
      tip.id = "sd-ref-tooltip";
      tip.setAttribute("role", "tooltip");
      const pre = document.createElement("pre");
      pre.appendChild(document.createElement("code"));
      tip.appendChild(pre);
      tip.hidden = true;
      document.body.appendChild(tip);
      return tip;
    };
    const show = (ref) => {
      const def = defs[ref.dataset.sdRef];
      if (!def) return;
      const t = ensure();
      t.querySelector("code").textContent = def.code;
      t.hidden = false;
      t.style.left = "0px";
      t.style.top = "0px";
      const rect = ref.getBoundingClientRect();
      const margin = 8;
      const maxLeft = scrollX + document.documentElement.clientWidth - t.offsetWidth - margin;
      t.style.left = Math.max(scrollX + margin, Math.min(rect.left + scrollX, maxLeft)) + "px";
      const below = rect.bottom + scrollY + 6;
      const fitsBelow = rect.bottom + t.offsetHeight + 12 <= innerHeight;
      const fitsAbove = rect.top - t.offsetHeight - 12 >= 0;
      t.style.top = (!fitsBelow && fitsAbove ? rect.top + scrollY - t.offsetHeight - 6 : below) + "px";
      ref.setAttribute("aria-describedby", "sd-ref-tooltip");
    };
    const hide = () => {
      if (pinned || !tip) return;
      tip.hidden = true;
      document.querySelectorAll('[aria-describedby="sd-ref-tooltip"]').forEach((el) => el.removeAttribute("aria-describedby"));
    };
    const unpin = () => {
      if (pinned) { delete pinned.dataset.sdPinned; pinned = null; }
      hide();
    };
    document.addEventListener("mouseover", (e) => { const r = e.target.closest?.(".sd-ref"); if (r && !pinned) show(r); });
    document.addEventListener("mouseout", (e) => { if (e.target.closest?.(".sd-ref")) hide(); });
    document.addEventListener("focusin", (e) => { const r = e.target.closest?.(".sd-ref"); if (r && !pinned) show(r); });
    document.addEventListener("focusout", (e) => { if (e.target.closest?.(".sd-ref")) hide(); });
    document.addEventListener("click", (e) => {
      const r = e.target.closest?.(".sd-ref");
      if (r) {
        if (pinned === r) { unpin(); return; }
        if (pinned) delete pinned.dataset.sdPinned;
        pinned = r;
        r.dataset.sdPinned = "1";
        show(r);
      } else if (!e.target.closest?.(".sd-ref-tooltip")) {
        unpin();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { unpin(); return; }
      const r = e.target.closest?.(".sd-ref");
      if (r && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        r.click();
      }
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup, { once: true });
  } else {
    setup();
  }
})();
</script>`;

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
.sd-mermaid { margin: 1.5rem 0; }
.sd-mermaid-output { overflow-x: auto; padding: 1rem; border: 1px solid #d1d9e0; border-radius: 8px; background: #fff; }
.sd-mermaid-output:empty { display: none; }
.sd-mermaid-output svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.sd-mermaid-error { color: #cf222e; margin: 0.5rem 0; }
.sd-mermaid-source { margin-top: 0.65rem; }
.sd-mermaid-source summary { cursor: pointer; color: #59636e; font-size: 0.9rem; }
.sd-mermaid-source pre { margin: 0.5rem 0 0; }
.sd-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.sd-ref { border-bottom: 1px dashed #0969da; cursor: help; }
.sd-ref:hover, .sd-ref:focus-visible, .sd-ref[data-sd-pinned] { background: rgba(9, 105, 218, 0.1); border-radius: 3px; }
.sd-ref-tooltip { position: absolute; z-index: 10; max-width: min(38rem, calc(100vw - 2rem)); max-height: 20rem; overflow: auto; background: #ffffff; border: 1px solid #d1d9e0; border-radius: 8px; box-shadow: 0 8px 24px rgba(140, 149, 159, 0.2); padding: 0.75rem 1rem; }
.sd-ref-tooltip pre { margin: 0; padding: 0; background: none; }
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
  .sd-mermaid-output { border-color: #30363d; }
  .sd-mermaid-source summary { color: #9198a1; }
  .sd-ref { border-color: #4493f8; }
  .sd-ref:hover, .sd-ref:focus-visible, .sd-ref[data-sd-pinned] { background: rgba(68, 147, 248, 0.15); }
  .sd-ref-tooltip { background: #161b22; border-color: #30363d; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }
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
  let mermaidCount = 0;
  const md = new Marked({ async: true, gfm: true });
  // Scan pass: collect Python/TS type definitions from fenced blocks so the
  // render pass can wrap every exact-name mention as a hoverable reference.
  const schemaDefs = extractDefinitions(md.lexer(src));
  const schemaNames = [...schemaDefs.keys()];
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
      code(token) {
        if ((token.lang ?? "").trim().toLowerCase() !== "mermaid") {
          if (schemaNames.length === 0 || token.escaped) return false;
          // Mirrors marked's default fenced-code output exactly, with schema
          // references wrapped; matching runs on the raw text before escaping.
          const langString = (token.lang ?? "").match(/^\S*/)?.[0] ?? "";
          const body = wrapCode(token.text.replace(/\n$/, "") + "\n", schemaNames, escapeHtml);
          if (!langString) return `<pre><code>${body}</code></pre>\n`;
          return `<pre><code class="language-${escapeHtml(langString)}">${body}</code></pre>\n`;
        }
        mermaidCount++;
        const id = `snapdoc-mermaid-${mermaidCount}`;
        const captionId = `${id}-caption`;
        return `<figure class="sd-mermaid" id="${id}" data-snapdoc-mermaid="pending" aria-labelledby="${captionId}">
<figcaption class="sd-visually-hidden" id="${captionId}">Mermaid diagram ${mermaidCount}. Diagram source follows.</figcaption>
<div class="sd-mermaid-output"></div>
<p class="sd-mermaid-error" role="status" hidden>Diagram could not be rendered. Source is shown below.</p>
<details class="sd-mermaid-source" open>
<summary>Diagram source</summary>
<pre><code class="language-mermaid">${escapeHtml(token.text)}\n</code></pre>
</details>
</figure>\n`;
      },
      codespan(token) {
        if (schemaNames.length === 0) return false;
        return `<code>${wrapCode(token.text, schemaNames, escapeHtml)}</code>`;
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
${mermaidCount > 0 ? `${MERMAID_DOCUMENT_MARKER}\n` : ""}<title>${safeTitle}</title>
<style>${THEME_CSS}</style>
${mermaidCount > 0 ? `<script src="${MERMAID_RUNTIME_PATH}" integrity="${MERMAID_RUNTIME_INTEGRITY}" crossorigin="anonymous" defer></script>\n${MERMAID_BOOTSTRAP}` : ""}
${schemaDefs.size > 0 ? `<script type="application/json" id="sd-ref-defs">${serializeDefs(schemaDefs)}</script>\n${SCHEMA_REF_BOOTSTRAP}` : ""}
</head>
<body>
${tocHtml}${rendered}</body>
</html>
`;
  return { html, title: meta.title ?? null };
}

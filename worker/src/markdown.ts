import { marked } from "marked";

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
}
`;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function renderMarkdown(markdown: string, title?: string): Promise<string> {
  const body = await marked.parse(markdown, { async: true, gfm: true });
  const safeTitle = escapeHtml(title?.trim() || "snapdoc artifact");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${safeTitle}</title>
<style>${THEME_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

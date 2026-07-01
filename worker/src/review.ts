// GET /review/:id — the trusted first-party review page (public, no Access).
// It renders the artifact in a sandboxed, cross-origin iframe alongside a comment
// rail, so it needs a looser CSP than artifact content: its own bundle may run,
// call the reader API, and frame the doc. The doc stays contained by its own
// (sandboxed) frame; this page holds the rail + viewer cookie.
import type { Context } from "hono";
import { escapeHtml } from "./markdown";
import type { Env } from "./types";

const ARTIFACT_ID = /^[A-Za-z0-9_-]{14}$/;

function reviewCsp(env: Env): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data:",
    `connect-src 'self' https://${env.API_HOST}`,
    // 'self' covers wrangler dev (single localhost origin); the artifact host
    // covers production, where the doc is genuinely cross-origin.
    `frame-src 'self' https://${env.ARTIFACT_HOST}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export async function serveReviewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const id = c.req.param("id");
  // /review/app.js, /review/annotator.js, /review/assets/* are static bundle
  // files, not pages — let the ASSETS binding resolve them.
  if (!id || !ARTIFACT_ID.test(id)) return c.env.ASSETS.fetch(c.req.raw);

  // Prod: review page on the API host, doc on the (cross-origin) artifact host, so
  // inject its absolute origin. Dev: wrangler serves both from localhost (and its
  // proxy mangles the request's port), so emit nothing — the rail falls back to
  // its own location.origin, which is same-origin as the doc there.
  const url = new URL(c.req.url);
  const artifactOrigin = url.hostname === c.env.API_HOST ? `https://${c.env.ARTIFACT_HOST}` : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Review — snapdoc</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="stylesheet" href="/review/app.css">
</head>
<body>
<div id="root" data-artifact-id="${escapeHtml(id)}" data-artifact-origin="${escapeHtml(artifactOrigin)}"></div>
<script type="module" src="/review/app.js"></script>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": reviewCsp(c.env),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
    },
  });
}

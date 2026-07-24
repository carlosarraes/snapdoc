// GET /review/:id — the trusted first-party review page (public, no Access).
// It renders the artifact in a sandboxed, cross-origin iframe alongside a comment
// rail, so it needs a looser CSP than artifact content: its own bundle may run,
// call the reader API, and frame the doc. The doc stays contained by its own
// (sandboxed) frame; this page holds the rail + viewer cookie.
import type { Context } from "hono";
import { escapeHtml } from "./markdown";
import { fetchStaticAsset, readCookie, unlockPage } from "./serve";
import { Store } from "./store";
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
  if (!id || !ARTIFACT_ID.test(id)) return fetchStaticAsset(c.req.raw, c.env);

  // Prod: review page on the API host, doc on the (cross-origin) artifact host, so
  // inject its absolute origin. Dev: wrangler serves both from localhost (and its
  // proxy mangles the request's port), so emit nothing — the rail falls back to
  // its own location.origin, which is same-origin as the doc there.
  const url = new URL(c.req.url);
  const artifactOrigin = url.hostname === c.env.API_HOST ? `https://${c.env.ARTIFACT_HOST}` : "";

  // Passcode-protected artifacts gate the shell itself. Unlock lives on the
  // artifact host (where the sd_unlock cookie is scoped), so the API-host copy
  // of a protected review page just points there.
  const store = new Store(c.env.DB, c.env.BLOBS);
  const gate = await store.getArtifactGate(id);
  let viewerToken = "";
  if (gate?.hasPasscode && gate.status === "active") {
    if (url.hostname === c.env.API_HOST) {
      return c.redirect(`https://${c.env.ARTIFACT_HOST}/review/${id}`, 302);
    }
    const cookie = readCookie(c.req.raw, `sd_unlock_${id}`);
    if (!cookie || !(await store.checkViewerToken(id, cookie))) {
      return unlockPage(id, { status: 200, error: false, next: `/review/${id}` });
    }
    // The sandboxed doc iframe cannot present the cookie (opaque origin), so
    // the rail appends this token — never the passcode — to the iframe URL.
    viewerToken = (await store.viewerToken(id)) ?? "";
  }

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
<div id="root" data-artifact-id="${escapeHtml(id)}" data-artifact-origin="${escapeHtml(artifactOrigin)}"${viewerToken ? ` data-viewer-token="${escapeHtml(viewerToken)}"` : ""}></div>
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

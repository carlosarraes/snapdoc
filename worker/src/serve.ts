// Artifact serving host: GET /:id and /:id/v/:n; everything else falls
// through to static assets (landing page).
import { escapeHtml } from "./markdown";
import { Store } from "./store";
import type { Env } from "./types";

const ID_PATTERN = /^\/([A-Za-z0-9_-]{14})(?:\/v\/(\d+))?$/;

// Self-contained inline CSS/JS may run, but the page gets no privileged
// reach: no external network targets beyond https/data images & fonts, no
// framing, no plugin content.
const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const BASE_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": ARTIFACT_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function statusPage(opts: { status: number; heading: string; message: string }): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(opts.heading)} — snapdoc</title>
<style>
body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: grid; place-items: center; min-height: 100vh; margin: 0; color: #1f2328; background: #f6f8fa; }
main { text-align: center; padding: 2rem; }
h1 { font-size: 1.6rem; }
p { color: #59636e; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(opts.heading)}</h1>
<p>${escapeHtml(opts.message)}</p>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: opts.status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function serveArtifactHost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Artifacts rarely declare their own icon, so browsers fall back to
  // /favicon.ico — answer with the snapdoc logo instead of a 404.
  if (url.pathname === "/favicon.ico") {
    const logo = await env.ASSETS.fetch(new Request(new URL("/logo.svg", url.origin)));
    if (logo.ok) {
      return new Response(logo.body, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
      });
    }
    return logo;
  }

  const match = ID_PATTERN.exec(url.pathname);
  if (!match) return env.ASSETS.fetch(request);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const [, id, versionStr] = match;
  const version = versionStr !== undefined ? Number(versionStr) : undefined;
  const store = new Store(env.DB, env.BLOBS);
  const content = await store.getServableContent(id, version);

  if (!content) {
    return statusPage({
      status: 404,
      heading: "Artifact not found",
      message: "This snapdoc link does not exist. Check the URL for typos.",
    });
  }
  if (content.state === "expired") {
    return statusPage({
      status: 410,
      heading: "Artifact expired",
      message: "This snapdoc artifact reached its retention period and is no longer available.",
    });
  }
  if (content.state === "deleted") {
    return statusPage({
      status: 410,
      heading: "Artifact removed",
      message: "This snapdoc artifact was deleted by its owner and is no longer available.",
    });
  }

  return new Response(request.method === "HEAD" ? null : content.html, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": `${content.contentType}; charset=utf-8`,
      "Cache-Control": "public, max-age=60",
    },
  });
}

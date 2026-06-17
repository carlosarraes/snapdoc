// Artifact serving host: GET /:id and /:id/v/:n; POST /:id/unlock for passcode
// entry; everything else falls through to static assets (landing page).
import { escapeHtml } from "./markdown";
import { Store } from "./store";
import type { Env } from "./types";

const ID_PATTERN = /^\/([A-Za-z0-9_-]{14})(?:\/v\/(\d+))?$/;
const UNLOCK_PATTERN = /^\/([A-Za-z0-9_-]{14})\/unlock$/;

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

// The unlock page is trusted snapdoc HTML (not user content), so it may submit
// a form back to its own origin — which the artifact CSP forbids.
const UNLOCK_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "frame-ancestors 'none'",
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

function unlockPage(id: string, opts: { status: number; error: boolean }): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Passcode required — snapdoc</title>
<style>
body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: grid; place-items: center; min-height: 100vh; margin: 0; color: #1f2328; background: #f6f8fa; }
main { text-align: center; padding: 2rem; max-width: 22rem; }
h1 { font-size: 1.4rem; }
p { color: #59636e; }
form { display: flex; gap: 0.5rem; margin-top: 1rem; }
input { flex: 1; padding: 0.5rem 0.7rem; font-size: 1rem; border: 1px solid #d1d9e0; border-radius: 6px; }
button { padding: 0.5rem 1rem; font-size: 1rem; border: 0; border-radius: 6px; background: #0969da; color: #fff; cursor: pointer; }
.error { color: #cf222e; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; } p { color: #9198a1; }
  input { background: #161b22; border-color: #30363d; color: #e6edf3; }
}
</style>
</head>
<body>
<main>
<h1>Passcode required</h1>
<p>This snapdoc artifact is protected.${opts.error ? ' <span class="error">Incorrect passcode.</span>' : ""}</p>
<form method="POST" action="/${id}/unlock">
<input type="password" name="passcode" aria-label="Passcode" autofocus required>
<button type="submit">Unlock</button>
</form>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: opts.status,
    headers: {
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": UNLOCK_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function handleUnlock(id: string, request: Request, store: Store): Promise<Response> {
  const gate = await store.getArtifactGate(id);
  if (!gate || gate.status === "deleted") {
    return statusPage({ status: 404, heading: "Artifact not found", message: "This snapdoc link does not exist." });
  }
  if (!gate.hasPasscode) {
    // Nothing to unlock — send them to the artifact.
    return Response.redirect(new URL(`/${id}`, request.url).toString(), 303);
  }
  const form = await request.formData();
  const passcode = String(form.get("passcode") ?? "");
  if (!(await store.verifyPasscode(id, passcode))) {
    return unlockPage(id, { status: 401, error: true });
  }
  const token = await store.viewerToken(id);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/${id}`,
      "Set-Cookie": `sd_unlock_${id}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/${id}; Max-Age=43200`,
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

  const store = new Store(env.DB, env.BLOBS);

  const unlockMatch = UNLOCK_PATTERN.exec(url.pathname);
  if (unlockMatch) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    return handleUnlock(unlockMatch[1], request, store);
  }

  const match = ID_PATTERN.exec(url.pathname);
  if (!match) return env.ASSETS.fetch(request);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const [, id, versionStr] = match;
  const version = versionStr !== undefined ? Number(versionStr) : undefined;

  const gate = await store.getArtifactGate(id);
  if (!gate) {
    return statusPage({
      status: 404,
      heading: "Artifact not found",
      message: "This snapdoc link does not exist. Check the URL for typos.",
    });
  }
  if (gate.status === "expired") {
    return statusPage({
      status: 410,
      heading: "Artifact expired",
      message: "This snapdoc artifact reached its retention period and is no longer available.",
    });
  }
  if (gate.status === "deleted") {
    return statusPage({
      status: 410,
      heading: "Artifact removed",
      message: "This snapdoc artifact was deleted by its owner and is no longer available.",
    });
  }

  if (gate.hasPasscode) {
    const cookie = readCookie(request, `sd_unlock_${id}`);
    const unlocked = cookie ? await store.checkViewerToken(id, cookie) : false;
    if (!unlocked) return unlockPage(id, { status: 200, error: false });
  }

  const content = await store.getServableContent(id, version);
  if (!content) {
    return statusPage({
      status: 404,
      heading: "Artifact not found",
      message: "This snapdoc link does not exist. Check the URL for typos.",
    });
  }
  if (content.state === "expired") {
    return statusPage({ status: 410, heading: "Artifact expired", message: "This snapdoc artifact is no longer available." });
  }
  if (content.state === "deleted") {
    return statusPage({ status: 410, heading: "Artifact removed", message: "This snapdoc artifact is no longer available." });
  }

  return new Response(request.method === "HEAD" ? null : content.html, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": `${content.contentType}; charset=utf-8`,
      // Never let a shared cache hold protected content — it could be served
      // to a viewer who never cleared the passcode.
      "Cache-Control": gate.hasPasscode ? "private, no-store" : "public, max-age=60",
    },
  });
}

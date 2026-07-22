// Artifact serving host: GET /:id and /:id/v/:n (document or video watch
// page); GET /:id/media/... and /:id/poster.... (video byte/poster streaming);
// POST /:id/unlock for passcode entry; everything else falls through to
// static assets (landing page).
import { buildMediaResponse, parseSingleRange, videoCacheControl } from "./media-range";
import { escapeHtml, MERMAID_DOCUMENT_MARKER, MERMAID_RUNTIME_PATH } from "./markdown";
import { Store, type Artifact, type ArtifactVersion } from "./store";
import { videoFileUrl, videoPosterUrl, videoVersionFileUrl, videoVersionPosterUrl } from "./http";
import { renderVideoPage, VIDEO_PAGE_CSP } from "./video-page";
import type { Env } from "./types";

const ID_PATTERN = /^\/([A-Za-z0-9_-]{14})(?:\/v\/(\d+))?$/;
const UNLOCK_PATTERN = /^\/([A-Za-z0-9_-]{14})\/unlock$/;
// Hosted asset: /{id}/a/{sha256} (the optional /v/{n} segment is accepted but
// cosmetic — assets are looked up by (id, hash), which is immutable).
const ASSET_PATTERN = /^\/([A-Za-z0-9_-]{14})(?:\/v\/\d+)?\/a\/([0-9a-f]{64})$/;
// Video byte-range media and poster routes. The filename/extension segment is
// presentation-only — it must match the stored version metadata exactly or
// the route 404s; it never selects the underlying R2 key.
const MEDIA_PATTERN = /^\/([A-Za-z0-9_-]{14})\/media\/([^/]+)$/;
const MEDIA_VERSION_PATTERN = /^\/([A-Za-z0-9_-]{14})\/v\/(\d+)\/media\/([^/]+)$/;
const POSTER_PATTERN = /^\/([A-Za-z0-9_-]{14})\/poster\.(jpg|png)$/;
const POSTER_VERSION_PATTERN = /^\/([A-Za-z0-9_-]{14})\/v\/(\d+)\/poster\.(jpg|png)$/;

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

// Static-asset fall-through for both hosts. The pinned Mermaid runtime alone
// gets ACAO: the sandboxed review iframe fetches it CORS-mode from an opaque
// origin, and SRI cannot validate the response unless it is CORS-readable.
const MERMAID_RUNTIME_ASSET = /^\/review\/mermaid-[\w.]+\.min\.js$/;

export async function fetchStaticAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (!response.ok || !MERMAID_RUNTIME_ASSET.test(new URL(request.url).pathname)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function artifactCsp(html: string, requestUrl: string): string {
  if (!html.includes(MERMAID_DOCUMENT_MARKER)) return ARTIFACT_CSP;
  const runtimeUrl = new URL(MERMAID_RUNTIME_PATH, requestUrl).toString();
  return ARTIFACT_CSP.replace("script-src 'unsafe-inline'", `script-src 'unsafe-inline' ${runtimeUrl}`);
}

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

// Assets are raw image bytes, not HTML — no CSP needed, but keep them
// unindexed, referrer-free, and immune to MIME sniffing.
const ASSET_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// Annotate-mode CSP: ARTIFACT_CSP with exactly two relaxations, so the review
// page may frame the doc and the first-party annotator script may load.
// connect-src stays unset, so the doc itself still cannot reach the network even
// here. The annotator loads same-origin ('self') — ASSETS serves it on either
// host. frame-ancestors allows 'self' (covers wrangler dev, where the review
// page shares the doc's origin) plus the API host (the prod review page).
function annotateCsp(apiHost: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'self'",
    "style-src 'unsafe-inline'",
    "img-src https: data: blob:",
    "font-src https: data:",
    "media-src https: data: blob:",
    `frame-ancestors 'self' https://${apiHost}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

// Appends the review annotator to a document served in annotate mode. Mirrors
// the HTMLRewriter streaming pattern in assets.ts; falls back to document end
// for raw-HTML artifacts that have no <body>. The src is relative so it loads
// from whichever host is serving the doc (ASSETS answers on both).
async function injectAnnotator(html: string): Promise<string> {
  const tag = `<script src="/review/annotator.js" defer></script>`;
  let bodySeen = false;
  const rewriter = new HTMLRewriter()
    .on(`script[src^="/review/mermaid-"]`, {
      // The review iframe is sandboxed without allow-same-origin, so its
      // origin is opaque and the runtime fetch is cross-origin; SRI rejects
      // the tainted no-CORS response unless the tag opts into CORS mode.
      // Stamped here so artifacts published before the fix work unmodified.
      element(el) {
        el.setAttribute("crossorigin", "anonymous");
      },
    })
    .on("body", {
      element(el) {
        bodySeen = true;
        el.append(tag, { html: true });
      },
    })
    .onDocument({
      end(end) {
        if (!bodySeen) end.append(tag, { html: true });
      },
    });
  return rewriter.transform(new Response(html)).text();
}

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

// Serves a hosted image. Reuses the artifact gate so an asset can never outlive
// or out-permission its page: same status (404/410) and passcode rules apply.
async function serveAsset(id: string, hash: string, request: Request, store: Store): Promise<Response> {
  const gate = await store.getArtifactGate(id);
  if (!gate) return new Response("Not found", { status: 404, headers: ASSET_HEADERS });
  if (gate.status === "expired" || gate.status === "deleted") {
    return new Response("Gone", { status: 410, headers: ASSET_HEADERS });
  }
  if (gate.hasPasscode) {
    const cookie = readCookie(request, `sd_unlock_${id}`);
    const unlocked = cookie ? await store.checkViewerToken(id, cookie) : false;
    if (!unlocked) return new Response("Unauthorized", { status: 401, headers: ASSET_HEADERS });
  }
  const asset = await store.getServableAsset(id, hash);
  if (!asset) return new Response("Not found", { status: 404, headers: ASSET_HEADERS });

  const headers: Record<string, string> = {
    ...ASSET_HEADERS,
    "Content-Type": asset.contentType,
    // Content-addressed → safe to cache forever; protected → never cache.
    "Cache-Control": gate.hasPasscode ? "private, no-store" : "public, max-age=31536000, immutable",
  };
  if (request.method === "HEAD") headers["Content-Length"] = String(asset.size);
  return new Response(request.method === "HEAD" ? null : asset.body, { status: 200, headers });
}

// ---- shared status/passcode gate ----
// Single source of truth for "does this id resolve to a servable artifact"
// (existence, expiry/deletion, passcode-unlock), used by the watch page and
// by every video byte/poster route so none of them re-implements the rules.
// `mode: "page"` answers rejections with the full trusted HTML pages the
// watch route already used; `mode: "plain"` answers with the same bare
// status responses `serveAsset` uses for binary resources.
type ArtifactGateResult =
  | { ok: true; artifact: Artifact; versions: ArtifactVersion[] }
  | { ok: false; response: Response };

async function gateArtifact(
  id: string,
  request: Request,
  store: Store,
  mode: "page" | "plain",
): Promise<ArtifactGateResult> {
  const record = await store.getArtifact(id);
  if (!record) {
    return {
      ok: false,
      response:
        mode === "page"
          ? statusPage({
              status: 404,
              heading: "Artifact not found",
              message: "This snapdoc link does not exist. Check the URL for typos.",
            })
          : new Response("Not found", { status: 404, headers: ASSET_HEADERS }),
    };
  }
  const { artifact } = record;
  if (artifact.status === "expired") {
    return {
      ok: false,
      response:
        mode === "page"
          ? statusPage({
              status: 410,
              heading: "Artifact expired",
              message: "This snapdoc artifact reached its retention period and is no longer available.",
            })
          : new Response("Gone", { status: 410, headers: ASSET_HEADERS }),
    };
  }
  if (artifact.status === "deleted") {
    return {
      ok: false,
      response:
        mode === "page"
          ? statusPage({
              status: 410,
              heading: "Artifact removed",
              message: "This snapdoc artifact was deleted by its owner and is no longer available.",
            })
          : new Response("Gone", { status: 410, headers: ASSET_HEADERS }),
    };
  }
  if (artifact.hasPasscode) {
    const cookie = readCookie(request, `sd_unlock_${id}`);
    const unlocked = cookie ? await store.checkViewerToken(id, cookie) : false;
    if (!unlocked) {
      return {
        ok: false,
        response:
          mode === "page"
            ? unlockPage(id, { status: 200, error: false })
            : new Response("Unauthorized", { status: 401, headers: ASSET_HEADERS }),
      };
    }
  }
  return { ok: true, artifact, versions: record.versions };
}

// Renders the video watch page. Reuses the same gate as the document path —
// callers only reach here once status/passcode have already cleared.
async function serveVideoWatchPage(
  request: Request,
  env: Env,
  store: Store,
  id: string,
  version: number | undefined,
  artifact: Artifact,
  versions: ArtifactVersion[],
): Promise<Response> {
  const resolvedVersion = version ?? artifact.currentVersion;
  const versionEntry = versions.find((v) => v.version === resolvedVersion);
  const video = versionEntry ? await store.getVideoVersion(id, resolvedVersion) : null;
  if (!versionEntry || !video) {
    return statusPage({
      status: 404,
      heading: "Artifact not found",
      message: "This snapdoc link does not exist. Check the URL for typos.",
    });
  }

  const mediaUrl =
    version !== undefined
      ? videoVersionFileUrl(id, resolvedVersion, video.filename, env)
      : videoFileUrl(id, video.filename, env);
  const posterUrl =
    version !== undefined
      ? videoVersionPosterUrl(id, resolvedVersion, video, env)
      : videoPosterUrl(id, video, env);

  const html = renderVideoPage({
    title: artifact.title,
    filename: video.filename,
    mediaUrl,
    posterUrl,
    durationMs: video.durationMs,
    sizeBytes: versionEntry.sizeBytes,
    expiresAt: artifact.expiresAt,
  });

  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": VIDEO_PAGE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": artifact.hasPasscode ? "private, no-store" : videoCacheControl(artifact.expiresAt),
    },
  });
}

// Streams a video's primary MP4 bytes, honoring a single `Range:` header.
// Never reads env.BLOBS directly — all bytes come through the Store seam
// (headVideoObject for size/etag, getVideoObject for the body).
async function serveVideoMedia(
  request: Request,
  store: Store,
  id: string,
  version: number | undefined,
  filename: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const gated = await gateArtifact(id, request, store, "plain");
  if (!gated.ok) return gated.response;
  const { artifact, versions } = gated;

  const resolvedVersion = version ?? artifact.currentVersion;
  const versionEntry = versions.find((v) => v.version === resolvedVersion);
  if (!versionEntry) return new Response("Not found", { status: 404, headers: ASSET_HEADERS });
  const video = await store.getVideoVersion(id, resolvedVersion);
  // The URL's filename is presentation-only: it must match the stored
  // version metadata exactly, never used to pick the R2 key.
  if (!video || video.filename !== filename) {
    return new Response("Not found", { status: 404, headers: ASSET_HEADERS });
  }

  const head = await store.headVideoObject(id, resolvedVersion);
  if (!head) return new Response("Not found", { status: 404, headers: ASSET_HEADERS });

  const range = parseSingleRange(request.headers.get("Range"), head.size);
  const spec = buildMediaResponse({
    range,
    size: head.size,
    contentType: "video/mp4",
    etag: head.httpEtag,
    cors: !artifact.hasPasscode,
    cacheControl: artifact.hasPasscode ? "private, no-store" : videoCacheControl(artifact.expiresAt),
  });

  // HEAD (and an unsatisfiable range) never need the body — GET and HEAD
  // otherwise get identical headers from the same buildMediaResponse call.
  if (request.method === "HEAD" || range.kind === "invalid") {
    return new Response(null, { status: spec.status, headers: spec.headers });
  }

  const object =
    range.kind === "partial"
      ? await store.getVideoObject(id, resolvedVersion, { offset: range.offset, length: range.length })
      : await store.getVideoObject(id, resolvedVersion);
  if (!object) return new Response("Not found", { status: 404, headers: ASSET_HEADERS });

  return new Response(object.body, { status: spec.status, headers: spec.headers });
}

// Serves a video's poster image. Posters never support byte ranges (Store
// exposes no ranged read for them), so this always answers with the full
// image or a 404 — no 206/416 path here.
async function serveVideoPoster(
  request: Request,
  store: Store,
  id: string,
  version: number | undefined,
  ext: "jpg" | "png",
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const gated = await gateArtifact(id, request, store, "plain");
  if (!gated.ok) return gated.response;
  const { artifact, versions } = gated;

  const resolvedVersion = version ?? artifact.currentVersion;
  const versionEntry = versions.find((v) => v.version === resolvedVersion);
  if (!versionEntry) return new Response("Not found", { status: 404, headers: ASSET_HEADERS });
  const video = await store.getVideoVersion(id, resolvedVersion);
  const expectedExt = video?.posterContentType === "image/jpeg" ? "jpg" : video?.posterContentType === "image/png" ? "png" : null;
  if (!video || !expectedExt || expectedExt !== ext) {
    return new Response("Not found", { status: 404, headers: ASSET_HEADERS });
  }

  const poster = await store.getPosterObject(id, resolvedVersion);
  if (!poster) return new Response("Not found", { status: 404, headers: ASSET_HEADERS });

  const headers: Record<string, string> = {
    "Content-Type": video.posterContentType!,
    "Content-Disposition": "inline",
    ETag: poster.httpEtag,
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": artifact.hasPasscode ? "private, no-store" : videoCacheControl(artifact.expiresAt),
    "Content-Length": String(poster.size),
  };
  if (!artifact.hasPasscode) headers["Access-Control-Allow-Origin"] = "*";

  return new Response(request.method === "HEAD" ? null : poster.body, { status: 200, headers });
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

  // The dashboard lives only on the API host. Never serve its assets from the
  // public artifact origin (they'd be unauthenticated and non-functional here).
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return statusPage({
      status: 404,
      heading: "Not found",
      message: "This page does not exist on the artifact host.",
    });
  }

  const store = new Store(env.DB, env.BLOBS);

  const unlockMatch = UNLOCK_PATTERN.exec(url.pathname);
  if (unlockMatch) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    return handleUnlock(unlockMatch[1], request, store);
  }

  const assetMatch = ASSET_PATTERN.exec(url.pathname);
  if (assetMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    return serveAsset(assetMatch[1], assetMatch[2], request, store);
  }

  // Video media/poster patterns are more specific than the generic /:id
  // pattern below (which has no trailing segments), so they must be checked
  // first — a document artifact hitting one of these simply 404s (no
  // video_versions row to match against).
  const mediaVersionMatch = MEDIA_VERSION_PATTERN.exec(url.pathname);
  if (mediaVersionMatch) {
    const [, id, versionStr, filename] = mediaVersionMatch;
    return serveVideoMedia(request, store, id, Number(versionStr), filename);
  }
  const mediaMatch = MEDIA_PATTERN.exec(url.pathname);
  if (mediaMatch) {
    const [, id, filename] = mediaMatch;
    return serveVideoMedia(request, store, id, undefined, filename);
  }
  const posterVersionMatch = POSTER_VERSION_PATTERN.exec(url.pathname);
  if (posterVersionMatch) {
    const [, id, versionStr, ext] = posterVersionMatch;
    return serveVideoPoster(request, store, id, Number(versionStr), ext as "jpg" | "png");
  }
  const posterMatch = POSTER_PATTERN.exec(url.pathname);
  if (posterMatch) {
    const [, id, ext] = posterMatch;
    return serveVideoPoster(request, store, id, undefined, ext as "jpg" | "png");
  }

  const match = ID_PATTERN.exec(url.pathname);
  if (!match) return fetchStaticAsset(request, env);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const [, id, versionStr] = match;
  const version = versionStr !== undefined ? Number(versionStr) : undefined;

  const gated = await gateArtifact(id, request, store, "page");
  if (!gated.ok) return gated.response;
  const { artifact: gate, versions: gatedVersions } = gated;

  if (gate.kind === "video") {
    return serveVideoWatchPage(request, env, store, id, version, gate, gatedVersions);
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

  // Annotate mode (framed by the review page): inject the annotator and relax
  // the CSP just enough to be framed by, and load its script from, the API host.
  // Only honored when the owner opted in; the bare /:id stays pristine.
  if (url.searchParams.get("annotate") === "1" && gate.commentsEnabled) {
    const body = request.method === "HEAD" ? null : await injectAnnotator(content.html);
    return new Response(body, {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "Content-Security-Policy": annotateCsp(env.API_HOST),
        "Content-Type": `${content.contentType}; charset=utf-8`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  return new Response(request.method === "HEAD" ? null : content.html, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Security-Policy": artifactCsp(content.html, request.url),
      "Content-Type": `${content.contentType}; charset=utf-8`,
      // Never let a shared cache hold protected content — it could be served
      // to a viewer who never cleared the passcode.
      "Cache-Control": gate.hasPasscode ? "private, no-store" : "public, max-age=60",
    },
  });
}

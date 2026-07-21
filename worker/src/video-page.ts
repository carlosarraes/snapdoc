// Trusted watch page for video artifacts: server-rendered snapdoc HTML (never
// user markup), so it may use inline styles but must still escape every
// user-supplied string (title, filename) before interpolating it.
import { escapeHtml } from "./markdown";

// default-src 'none' blocks scripts outright (no script-src is granted), so
// this page can only ever be as trusted as its own template — media/img are
// scoped to 'self' (the artifact host serving them), matching the CSP the
// document watch pages use for everything else.
export const VIDEO_PAGE_CSP = [
  "default-src 'none'",
  "media-src 'self'",
  "img-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface VideoPageData {
  title: string | null;
  filename: string;
  mediaUrl: string;
  posterUrl: string | null;
  durationMs: number;
  sizeBytes: number;
  expiresAt: string;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatSize(sizeBytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatExpiry(expiresAt: string): string {
  return new Date(expiresAt).toUTCString();
}

export function renderVideoPage(data: VideoPageData): string {
  const heading = escapeHtml(data.title ?? data.filename);
  const filename = escapeHtml(data.filename);
  const mediaUrl = escapeHtml(data.mediaUrl);
  const posterAttr = data.posterUrl ? ` poster="${escapeHtml(data.posterUrl)}"` : "";
  const duration = formatDuration(data.durationMs);
  const size = formatSize(data.sizeBytes);
  const expiry = escapeHtml(formatExpiry(data.expiresAt));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${heading} — snapdoc</title>
<style>
body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: grid; place-items: center; min-height: 100vh; margin: 0; color: #1f2328; background: #f6f8fa; }
main { text-align: center; padding: 2rem; max-width: 48rem; width: 100%; box-sizing: border-box; }
h1 { font-size: 1.4rem; word-break: break-word; }
video { width: 100%; max-height: 70vh; background: #000; border-radius: 8px; }
p.meta { color: #59636e; font-size: 0.9rem; }
p.download a { color: #0969da; }
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; } p.meta { color: #9198a1; }
}
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
<video controls preload="metadata"${posterAttr}>
<source src="${mediaUrl}" type="video/mp4">
Your browser does not support embedded video. <a href="${mediaUrl}">Download ${filename}</a>.
</video>
<p class="meta">${filename} &middot; ${duration} &middot; ${size} &middot; Expires ${expiry}</p>
<p class="download"><a href="${mediaUrl}" download>Download original file</a></p>
</main>
</body>
</html>
`;
}

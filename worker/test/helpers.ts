import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";
import { Store } from "../src/store";

// The workers pool runtime has no filesystem access, so binary test fixtures
// are base64-encoded in vitest.config.ts and handed over as env bindings (see
// test/video.test.ts and test/store.test.ts for the same pattern).
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// A small, valid H.264+AAC MP4: 320x180, 1000ms duration. Good enough for
// API-level contract tests, which never inspect codec/dimension internals
// (that belongs to test/video.test.ts).
export function videoFixtureBytes(): Uint8Array {
  return decodeBase64(env.FIXTURE_VIDEO_H264_AAC_B64);
}

// A valid MP4 container with a VP9 (not H.264) video track — used at the API
// level to prove `unsupported_video_codec` (not `invalid_video`) reaches the
// client with a stable, parser-internals-free message.
export function unsupportedCodecVideoFixtureBytes(): Uint8Array {
  return decodeBase64(env.FIXTURE_VIDEO_VP9_B64);
}

export const API_BASE = "https://api.snapdoc.carraes.dev";
export const ARTIFACT_BASE = "https://snapdoc.carraes.dev";
export const HTML_BODY = "<!doctype html><html><body><h1>report</h1></body></html>";

export function store() {
  return new Store(env.DB, env.BLOBS);
}

export async function mintToken(name = `tok-${crypto.randomUUID()}`) {
  return store().mintToken(name);
}

export interface PublishOptions {
  token?: string;
  body?: string;
  contentType?: string;
  title?: string;
  ttl?: string;
  id?: string;
  comments?: boolean;
  passcode?: string;
}

export async function publish(opts: PublishOptions & { token: string }) {
  const params = new URLSearchParams();
  if (opts.title !== undefined) params.set("title", opts.title);
  if (opts.ttl !== undefined) params.set("ttl", opts.ttl);
  if (opts.comments !== undefined) params.set("comments", opts.comments ? "1" : "0");
  const query = params.size ? `?${params}` : "";
  const path = opts.id ? `/v1/artifacts/${opts.id}/versions` : "/v1/artifacts";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": opts.contentType ?? "text/html",
  };
  if (opts.passcode) headers["X-Snapdoc-Passcode"] = opts.passcode;
  return SELF.fetch(`${API_BASE}${path}${query}`, {
    method: "POST",
    headers,
    body: opts.body ?? HTML_BODY,
  });
}

export interface PublishVideoOptions {
  token: string;
  bytes?: Uint8Array;
  // undefined -> derive from `bytes` (the common case); null -> omit the
  // Content-Length header entirely, to exercise the "missing length" path;
  // any number -> send exactly that declared length regardless of the
  // actual body size, to exercise the "oversize declared length" path
  // without needing to stream 100+ MB in a test.
  contentLength?: number | null;
  filename?: string;
  title?: string;
  ttl?: string;
  id?: string;
  comments?: boolean;
  passcode?: string;
}

// Publishes (or adds a version of) a video artifact. The body is always a
// ReadableStream — never a plain Uint8Array/Blob — so the runtime never
// auto-computes a Content-Length out from under the test; the header below
// (or its absence) is the only source of truth, matching a real streamed
// upload and the route's own "never buffer the video body" contract.
export async function publishVideo(opts: PublishVideoOptions) {
  const bytes = opts.bytes ?? videoFixtureBytes();
  const params = new URLSearchParams();
  if (opts.title !== undefined) params.set("title", opts.title);
  if (opts.ttl !== undefined) params.set("ttl", opts.ttl);
  if (opts.comments !== undefined) params.set("comments", opts.comments ? "1" : "0");
  if (opts.filename !== undefined) params.set("filename", opts.filename);
  const query = params.size ? `?${params}` : "";
  const path = opts.id ? `/v1/artifacts/${opts.id}/versions` : "/v1/artifacts";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": "video/mp4",
  };
  if (opts.passcode) headers["X-Snapdoc-Passcode"] = opts.passcode;
  const contentLength = opts.contentLength === undefined ? bytes.byteLength : opts.contentLength;
  // A Blob-backed stream has a runtime-visible known length, which R2's
  // put() requires to actually store the upload — needed for every test that
  // expects Store to run (success, and the oversize-declared-length case,
  // where the explicit header below still wins over the blob's real size).
  // Omitting Content-Length entirely (the "missing length" case) instead
  // uses a plain generator stream: it has no fetch-visible known length, so
  // the runtime never infers/injects its own header, and the route rejects
  // the request before ever touching the body or Store.
  let body: ReadableStream;
  if (contentLength !== null) {
    headers["Content-Length"] = String(contentLength);
    body = new Blob([bytes]).stream();
  } else {
    body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  return SELF.fetch(`${API_BASE}${path}${query}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

export async function uploadPoster(opts: {
  token: string;
  id: string;
  version: number;
  bytes: Uint8Array;
  contentType?: string;
  contentLength?: number;
}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    "Content-Type": opts.contentType ?? "image/jpeg",
    "Content-Length": String(opts.contentLength ?? opts.bytes.byteLength),
  };
  return SELF.fetch(`${API_BASE}/v1/artifacts/${opts.id}/versions/${opts.version}/poster`, {
    method: "PUT",
    headers,
    body: opts.bytes,
  });
}

// Minimal valid magic-byte prefixes so the server's content sniff accepts them.
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
export const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
export const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

export interface MultipartAsset {
  ref: string;
  bytes: Uint8Array;
  contentType?: string;
}

export async function publishMultipart(opts: {
  token: string;
  doc: string;
  docType?: string;
  assets: MultipartAsset[];
  title?: string;
  ttl?: string;
  id?: string;
  passcode?: string;
}) {
  const form = new FormData();
  form.set("document", new Blob([opts.doc], { type: opts.docType ?? "text/html" }), "document");
  for (const a of opts.assets) {
    form.append("image", new Blob([a.bytes], { type: a.contentType ?? "application/octet-stream" }), a.ref);
  }
  const params = new URLSearchParams();
  if (opts.title !== undefined) params.set("title", opts.title);
  if (opts.ttl !== undefined) params.set("ttl", opts.ttl);
  const query = params.size ? `?${params}` : "";
  const path = opts.id ? `/v1/artifacts/${opts.id}/versions` : "/v1/artifacts";
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
  if (opts.passcode) headers["X-Snapdoc-Passcode"] = opts.passcode;
  // Do not set Content-Type: fetch derives multipart/form-data + boundary.
  return SELF.fetch(`${API_BASE}${path}${query}`, { method: "POST", headers, body: form });
}

export async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body;
}

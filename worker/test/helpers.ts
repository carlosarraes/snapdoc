import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";
import { Store } from "../src/store";

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

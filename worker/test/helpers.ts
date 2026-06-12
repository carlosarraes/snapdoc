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
}

export async function publish(opts: PublishOptions & { token: string }) {
  const params = new URLSearchParams();
  if (opts.title !== undefined) params.set("title", opts.title);
  if (opts.ttl !== undefined) params.set("ttl", opts.ttl);
  const query = params.size ? `?${params}` : "";
  const path = opts.id ? `/v1/artifacts/${opts.id}/versions` : "/v1/artifacts";
  return SELF.fetch(`${API_BASE}${path}${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": opts.contentType ?? "text/html",
    },
    body: opts.body ?? HTML_BODY,
  });
}

export async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body;
}

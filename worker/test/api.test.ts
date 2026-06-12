import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, HTML_BODY, expectError, mintToken, publish, store } from "./helpers";

interface ArtifactJson {
  id: string;
  url: string;
  title: string | null;
  status: string;
  current_version: number;
  content_type: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
  token_name?: string;
}

describe("POST /v1/artifacts", () => {
  it("publishes HTML and returns a v1 artifact object", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token, title: "Q3 plan", ttl: "7d" });
    expect(res.status).toBe(201);
    const art = (await res.json()) as ArtifactJson;
    expect(art.id).toMatch(/^[A-Za-z0-9_-]{14}$/);
    expect(art.url).toBe(`https://snapdoc.carraes.dev/${art.id}`);
    expect(art.title).toBe("Q3 plan");
    expect(art.status).toBe("active");
    expect(art.current_version).toBe(1);
    expect(art.content_type).toBe("text/html");
    expect(art.size_bytes).toBe(HTML_BODY.length);
    expect(art.token_name).toBeUndefined();
    const expiresIn = new Date(art.expires_at).getTime() - new Date(art.created_at).getTime();
    expect(expiresIn).toBe(7 * 86400 * 1000);
  });

  it("defaults the TTL to 14 days", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token });
    const art = (await res.json()) as ArtifactJson;
    const expiresIn = new Date(art.expires_at).getTime() - new Date(art.created_at).getTime();
    expect(expiresIn).toBe(14 * 86400 * 1000);
  });

  it("renders markdown server-side and stores HTML", async () => {
    const tok = await mintToken();
    const res = await publish({
      token: tok.token,
      contentType: "text/markdown",
      body: "# Heading\n\nparagraph",
      title: "md doc",
    });
    expect(res.status).toBe(201);
    const art = (await res.json()) as ArtifactJson;
    expect(art.content_type).toBe("text/html");
    const content = await store().getServableContent(art.id);
    expect(content?.state).toBe("active");
    if (content?.state === "active") {
      expect(content.html).toMatch(/^<!doctype html>/i);
      expect(content.html).toContain("Heading");
      expect(content.html).toContain("<title>md doc</title>");
    }
  });

  it("accepts content types with charset parameters", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token, contentType: "text/html; charset=utf-8" });
    expect(res.status).toBe(201);
  });

  it("rejects missing, invalid, and revoked tokens", async () => {
    const noAuth = await SELF.fetch(`${API_BASE}/v1/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "text/html" },
      body: HTML_BODY,
    });
    await expectError(noAuth, 401, "unauthorized");

    const bad = await publish({ token: "sd_live_wrong" });
    await expectError(bad, 401, "unauthorized");

    const tok = await mintToken();
    await store().revokeToken(tok.id);
    const revoked = await publish({ token: tok.token });
    await expectError(revoked, 401, "unauthorized");
  });

  it("rejects unsupported content types", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token, contentType: "application/json", body: "{}" });
    await expectError(res, 400, "unsupported_content_type");
  });

  it("rejects bodies over 2 MB", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token, body: "x".repeat(2 * 1024 * 1024 + 1) });
    await expectError(res, 413, "too_large");
  });

  it("rejects empty bodies", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token, body: "" });
    await expectError(res, 400, "invalid_request");
  });

  it("rejects TTLs outside 1h-90d and malformed TTLs", async () => {
    const tok = await mintToken();
    for (const ttl of ["30m", "91d", "0h", "bogus", "-1d"]) {
      const res = await publish({ token: tok.token, ttl });
      await expectError(res, 400, "invalid_ttl");
    }
    for (const ttl of ["1h", "90d", "36h"]) {
      const res = await publish({ token: tok.token, ttl });
      expect(res.status).toBe(201);
    }
  });

  it("rejects titles over 200 characters", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token, title: "t".repeat(201) });
    await expectError(res, 400, "invalid_request");
  });

  it("returns 429 with Retry-After when over the publish rate limit", async () => {
    const tok = await mintToken();
    for (let i = 0; i < 100; i++) await store().recordPublish(tok.id);
    const res = await publish({ token: tok.token });
    await expectError(res, 429, "rate_limited");
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });
});

describe("POST /v1/artifacts/{id}/versions", () => {
  it("creates v2 at the stable id", async () => {
    const tok = await mintToken();
    const created = (await (await publish({ token: tok.token, title: "v1 title" })).json()) as ArtifactJson;
    const res = await publish({ token: tok.token, id: created.id, body: "<p>v2</p>" });
    expect(res.status).toBe(201);
    const updated = (await res.json()) as ArtifactJson;
    expect(updated.id).toBe(created.id);
    expect(updated.current_version).toBe(2);
    expect(updated.url).toBe(created.url);
    expect(updated.title).toBe("v1 title");
    expect(updated.size_bytes).toBe("<p>v2</p>".length);
  });

  it("allows a different token to update (single-team trust model)", async () => {
    const tokA = await mintToken();
    const tokB = await mintToken();
    const created = (await (await publish({ token: tokA.token })).json()) as ArtifactJson;
    const res = await publish({ token: tokB.token, id: created.id });
    expect(res.status).toBe(201);
  });

  it("404s on unknown ids and 409s on deleted artifacts", async () => {
    const tok = await mintToken();
    const missing = await publish({ token: tok.token, id: "AAAAAAAAAAAAAA" });
    await expectError(missing, 404, "not_found");

    const created = (await (await publish({ token: tok.token })).json()) as ArtifactJson;
    await store().deleteArtifact(created.id);
    const res = await publish({ token: tok.token, id: created.id });
    await expectError(res, 409, "not_active");
  });

  it("reactivates an expired artifact", async () => {
    const tok = await mintToken();
    const created = (await (await publish({ token: tok.token })).json()) as ArtifactJson;
    await store().expireArtifact(created.id);
    const res = await publish({ token: tok.token, id: created.id, body: "<p>back</p>" });
    expect(res.status).toBe(201);
    const updated = (await res.json()) as ArtifactJson;
    expect(updated.status).toBe("active");
    expect(new Date(updated.expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("GET /v1/artifacts", () => {
  async function list(token: string, query = "") {
    const res = await SELF.fetch(`${API_BASE}/v1/artifacts${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { artifacts: ArtifactJson[]; next_cursor: string | null };
  }

  it("lists only the calling token's artifacts, newest first", async () => {
    const tokA = await mintToken();
    const tokB = await mintToken();
    const a = (await (await publish({ token: tokA.token })).json()) as ArtifactJson;
    await publish({ token: tokB.token });
    const body = await list(tokA.token);
    expect(body.artifacts.map((x) => x.id)).toEqual([a.id]);
    expect(body.next_cursor).toBeNull();
    expect(body.artifacts[0].token_name).toBeUndefined();
  });

  it("filters by status and paginates with cursors", async () => {
    const tok = await mintToken();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(((await (await publish({ token: tok.token })).json()) as ArtifactJson).id);
    }
    await store().expireArtifact(ids[0]);

    const expired = await list(tok.token, "?status=expired");
    expect(expired.artifacts.map((x) => x.id)).toEqual([ids[0]]);

    const page1 = await list(tok.token, "?limit=2");
    expect(page1.artifacts).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = await list(tok.token, `?limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`);
    expect(page2.artifacts).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
  });

  it("rejects invalid limit and requires auth", async () => {
    const tok = await mintToken();
    const res = await SELF.fetch(`${API_BASE}/v1/artifacts?limit=999`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    await expectError(res, 400, "invalid_request");
    const unauth = await SELF.fetch(`${API_BASE}/v1/artifacts`);
    await expectError(unauth, 401, "unauthorized");
  });
});

describe("GET /v1/artifacts/{id}", () => {
  it("returns metadata plus version list", async () => {
    const tok = await mintToken();
    const created = (await (await publish({ token: tok.token })).json()) as ArtifactJson;
    await publish({ token: tok.token, id: created.id, body: "<p>v2</p>" });
    const res = await SELF.fetch(`${API_BASE}/v1/artifacts/${created.id}`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: ArtifactJson;
      versions: { version: number; size_bytes: number; content_type: string; created_at: string }[];
    };
    expect(body.artifact.current_version).toBe(2);
    expect(body.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(body.versions[0].size_bytes).toBe(HTML_BODY.length);
  });

  it("404s on unknown ids", async () => {
    const tok = await mintToken();
    const res = await SELF.fetch(`${API_BASE}/v1/artifacts/AAAAAAAAAAAAAA`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    await expectError(res, 404, "not_found");
  });
});

describe("expire and delete", () => {
  it("expire is idempotent and 409s after delete", async () => {
    const tok = await mintToken();
    const created = (await (await publish({ token: tok.token })).json()) as ArtifactJson;
    const expireUrl = `${API_BASE}/v1/artifacts/${created.id}/expire`;
    const auth = { Authorization: `Bearer ${tok.token}` };

    const first = await SELF.fetch(expireUrl, { method: "POST", headers: auth });
    expect(first.status).toBe(200);
    expect(((await first.json()) as ArtifactJson).status).toBe("expired");

    const second = await SELF.fetch(expireUrl, { method: "POST", headers: auth });
    expect(second.status).toBe(200);
    expect(((await second.json()) as ArtifactJson).status).toBe("expired");

    await store().deleteArtifact(created.id);
    const third = await SELF.fetch(expireUrl, { method: "POST", headers: auth });
    await expectError(third, 409, "not_active");
  });

  it("delete is idempotent and 404s on unknown ids", async () => {
    const tok = await mintToken();
    const created = (await (await publish({ token: tok.token })).json()) as ArtifactJson;
    const url = `${API_BASE}/v1/artifacts/${created.id}`;
    const auth = { Authorization: `Bearer ${tok.token}` };

    const first = await SELF.fetch(url, { method: "DELETE", headers: auth });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ id: created.id, status: "deleted" });

    const second = await SELF.fetch(url, { method: "DELETE", headers: auth });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ id: created.id, status: "deleted" });

    const missing = await SELF.fetch(`${API_BASE}/v1/artifacts/AAAAAAAAAAAAAA`, { method: "DELETE", headers: auth });
    await expectError(missing, 404, "not_found");
  });
});

describe("path-based fallback for local dev", () => {
  it("routes /v1/* on an unknown host to the API", async () => {
    const tok = await mintToken();
    const res = await SELF.fetch("http://localhost/v1/artifacts", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.token}`, "Content-Type": "text/html" },
      body: HTML_BODY,
    });
    expect(res.status).toBe(201);
  });
});

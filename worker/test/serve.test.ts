import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ARTIFACT_BASE, HTML_BODY, mintToken, publish, store } from "./helpers";

async function publishedId(opts: { body?: string; title?: string } = {}): Promise<string> {
  const tok = await mintToken();
  const res = await publish({ token: tok.token, ...opts });
  const { id } = (await res.json()) as { id: string };
  return id;
}

describe("artifact serving", () => {
  it("serves the latest version of an active artifact with security headers", async () => {
    const id = await publishedId();
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML_BODY);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("'unsafe-inline'");
  });

  it("serves version-pinned reads at /:id/v/:n", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token });
    const { id } = (await res.json()) as { id: string };
    await publish({ token: tok.token, id, body: "<p>v2</p>" });

    const v1 = await SELF.fetch(`${ARTIFACT_BASE}/${id}/v/1`);
    expect(v1.status).toBe(200);
    expect(await v1.text()).toBe(HTML_BODY);

    const v2 = await SELF.fetch(`${ARTIFACT_BASE}/${id}/v/2`);
    expect(await v2.text()).toBe("<p>v2</p>");

    const latest = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    expect(await latest.text()).toBe("<p>v2</p>");

    const missing = await SELF.fetch(`${ARTIFACT_BASE}/${id}/v/99`);
    expect(missing.status).toBe(404);
  });

  it("returns 410 with a friendly expired page for expired artifacts", async () => {
    const id = await publishedId();
    await store().expireArtifact(id);
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("expired");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const pinned = await SELF.fetch(`${ARTIFACT_BASE}/${id}/v/1`);
    expect(pinned.status).toBe(410);
  });

  it("returns 410 with a distinct page for deleted artifacts", async () => {
    const id = await publishedId();
    await store().deleteArtifact(id);
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("deleted");
    expect(html.toLowerCase()).not.toContain("expired");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns a friendly 404 for unknown ids", async () => {
    const res = await SELF.fetch(`${ARTIFACT_BASE}/AAAAAAAAAAAAAA`);
    expect(res.status).toBe(404);
    expect((await res.text()).toLowerCase()).toContain("not found");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("serves the landing page on / and non-ID paths via assets", async () => {
    const res = await SELF.fetch(`${ARTIFACT_BASE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("snapdoc");
    const short = await SELF.fetch(`${ARTIFACT_BASE}/about`);
    expect(short.status).not.toBe(500);
  });

  it("serves artifacts by path on unknown hosts (local dev fallback)", async () => {
    const id = await publishedId();
    const res = await SELF.fetch(`http://localhost/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML_BODY);
  });

  it("rejects non-GET methods on artifact paths", async () => {
    const id = await publishedId();
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}`, { method: "POST", body: "x" });
    expect(res.status).toBe(405);
  });
});

describe("annotate mode", () => {
  it("injects the annotator and relaxes the CSP when comments are enabled", async () => {
    const tok = await mintToken();
    const { id } = (await (await publish({ token: tok.token, comments: true })).json()) as { id: string };

    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}?annotate=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/review/annotator.js");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors https://api.snapdoc.carraes.dev");
    expect(csp).toContain("script-src 'unsafe-inline' https://api.snapdoc.carraes.dev");
    // connect-src stays unset, so the doc still cannot reach the network.
    expect(csp).not.toContain("connect-src");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps the canonical /:id pristine (no annotator, strict CSP, cacheable)", async () => {
    const tok = await mintToken();
    const { id } = (await (await publish({ token: tok.token, comments: true })).json()) as { id: string };
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    expect(await res.text()).not.toContain("/review/annotator.js");
    expect(res.headers.get("Content-Security-Policy")!).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("ignores ?annotate=1 unless the owner enabled comments", async () => {
    const tok = await mintToken();
    const { id } = (await (await publish({ token: tok.token })).json()) as { id: string };
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}?annotate=1`);
    expect(await res.text()).not.toContain("/review/annotator.js");
    expect(res.headers.get("Content-Security-Policy")!).toContain("frame-ancestors 'none'");
  });
});

describe("favicon fallback", () => {
  // Artifacts rarely declare an icon, so browsers request /favicon.ico on the
  // artifact host; answer with the snapdoc logo instead of a 404 globe.
  it("serves the logo SVG at /favicon.ico", async () => {
    const res = await SELF.fetch(`${ARTIFACT_BASE}/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("svg");
  });
});

describe("admin paths are not served on the artifact host", () => {
  it("returns 404 for /admin and /admin/* on the artifact origin", async () => {
    for (const path of ["/admin", "/admin/", "/admin/assets/app.js"]) {
      const res = await SELF.fetch(`${ARTIFACT_BASE}${path}`);
      expect(res.status).toBe(404);
    }
  });
});

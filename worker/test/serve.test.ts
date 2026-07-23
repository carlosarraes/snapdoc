import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, ARTIFACT_BASE, HTML_BODY, mintToken, publish, publishVideo, store } from "./helpers";

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

  it("allows only the pinned self-hosted Mermaid runtime for Mermaid documents", async () => {
    const tok = await mintToken();
    const { id } = (await (
      await publish({
        token: tok.token,
        contentType: "text/markdown",
        body: "```mermaid\nflowchart LR\nA-->B\n```",
      })
    ).json()) as { id: string };

    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    const html = await res.text();
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(html).toContain('/review/mermaid-11.15.0.min.js');
    expect(csp).toContain(`script-src 'unsafe-inline' ${ARTIFACT_BASE}/review/mermaid-11.15.0.min.js`);
    expect(csp).not.toContain("script-src 'unsafe-inline' 'self'");
    expect(csp).not.toContain("cdn.jsdelivr.net");
    expect(csp).not.toContain("connect-src");
  });

  it("keeps the ordinary artifact CSP byte-for-byte unchanged", async () => {
    const id = await publishedId();
    const csp = (await SELF.fetch(`${ARTIFACT_BASE}/${id}`)).headers.get("Content-Security-Policy")!;

    expect(csp).toContain("script-src 'unsafe-inline'; style-src");
    expect(csp).not.toContain("/review/mermaid-");
    expect(csp).not.toContain("script-src 'unsafe-inline' 'self'");
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
    expect(csp).toContain("frame-ancestors 'self' https://api.snapdoc.carraes.dev");
    expect(csp).toContain("script-src 'unsafe-inline' 'self'");
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

  it("serves Mermaid documents with both the runtime and annotator in annotate mode", async () => {
    const tok = await mintToken();
    const { id } = (await (
      await publish({
        token: tok.token,
        comments: true,
        contentType: "text/markdown",
        body: "```mermaid\nsequenceDiagram\nA->>B: Hi\n```",
      })
    ).json()) as { id: string };

    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}?annotate=1`);
    const html = await res.text();
    expect(html).toContain('/review/mermaid-11.15.0.min.js');
    expect(html).toContain('/review/annotator.js');
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'unsafe-inline' 'self'");
  });

  it("retrofits crossorigin onto legacy Mermaid runtime tags in annotate mode", async () => {
    // Artifacts published before the crossorigin fix have the bare tag baked
    // into their stored HTML; the review iframe's opaque origin makes SRI
    // reject the non-CORS response, so annotate mode must add the attribute.
    const legacyHtml =
      '<html><head><script src="/review/mermaid-11.15.0.min.js" integrity="sha384-yQ4mmBBT+vhTAwjFH0toJXNYJ6O4usWnt6EPIdWwrRvx2V/n5lXuDZQwQFeSFydF" defer></script></head><body><p>doc</p></body></html>';
    const tok = await mintToken();
    const { id } = (await (
      await publish({ token: tok.token, comments: true, body: legacyHtml })
    ).json()) as { id: string };

    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}?annotate=1`);
    const html = await res.text();
    expect(html).toMatch(/<script src="\/review\/mermaid-[^"]+"[^>]*crossorigin="anonymous"/);

    // The canonical page stays byte-for-byte what the owner published.
    const plain = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    expect(await plain.text()).toBe(legacyHtml);
  });
});

describe("mermaid runtime asset", () => {
  // The review iframe is sandboxed without allow-same-origin, so its runtime
  // fetch is cross-origin from an opaque origin; SRI needs a CORS-readable
  // response, which requires ACAO on the asset itself.
  it("serves the runtime with Access-Control-Allow-Origin on both hosts", async () => {
    for (const base of [ARTIFACT_BASE, API_BASE]) {
      const res = await SELF.fetch(`${base}/review/mermaid-11.15.0.min.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("does not add ACAO to other static assets", async () => {
    const res = await SELF.fetch(`${ARTIFACT_BASE}/review/annotator.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("review page on the artifact host", () => {
  it("serves the review page and the reader API at the artifact origin", async () => {
    const tok = await mintToken();
    const { id } = (await (await publish({ token: tok.token, comments: true })).json()) as { id: string };

    const page = await SELF.fetch(`${ARTIFACT_BASE}/review/${id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`data-artifact-id="${id}"`);
    // Same-origin serving: the rail falls back to location.origin for the doc.
    expect(html).toContain('data-artifact-origin=""');

    // The rail's relative /v1/reader calls must resolve on this origin too.
    const meta = await SELF.fetch(`${ARTIFACT_BASE}/v1/reader/artifacts/${id}`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { id: string }).id).toBe(id);
  });

  it("keeps publisher and admin APIs off the artifact host", async () => {
    for (const path of ["/v1/artifacts", "/v1/admin/tokens"]) {
      const res = await SELF.fetch(`${ARTIFACT_BASE}${path}`);
      expect(res.status).toBe(404);
    }
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

// Task 5 adds kind-aware routing to the same handler documents already use;
// these confirm the document path is unaffected by that change and that the
// new video-only routes never leak document content.
describe("document/video route separation stays backward compatible", () => {
  it("keeps serving a document artifact's HTML unchanged at /:id", async () => {
    const id = await publishedId();
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML_BODY);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("404s a /:id/media/... request against a document artifact", async () => {
    const id = await publishedId();
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}/media/whatever.mp4`);
    expect(res.status).toBe(404);
  });

  it("404s a /:id/poster.jpg request against a document artifact", async () => {
    const id = await publishedId();
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}/poster.jpg`);
    expect(res.status).toBe(404);
  });

  it("renders the video watch page (not raw MP4 bytes) at the bare /:id for a video artifact", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token, title: "clip" });
    const { id } = (await res.json()) as { id: string };
    const watch = await SELF.fetch(`${ARTIFACT_BASE}/${id}`);
    expect(watch.status).toBe(200);
    expect(watch.headers.get("Content-Type")).toContain("text/html");
    const html = await watch.text();
    expect(html).toContain("<video");
  });
});

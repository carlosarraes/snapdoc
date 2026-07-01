import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE } from "./helpers";

describe("review page", () => {
  it("serves the review shell publicly with a bespoke CSP", async () => {
    const res = await SELF.fetch(`${API_BASE}/review/AAAAAAAAAAAAAA`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-src 'self' https://snapdoc.carraes.dev");
    expect(csp).toContain("connect-src 'self' https://api.snapdoc.carraes.dev");
    expect(csp).toContain("script-src 'self'");
    // The review page runs no inline scripts (config travels via data-* attrs).
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const html = await res.text();
    expect(html).toContain('data-artifact-id="AAAAAAAAAAAAAA"');
    expect(html).toContain('data-artifact-origin="https://snapdoc.carraes.dev"');
  });

  it("is public — renders with no Access JWT at all", async () => {
    const res = await SELF.fetch(`${API_BASE}/review/BBBBBBBBBBBBBB`);
    expect(res.status).toBe(200);
  });

  it("does not serve the shell for non-id bundle paths under /review", async () => {
    const res = await SELF.fetch(`${API_BASE}/review/annotator.js`);
    expect(await res.text()).not.toContain("data-artifact-origin");
  });
});

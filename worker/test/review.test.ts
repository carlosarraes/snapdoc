import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, mintToken, publish } from "./helpers";

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

  it("declares the snapdoc logo as its favicon", async () => {
    const res = await SELF.fetch(`${API_BASE}/review/AAAAAAAAAAAAAA`);
    const html = await res.text();
    // The API host has no /favicon.ico fallback (unlike the artifact host), so
    // the shell must declare the icon itself or the browser tab shows none.
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/logo.svg">');

    // ...and the referenced asset must actually resolve on this host.
    const logo = await SELF.fetch(`${API_BASE}/logo.svg`);
    expect(logo.status).toBe(200);
  });

  it("is public — renders with no Access JWT at all", async () => {
    const res = await SELF.fetch(`${API_BASE}/review/BBBBBBBBBBBBBB`);
    expect(res.status).toBe(200);
  });

  it("does not serve the shell for non-id bundle paths under /review", async () => {
    const res = await SELF.fetch(`${API_BASE}/review/annotator.js`);
    expect(await res.text()).not.toContain("data-artifact-origin");
  });

  it("redirects protected artifacts to the artifact host, where the unlock cookie lives", async () => {
    const tok = await mintToken();
    const { id } = (await (
      await publish({ token: tok.token, comments: true, passcode: "pw" })
    ).json()) as { id: string };
    const res = await SELF.fetch(`${API_BASE}/review/${id}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`https://snapdoc.carraes.dev/review/${id}`);
  });

  it("keeps unprotected artifacts served on the API host unchanged", async () => {
    const tok = await mintToken();
    const { id } = (await (await publish({ token: tok.token, comments: true })).json()) as { id: string };
    const res = await SELF.fetch(`${API_BASE}/review/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`data-artifact-id="${id}"`);
  });
});

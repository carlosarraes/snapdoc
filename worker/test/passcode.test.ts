import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, ARTIFACT_BASE, mintToken, publishVideo } from "./helpers";

async function publishProtected(token: string, passcode: string, body = "<h1>secret</h1>") {
  const res = await SELF.fetch(`${API_BASE}/v1/artifacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/html",
      "X-Snapdoc-Passcode": passcode,
    },
    body,
  });
  return res;
}

function cookieFor(setCookie: string | null, id: string): string {
  // "sd_unlock_<id>=<token>; HttpOnly; ..." -> "sd_unlock_<id>=<token>"
  const name = `sd_unlock_${id}`;
  const part = (setCookie ?? "").split(";")[0];
  expect(part.startsWith(`${name}=`)).toBe(true);
  return part;
}

describe("passcode-protected artifacts", () => {
  it("publish with a passcode sets has_passcode", async () => {
    const tok = await mintToken();
    const res = await publishProtected(tok.token, "hunter2");
    expect(res.status).toBe(201);
    const art = (await res.json()) as { id: string; has_passcode: boolean };
    expect(art.has_passcode).toBe(true);
  });

  it("publish without a passcode leaves has_passcode false and serves directly", async () => {
    const tok = await mintToken();
    const res = await SELF.fetch(`${API_BASE}/v1/artifacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.token}`, "Content-Type": "text/html" },
      body: "<h1>open</h1>",
    });
    const art = (await res.json()) as { id: string; has_passcode: boolean };
    expect(art.has_passcode).toBe(false);
    const view = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("<h1>open</h1>");
    expect(view.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("shows an unlock form (not the content) without a valid cookie", async () => {
    const tok = await mintToken();
    const art = (await (await publishProtected(tok.token, "pw")).json()) as { id: string };
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="/${art.id}/unlock"`);
    expect(html).not.toContain("secret");
    expect(res.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
  });

  it("rejects a wrong passcode and sets no cookie", async () => {
    const tok = await mintToken();
    const art = (await (await publishProtected(tok.token, "right")).json()) as { id: string };
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: "wrong" }),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("Incorrect passcode");
  });

  it("unlocks with the correct passcode, sets a cookie, and serves content", async () => {
    const tok = await mintToken();
    const art = (await (await publishProtected(tok.token, "letmein")).json()) as { id: string };

    const unlock = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: "letmein" }),
      redirect: "manual",
    });
    expect(unlock.status).toBe(303);
    expect(unlock.headers.get("Location")).toBe(`/${art.id}`);
    const cookie = cookieFor(unlock.headers.get("Set-Cookie"), art.id);

    const view = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`, { headers: { Cookie: cookie } });
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("secret");
    expect(view.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("sets the unlock cookie with Path=/ so it reaches review and reader routes", async () => {
    const tok = await mintToken();
    const art = (await (await publishProtected(tok.token, "pw")).json()) as { id: string };
    const unlock = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: "pw" }),
      redirect: "manual",
    });
    const setCookie = unlock.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("Path=/;");
    expect(setCookie).not.toContain(`Path=/${art.id}`);
  });

  it("returns to a validated same-artifact destination after unlocking", async () => {
    const tok = await mintToken();
    const art = (await (await publishProtected(tok.token, "pw")).json()) as { id: string };
    const unlockWith = (next: string, passcode = "pw") =>
      SELF.fetch(`${ARTIFACT_BASE}/${art.id}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ passcode, next }),
        redirect: "manual",
      });

    expect((await unlockWith(`/review/${art.id}`)).headers.get("Location")).toBe(`/review/${art.id}`);
    expect((await unlockWith(`/${art.id}/v/2`)).headers.get("Location")).toBe(`/${art.id}/v/2`);
    // Anything else — other artifacts, absolute or protocol-relative URLs —
    // falls back to the artifact page: no open redirect.
    for (const evil of ["https://evil.com", "//evil.com", "/AAAAAAAAAAAAAA", `/review/${art.id}/x`]) {
      expect((await unlockWith(evil)).headers.get("Location")).toBe(`/${art.id}`);
    }

    // A wrong passcode re-renders the form with the destination preserved.
    const wrong = await unlockWith(`/review/${art.id}`, "nope");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain(`name="next" value="/review/${art.id}"`);
  });

  it("ignores a tampered cookie", async () => {
    const tok = await mintToken();
    const art = (await (await publishProtected(tok.token, "pw")).json()) as { id: string };
    const view = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`, {
      headers: { Cookie: `sd_unlock_${art.id}=deadbeef` },
    });
    expect(view.status).toBe(200);
    expect(await view.text()).toContain(`action="/${art.id}/unlock"`);
  });
});

describe("passcode-protected video artifacts", () => {
  // Video routes reuse the exact same status/passcode gate as documents
  // (see gateArtifact in serve.ts) rather than a separate implementation, so
  // the same unlock flow — including cookie verification — must apply.
  it("unlocks a video's watch page and media with the same cookie flow as documents", async () => {
    const tok = await mintToken();
    const created = (await (
      await publishVideo({ token: tok.token, passcode: "letmein", title: "secret clip" })
    ).json()) as { id: string; file_url: string };

    const locked = await SELF.fetch(`${ARTIFACT_BASE}/${created.id}`);
    expect(locked.status).toBe(200);
    expect(await locked.text()).not.toContain("secret clip");

    const unlock = await SELF.fetch(`${ARTIFACT_BASE}/${created.id}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: "letmein" }),
      redirect: "manual",
    });
    expect(unlock.status).toBe(303);
    const cookie = cookieFor(unlock.headers.get("Set-Cookie"), created.id);

    const watch = await SELF.fetch(`${ARTIFACT_BASE}/${created.id}`, { headers: { Cookie: cookie } });
    expect(await watch.text()).toContain("secret clip");

    const media = await SELF.fetch(new URL(created.file_url).toString(), { headers: { Cookie: cookie } });
    expect(media.status).toBe(200);
    expect(media.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects video media with a tampered cookie", async () => {
    const tok = await mintToken();
    const created = (await (
      await publishVideo({ token: tok.token, passcode: "pw" })
    ).json()) as { id: string; file_url: string };
    const media = await SELF.fetch(new URL(created.file_url).toString(), {
      headers: { Cookie: `sd_unlock_${created.id}=deadbeef` },
    });
    expect(media.status).toBe(401);
  });
});

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, ARTIFACT_BASE, mintToken } from "./helpers";

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

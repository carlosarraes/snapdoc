import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, expectError, mintToken, store } from "./helpers";

interface WhoamiJson {
  token: { id: string; name: string; created_at: string };
}

function whoami(token?: string) {
  return SELF.fetch(`${API_BASE}/v1/whoami`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("GET /v1/whoami", () => {
  it("returns the authenticated token's identity", async () => {
    const tok = await mintToken("ci-laptop");
    const res = await whoami(tok.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WhoamiJson;
    expect(body.token.id).toBe(tok.id);
    expect(body.token.name).toBe("ci-laptop");
    expect(body.token.created_at).toBe(tok.createdAt);
  });

  it("exposes only id, name, and created_at (no secret, last_used_at, or revoked_at)", async () => {
    const tok = await mintToken();
    const res = await whoami(tok.token);
    const body = (await res.json()) as { token: Record<string, unknown> };
    expect(Object.keys(body.token).sort()).toEqual(["created_at", "id", "name"]);
  });

  it("rejects missing, invalid, and revoked tokens", async () => {
    await expectError(await whoami(), 401, "unauthorized");
    await expectError(await whoami("sd_live_wrong"), 401, "unauthorized");

    const tok = await mintToken();
    await store().revokeToken(tok.id);
    await expectError(await whoami(tok.token), 401, "unauthorized");
  });
});

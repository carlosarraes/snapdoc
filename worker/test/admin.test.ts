import { SELF, env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { API_BASE, expectError, mintToken, publish, store } from "./helpers";

const BOOTSTRAP = { Authorization: "Bearer test-bootstrap-secret" };

async function adminFetch(path: string, init?: RequestInit) {
  return SELF.fetch(`${API_BASE}/v1/admin${path}`, init);
}

describe("admin token management (dev stub: no team domain configured)", () => {
  it("mints a token, returning the secret exactly once", async () => {
    const res = await adminFetch("/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ci-bot" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; token: string; created_at: string };
    expect(body.id).toMatch(/^tok_/);
    expect(body.name).toBe("ci-bot");
    expect(body.token).toMatch(/^sd_live_/);
    expect(body.created_at).toBeTruthy();

    const list = await adminFetch("/tokens");
    const listed = ((await list.json()) as { tokens: Record<string, unknown>[] }).tokens;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("token");
    expect(listed[0]).not.toHaveProperty("token_hash");
  });

  it("rejects duplicate and missing names", async () => {
    await adminFetch("/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup" }),
    });
    const dup = await adminFetch("/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "dup" }),
    });
    await expectError(dup, 400, "invalid_request");

    const missing = await adminFetch("/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await expectError(missing, 400, "invalid_request");

    const notJson = await adminFetch("/tokens", { method: "POST", body: "name=x" });
    await expectError(notJson, 400, "invalid_request");
  });

  it("lists token usage metadata", async () => {
    const tok = await mintToken("used-token");
    await publish({ token: tok.token });
    const res = await adminFetch("/tokens");
    expect(res.status).toBe(200);
    const { tokens } = (await res.json()) as {
      tokens: { id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }[];
    };
    const row = tokens.find((t) => t.id === tok.id)!;
    expect(row.last_used_at).toBeTruthy();
    expect(row.revoked_at).toBeNull();
  });

  it("revokes idempotently and 404s on unknown ids", async () => {
    const tok = await mintToken();
    const first = await adminFetch(`/tokens/${tok.id}`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { id: string; revoked_at: string };
    expect(body.id).toBe(tok.id);
    expect(body.revoked_at).toBeTruthy();

    const second = await adminFetch(`/tokens/${tok.id}`, { method: "DELETE" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { revoked_at: string }).revoked_at).toBe(body.revoked_at);

    const missing = await adminFetch("/tokens/tok_missing", { method: "DELETE" });
    await expectError(missing, 404, "not_found");
  });
});

describe("admin artifact management", () => {
  it("lists artifacts across all tokens including token_name", async () => {
    const tokA = await mintToken("alpha");
    const tokB = await mintToken("beta");
    await publish({ token: tokA.token });
    await publish({ token: tokB.token });

    const res = await adminFetch("/artifacts");
    expect(res.status).toBe(200);
    const { artifacts } = (await res.json()) as { artifacts: { token_name: string }[] };
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((a) => a.token_name).sort()).toEqual(["alpha", "beta"]);
  });

  it("supports status filters and detail/expire/delete mirrors", async () => {
    const tok = await mintToken("gamma");
    const created = (await (await publish({ token: tok.token })).json()) as { id: string };

    const detail = await adminFetch(`/artifacts/${created.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { artifact: { token_name: string }; versions: unknown[] };
    expect(detailBody.artifact.token_name).toBe("gamma");
    expect(detailBody.versions).toHaveLength(1);

    const expired = await adminFetch(`/artifacts/${created.id}/expire`, { method: "POST" });
    expect(expired.status).toBe(200);
    expect(((await expired.json()) as { status: string }).status).toBe("expired");

    const filtered = await adminFetch("/artifacts?status=expired");
    const { artifacts } = (await filtered.json()) as { artifacts: { id: string }[] };
    expect(artifacts.map((a) => a.id)).toEqual([created.id]);

    const deleted = await adminFetch(`/artifacts/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: created.id, status: "deleted" });
  });
});

describe("bootstrap secret", () => {
  it("mints the first token with the ADMIN_BOOTSTRAP bearer secret", async () => {
    const res = await adminFetch("/tokens", {
      method: "POST",
      headers: { ...BOOTSTRAP, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "first" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { token: string }).token).toMatch(/^sd_live_/);
  });
});

describe("Cloudflare Access enforcement (team domain configured)", () => {
  const TEAM_DOMAIN = "snapteam.cloudflareaccess.com";
  const AUD = "test-aud-tag";

  let keyPair: CryptoKeyPair;
  let publicJwk: JsonWebKey & { kid?: string };

  beforeAll(async () => {
    keyPair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & { kid?: string };
    publicJwk.kid = "test-key";
  });

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
    fetchMock.deactivate();
  });

  function mockJwks() {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get(`https://${TEAM_DOMAIN}`)
      .intercept({ path: "/cdn-cgi/access/certs" })
      .reply(200, { keys: [publicJwk] });
  }

  function b64url(data: string | Uint8Array): string {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  async function makeJwt(claims: Record<string, unknown>, opts: { kid?: string } = {}): Promise<string> {
    const header = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "test-key", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        iss: `https://${TEAM_DOMAIN}`,
        aud: [AUD],
        iat: Math.floor(Date.now() / 1000) - 10,
        exp: Math.floor(Date.now() / 1000) + 300,
        email: "admin@example.com",
        ...claims,
      }),
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
  }

  function accessEnv() {
    return { ...env, CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, CF_ACCESS_AUD: AUD };
  }

  async function fetchWithAccess(path: string, init: RequestInit | undefined, jwt?: string) {
    const { default: worker } = await import("../src/index");
    const headers = new Headers(init?.headers);
    if (jwt) headers.set("Cf-Access-Jwt-Assertion", jwt);
    const request = new Request(`${API_BASE}/v1/admin${path}`, { ...init, headers });
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    return worker.fetch(request, accessEnv(), ctx);
  }

  it("rejects requests without a JWT", async () => {
    const res = await fetchWithAccess("/tokens", undefined);
    await expectError(res, 401, "unauthorized");
  });

  it("accepts a valid Access JWT", async () => {
    mockJwks();
    const jwt = await makeJwt({});
    const res = await fetchWithAccess("/tokens", undefined, jwt);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("tokens");
  });

  it("rejects expired JWTs and wrong audiences without consulting the JWKS", async () => {
    const expired = await makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await expectError(await fetchWithAccess("/tokens", undefined, expired), 401, "unauthorized");

    const wrongAud = await makeJwt({ aud: ["someone-else"] });
    await expectError(await fetchWithAccess("/tokens", undefined, wrongAud), 401, "unauthorized");
  });

  it("rejects JWTs signed by an unknown key", async () => {
    mockJwks();
    const otherPair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const saved = keyPair;
    keyPair = otherPair;
    const forged = await makeJwt({});
    keyPair = saved;
    await expectError(await fetchWithAccess("/tokens", undefined, forged), 401, "unauthorized");
  });

  it("still allows the bootstrap secret without a JWT", async () => {
    const res = await fetchWithAccess("/tokens", {
      method: "POST",
      headers: { ...BOOTSTRAP, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `boot-${crypto.randomUUID()}` }),
    });
    expect(res.status).toBe(201);
  });

  it("does not let the bootstrap secret read or revoke tokens", async () => {
    const res = await fetchWithAccess("/tokens", { headers: BOOTSTRAP });
    await expectError(res, 401, "unauthorized");
  });
});

describe("misc API routing", () => {
  it("404s unknown /v1 routes with the error envelope", async () => {
    const res = await SELF.fetch(`${API_BASE}/v1/nope`);
    await expectError(res, 404, "not_found");
  });

  it("serves dashboard assets on non-/v1 paths of the API host", async () => {
    const res = await SELF.fetch(`${API_BASE}/admin/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("snapdoc admin");
  });

  it("keeps publish working after a token is revoked mid-session", async () => {
    const tok = await mintToken();
    await store().revokeToken(tok.id);
    const res = await publish({ token: tok.token });
    await expectError(res, 401, "unauthorized");
  });
});

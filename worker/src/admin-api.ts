// /v1/admin/* endpoints, authenticated by Cloudflare Access (JWT in
// Cf-Access-Jwt-Assertion). The auth stub (no Access verification) applies
// only when CF_ACCESS_TEAM_DOMAIN is unset AND ENVIRONMENT is "dev" or
// "test"; any other deployment missing CF_ACCESS_TEAM_DOMAIN or
// CF_ACCESS_AUD fails closed with 503 "misconfigured". POST /tokens
// additionally accepts the ADMIN_BOOTSTRAP bearer secret so the first token
// can be minted headlessly.
import { Hono } from "hono";
import { mapStoreError, parseListParams } from "./api";
import { artifactJson, errorResponse, versionJson } from "./http";
import { Store } from "./store";
import type { Env } from "./types";

function b64urlDecodeToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlDecodeToJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(value))) as T;
}

interface AccessClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
}

// Verifies a Cloudflare Access JWT (RS256) against the team domain's JWKS.
// The audience check is mandatory: callers must fail closed before invoking
// this when no expected AUD is configured.
async function verifyAccessJwt(jwt: string, teamDomain: string, expectedAud: string): Promise<boolean> {
  try {
    const [headerPart, payloadPart, signaturePart] = jwt.split(".");
    if (!headerPart || !payloadPart || !signaturePart) return false;
    const header = b64urlDecodeToJson<{ alg?: string; kid?: string }>(headerPart);
    if (header.alg !== "RS256") return false;
    const claims = b64urlDecodeToJson<AccessClaims>(payloadPart);

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return false;
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) return false;
    if (claims.iss !== `https://${teamDomain}`) return false;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(expectedAud)) return false;

    const certsRes = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!certsRes.ok) return false;
    const { keys } = (await certsRes.json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
    const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const signature = b64urlDecodeToBytes(signaturePart);
    for (const jwk of candidates) {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares secrets via their SHA-256 digests so comparison cost does not
// leak how much of the secret prefix matches.
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(expected)]);
  return a === b;
}

async function isBootstrapRequest(
  c: { req: { method: string; path: string; header: (n: string) => string | undefined } },
  env: Env,
): Promise<boolean> {
  if (!env.ADMIN_BOOTSTRAP) return false;
  if (c.req.method !== "POST" || !/\/tokens\/?$/.test(c.req.path)) return false;
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return secretsMatch(header.slice("Bearer ".length), env.ADMIN_BOOTSTRAP);
}

const DEV_STUB_ENVIRONMENTS = ["dev", "test"];

export function createAdminApp(): Hono<{ Bindings: Env; Variables: { store: Store } }> {
  const app = new Hono<{ Bindings: Env; Variables: { store: Store } }>();

  app.use("*", async (c, next) => {
    c.set("store", new Store(c.env.DB, c.env.BLOBS));
    if (await isBootstrapRequest(c, c.env)) return next();
    if (!c.env.CF_ACCESS_TEAM_DOMAIN) {
      // Auth stub only for explicit dev/test environments; a production
      // deployment missing its Access configuration must fail CLOSED.
      if (DEV_STUB_ENVIRONMENTS.includes(c.env.ENVIRONMENT ?? "")) return next();
      return errorResponse("misconfigured", "Admin API is not configured: CF_ACCESS_TEAM_DOMAIN is unset.");
    }
    if (!c.env.CF_ACCESS_AUD) {
      // Without a pinned audience any same-team Access token would pass.
      return errorResponse("misconfigured", "Admin API is not configured: CF_ACCESS_AUD is unset.");
    }
    const jwt = c.req.header("Cf-Access-Jwt-Assertion");
    if (!jwt || !(await verifyAccessJwt(jwt, c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD))) {
      return errorResponse("unauthorized", "A valid Cloudflare Access JWT is required.");
    }
    return next();
  });

  app.onError((err) => mapStoreError(err));

  // ---- tokens ----

  app.post("/tokens", async (c) => {
    let name: unknown;
    try {
      ({ name } = await c.req.json<{ name?: unknown }>());
    } catch {
      return errorResponse("invalid_request", "Body must be JSON: { \"name\": \"...\" }.");
    }
    if (typeof name !== "string" || name.trim().length === 0) {
      return errorResponse("invalid_request", "Token name is required.");
    }
    const minted = await c.get("store").mintToken(name.trim());
    return c.json(
      { id: minted.id, name: minted.name, token: minted.token, created_at: minted.createdAt },
      201,
    );
  });

  app.get("/tokens", async (c) => {
    const tokens = await c.get("store").listTokens();
    return c.json({
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        created_at: t.createdAt,
        last_used_at: t.lastUsedAt,
        revoked_at: t.revokedAt,
      })),
    });
  });

  app.delete("/tokens/:id", async (c) => {
    const result = await c.get("store").revokeToken(c.req.param("id"));
    if (!result) return errorResponse("not_found", "Token not found.");
    return c.json({ id: result.id, revoked_at: result.revokedAt });
  });

  // ---- artifacts (management mirrors across all tokens) ----

  app.get("/artifacts", async (c) => {
    const params = parseListParams(c.req.query("status"), c.req.query("limit"), c.req.query("cursor"));
    if (params instanceof Response) return params;
    const { artifacts, nextCursor } = await c.get("store").listArtifacts(params);
    return c.json({
      artifacts: artifacts.map((a) => artifactJson(a, c.env, { admin: true })),
      next_cursor: nextCursor,
    });
  });

  app.get("/artifacts/:id", async (c) => {
    const found = await c.get("store").getArtifact(c.req.param("id"));
    if (!found) return errorResponse("not_found", "Artifact not found.");
    return c.json({
      artifact: artifactJson(found.artifact, c.env, { admin: true }),
      versions: found.versions.map(versionJson),
    });
  });

  app.post("/artifacts/:id/expire", async (c) => {
    const artifact = await c.get("store").expireArtifact(c.req.param("id"));
    return c.json(artifactJson(artifact, c.env, { admin: true }));
  });

  app.delete("/artifacts/:id", async (c) => {
    const result = await c.get("store").deleteArtifact(c.req.param("id"));
    return c.json(result);
  });

  return app;
}

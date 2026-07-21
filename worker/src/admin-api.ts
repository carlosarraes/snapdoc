// /v1/admin/* endpoints, authenticated by Cloudflare Access (JWT in
// Cf-Access-Jwt-Assertion). The auth stub (no Access verification) applies
// only when CF_ACCESS_TEAM_DOMAIN is unset AND ENVIRONMENT is "dev" or
// "test"; any other deployment missing CF_ACCESS_TEAM_DOMAIN or
// CF_ACCESS_AUD fails closed with 503 "misconfigured". POST /tokens
// additionally accepts the ADMIN_BOOTSTRAP bearer secret so the first token
// can be minted headlessly.
import { Hono } from "hono";
import { mapStoreError, parseCommentStatus, parseListParams } from "./api";
import { artifactDetailJson, artifactJson, artifactListJson, commentJson, errorResponse, MAX_COMMENT_BYTES } from "./http";
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
  email?: string;
}

// Verifies a Cloudflare Access JWT (RS256) against the team domain's JWKS and,
// on success, returns the identity email claim. The audience check is mandatory:
// callers must fail closed before invoking this when no expected AUD is configured.
async function verifyAccessJwt(
  jwt: string,
  teamDomain: string,
  expectedAud: string,
): Promise<{ valid: boolean; email: string | null }> {
  const invalid = { valid: false, email: null };
  try {
    const [headerPart, payloadPart, signaturePart] = jwt.split(".");
    if (!headerPart || !payloadPart || !signaturePart) return invalid;
    const header = b64urlDecodeToJson<{ alg?: string; kid?: string }>(headerPart);
    if (header.alg !== "RS256") return invalid;
    const claims = b64urlDecodeToJson<AccessClaims>(payloadPart);

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return invalid;
    if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) return invalid;
    if (claims.iss !== `https://${teamDomain}`) return invalid;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(expectedAud)) return invalid;

    const certsRes = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!certsRes.ok) return invalid;
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
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data)) {
        return { valid: true, email: claims.email ?? null };
      }
    }
    return invalid;
  } catch {
    return invalid;
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

// Checks an Authorization header against the ADMIN_BOOTSTRAP secret. Shared
// with the publisher app's POST /v1/tokens, which exists because /v1/admin/*
// sits behind Cloudflare Access at the edge and can never be reached headlessly.
export async function verifyBootstrapHeader(header: string | undefined, env: Env): Promise<boolean> {
  if (!env.ADMIN_BOOTSTRAP) return false;
  if (!header?.startsWith("Bearer ")) return false;
  return secretsMatch(header.slice("Bearer ".length), env.ADMIN_BOOTSTRAP);
}

async function isBootstrapRequest(
  c: { req: { method: string; path: string; header: (n: string) => string | undefined } },
  env: Env,
): Promise<boolean> {
  if (c.req.method !== "POST" || !/\/tokens\/?$/.test(c.req.path)) return false;
  return verifyBootstrapHeader(c.req.header("Authorization"), env);
}

// Shared by the admin app and the publisher app's bootstrap mint route.
export async function mintTokenResponse(req: Request, store: Store): Promise<Response> {
  let name: unknown;
  try {
    ({ name } = (await req.json()) as { name?: unknown });
  } catch {
    return errorResponse("invalid_request", "Body must be JSON: { \"name\": \"...\" }.");
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return errorResponse("invalid_request", "Token name is required.");
  }
  const minted = await store.mintToken(name.trim());
  return Response.json(
    { id: minted.id, name: minted.name, token: minted.token, created_at: minted.createdAt },
    { status: 201 },
  );
}

const DEV_STUB_ENVIRONMENTS = ["dev", "test"];

type AdminCtx = { Bindings: Env; Variables: { store: Store; accessEmail?: string } };

export function createAdminApp(): Hono<AdminCtx> {
  const app = new Hono<AdminCtx>();

  app.use("*", async (c, next) => {
    c.set("store", new Store(c.env.DB, c.env.BLOBS));
    if (await isBootstrapRequest(c, c.env)) return next();
    if (!c.env.CF_ACCESS_TEAM_DOMAIN) {
      // Auth stub only for explicit dev/test environments; a production
      // deployment missing its Access configuration must fail CLOSED.
      if (DEV_STUB_ENVIRONMENTS.includes(c.env.ENVIRONMENT ?? "")) {
        c.set("accessEmail", c.req.header("X-Access-Email") ?? "dev@local");
        return next();
      }
      return errorResponse("misconfigured", "Admin API is not configured: CF_ACCESS_TEAM_DOMAIN is unset.");
    }
    if (!c.env.CF_ACCESS_AUD) {
      // Without a pinned audience any same-team Access token would pass.
      return errorResponse("misconfigured", "Admin API is not configured: CF_ACCESS_AUD is unset.");
    }
    const jwt = c.req.header("Cf-Access-Jwt-Assertion");
    const verified = jwt ? await verifyAccessJwt(jwt, c.env.CF_ACCESS_TEAM_DOMAIN, c.env.CF_ACCESS_AUD) : null;
    if (!verified || !verified.valid) {
      return errorResponse("unauthorized", "A valid Cloudflare Access JWT is required.");
    }
    if (verified.email) c.set("accessEmail", verified.email);
    return next();
  });

  app.onError((err) => mapStoreError(err));

  // ---- tokens ----

  app.post("/tokens", (c) => mintTokenResponse(c.req.raw, c.get("store")));

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
    const store = c.get("store");
    const { artifacts, nextCursor } = await store.listArtifacts(params);
    const jsons = await artifactListJson(store, artifacts, c.env, { admin: true });
    return c.json({
      artifacts: jsons,
      next_cursor: nextCursor,
    });
  });

  app.get("/artifacts/:id", async (c) => {
    const store = c.get("store");
    const found = await store.getArtifact(c.req.param("id"));
    if (!found) return errorResponse("not_found", "Artifact not found.");
    return c.json(await artifactDetailJson(store, found, c.env, { admin: true }));
  });

  app.post("/artifacts/:id/comment-settings", async (c) => {
    let enabled: unknown;
    try {
      ({ enabled } = (await c.req.json()) as { enabled?: unknown });
    } catch {
      return errorResponse("invalid_request", "Body must be JSON: { \"enabled\": true|false }.");
    }
    if (typeof enabled !== "boolean") {
      return errorResponse("invalid_request", "enabled must be a boolean.");
    }
    const artifact = await c.get("store").setCommentsEnabled(c.req.param("id"), enabled);
    return c.json(artifactJson(artifact, c.env, { admin: true }));
  });

  app.post("/artifacts/:id/expire", async (c) => {
    const artifact = await c.get("store").expireArtifact(c.req.param("id"));
    return c.json(artifactJson(artifact, c.env, { admin: true }));
  });

  app.delete("/artifacts/:id", async (c) => {
    const result = await c.get("store").deleteArtifact(c.req.param("id"));
    return c.json(result);
  });

  // ---- comments (humans author via Access; agents read via token in api.ts) ----

  app.post("/artifacts/:id/comments", async (c) => {
    let payload: { body?: unknown; parent_id?: unknown };
    try {
      payload = (await c.req.json()) as { body?: unknown; parent_id?: unknown };
    } catch {
      return errorResponse("invalid_request", "Body must be JSON: { \"body\": \"...\" }.");
    }
    const { body, parent_id: parentId } = payload;
    if (typeof body !== "string" || body.trim().length === 0) {
      return errorResponse("invalid_request", "Comment body is required.");
    }
    if (new TextEncoder().encode(body).byteLength > MAX_COMMENT_BYTES) {
      return errorResponse("invalid_request", "Comment exceeds the 8 KB limit.");
    }
    if (parentId !== undefined && typeof parentId !== "string") {
      return errorResponse("invalid_request", "parent_id must be a string.");
    }
    const comment = await c.get("store").addComment(c.req.param("id"), {
      author: c.get("accessEmail") ?? "unknown",
      body,
      parentId,
    });
    return c.json(commentJson(comment), 201);
  });

  app.get("/artifacts/:id/comments", async (c) => {
    const id = c.req.param("id");
    if (!(await c.get("store").getArtifactGate(id))) return errorResponse("not_found", "Artifact not found.");
    const status = parseCommentStatus(c.req.query("status"));
    if (status instanceof Response) return status;
    const { comments, truncated } = await c.get("store").listComments(id, status);
    return c.json({
      artifact_id: id,
      comments: comments.map((cm) => commentJson(cm)),
      ...(truncated ? { truncated: true } : {}),
    });
  });

  app.patch("/comments/:cid", async (c) => {
    let resolved: unknown;
    try {
      ({ resolved } = (await c.req.json()) as { resolved?: unknown });
    } catch {
      return errorResponse("invalid_request", "Body must be JSON: { \"resolved\": true|false }.");
    }
    if (typeof resolved !== "boolean") {
      return errorResponse("invalid_request", "resolved must be a boolean.");
    }
    const updated = await c.get("store").setCommentResolved(c.req.param("cid"), resolved, c.get("accessEmail") ?? "unknown");
    if (!updated) return errorResponse("not_found", "Comment not found.");
    return c.json(commentJson(updated));
  });

  app.delete("/comments/:cid", async (c) => {
    const result = await c.get("store").deleteComment(c.req.param("cid"));
    if (!result) return errorResponse("not_found", "Comment not found.");
    return c.json({ id: result.id, deleted_at: result.deletedAt });
  });

  return app;
}

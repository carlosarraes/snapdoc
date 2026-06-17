// /v1/* publisher endpoints (Bearer token auth).
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { mintTokenResponse, verifyBootstrapHeader } from "./admin-api";
import { renderMarkdown } from "./markdown";
import { Store, StoreError, type ArtifactStatus, type TokenRecord } from "./store";
import { artifactJson, errorResponse, parseDuration, versionJson } from "./http";
import type { Env } from "./types";

interface ApiVariables {
  store: Store;
  token: TokenRecord;
}

export type ApiContext = { Bindings: Env; Variables: ApiVariables };

export function mapStoreError(err: unknown): Response {
  if (err instanceof StoreError) return errorResponse(err.code, err.message);
  console.error("internal error", err);
  return errorResponse("internal", "Unexpected server error.");
}

interface PublishInput {
  body: string;
  contentType: "text/html";
  title: string | null;
  ttlSeconds?: number;
}

// Validates the shared publish inputs (content type, size, ttl, title) and
// renders markdown to a self-contained HTML document. Returns a Response on
// validation failure.
export async function readPublishInput(
  request: Request,
  env: Env,
  query: { title?: string; ttl?: string },
): Promise<PublishInput | Response> {
  const rawType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (rawType !== "text/html" && rawType !== "text/markdown") {
    return errorResponse(
      "unsupported_content_type",
      "Content-Type must be text/html or text/markdown.",
    );
  }

  const maxBytes = Number(env.MAX_ARTIFACT_BYTES);
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > maxBytes) {
    return errorResponse("too_large", "Artifact exceeds the 2 MB size limit.");
  }

  const title = query.title ?? null;
  if (title !== null && title.length > 200) {
    return errorResponse("invalid_request", "Title must be at most 200 characters.");
  }

  let ttlSeconds: number | undefined;
  if (query.ttl !== undefined) {
    const parsed = parseDuration(query.ttl);
    const min = parseDuration(env.MIN_TTL)!;
    const max = parseDuration(env.MAX_TTL)!;
    if (parsed === null || parsed < min || parsed > max) {
      return errorResponse("invalid_ttl", `TTL must be a duration between ${env.MIN_TTL} and ${env.MAX_TTL}, e.g. "12h" or "7d".`);
    }
    ttlSeconds = parsed;
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return errorResponse("too_large", "Artifact exceeds the 2 MB size limit.");
  }
  if (raw.trim().length === 0) {
    return errorResponse("invalid_request", "Artifact body must not be empty.");
  }

  let body = raw;
  let resolvedTitle = title;
  if (rawType === "text/markdown") {
    const rendered = await renderMarkdown(raw, title ?? undefined);
    body = rendered.html;
    // Fall back to a frontmatter title when no explicit ?title= was given.
    if (resolvedTitle === null) resolvedTitle = rendered.title;
  }
  return { body, contentType: "text/html", title: resolvedTitle, ttlSeconds };
}

async function enforceRateLimit(store: Store, tokenId: string, env: Env): Promise<Response | null> {
  const limit = Number(env.RATE_LIMIT_PER_HOUR);
  const result = await store.checkRateLimit(tokenId, limit);
  if (result.allowed) return null;
  return errorResponse(
    "rate_limited",
    `Publish rate limit of ${limit}/hour exceeded; retry after ${result.retryAfterSeconds}s.`,
    { "Retry-After": String(result.retryAfterSeconds) },
  );
}

export function createPublisherApp(): Hono<ApiContext> {
  const app = new Hono<ApiContext>();

  const authMiddleware: MiddlewareHandler<ApiContext> = async (c, next) => {
    const store = new Store(c.env.DB, c.env.BLOBS);
    c.set("store", store);
    const header = c.req.header("Authorization") ?? "";
    const secret = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const token = secret ? await store.authenticateToken(secret) : null;
    if (!token) {
      return errorResponse("unauthorized", "A valid API token is required.");
    }
    c.set("token", token);
    await next();
  };
  app.use("/artifacts", authMiddleware);
  app.use("/artifacts/*", authMiddleware);

  app.onError((err) => mapStoreError(err));

  // Bootstrap token minting lives outside /v1/admin/* because Cloudflare
  // Access intercepts that prefix at the edge, making headless bootstrap
  // impossible there. This route accepts ONLY the ADMIN_BOOTSTRAP secret.
  app.post("/tokens", async (c) => {
    if (!(await verifyBootstrapHeader(c.req.header("Authorization"), c.env))) {
      return errorResponse("unauthorized", "The bootstrap secret is required to mint tokens here.");
    }
    return mintTokenResponse(c.req.raw, new Store(c.env.DB, c.env.BLOBS));
  });

  app.post("/artifacts", async (c) => {
    const store = c.get("store");
    const token = c.get("token");
    const rateLimited = await enforceRateLimit(store, token.id, c.env);
    if (rateLimited) return rateLimited;

    const input = await readPublishInput(c.req.raw, c.env, {
      title: c.req.query("title"),
      ttl: c.req.query("ttl"),
    });
    if (input instanceof Response) return input;

    const artifact = await store.createArtifact({
      tokenId: token.id,
      title: input.title,
      ttlSeconds: input.ttlSeconds ?? parseDuration(c.env.DEFAULT_TTL)!,
      contentType: input.contentType,
      body: input.body,
    });
    await store.recordPublish(token.id);
    return c.json(artifactJson(artifact, c.env), 201);
  });

  app.post("/artifacts/:id/versions", async (c) => {
    const store = c.get("store");
    const token = c.get("token");
    const rateLimited = await enforceRateLimit(store, token.id, c.env);
    if (rateLimited) return rateLimited;

    const input = await readPublishInput(c.req.raw, c.env, {
      title: c.req.query("title"),
      ttl: c.req.query("ttl"),
    });
    if (input instanceof Response) return input;

    const artifact = await store.addVersion(c.req.param("id"), {
      title: input.title,
      ttlSeconds: input.ttlSeconds,
      defaultTtlSeconds: parseDuration(c.env.DEFAULT_TTL)!,
      contentType: input.contentType,
      body: input.body,
    });
    await store.recordPublish(token.id);
    return c.json(artifactJson(artifact, c.env), 201);
  });

  app.get("/artifacts", async (c) => {
    const store = c.get("store");
    const token = c.get("token");
    const params = parseListParams(c.req.query("status"), c.req.query("limit"), c.req.query("cursor"));
    if (params instanceof Response) return params;
    const { artifacts, nextCursor } = await store.listArtifacts({ tokenId: token.id, ...params });
    return c.json({
      artifacts: artifacts.map((a) => artifactJson(a, c.env)),
      next_cursor: nextCursor,
    });
  });

  app.get("/artifacts/:id", async (c) => {
    const store = c.get("store");
    const found = await store.getArtifact(c.req.param("id"));
    if (!found) return errorResponse("not_found", "Artifact not found.");
    return c.json({
      artifact: artifactJson(found.artifact, c.env),
      versions: found.versions.map(versionJson),
    });
  });

  app.post("/artifacts/:id/expire", async (c) => {
    const artifact = await c.get("store").expireArtifact(c.req.param("id"));
    return c.json(artifactJson(artifact, c.env));
  });

  app.delete("/artifacts/:id", async (c) => {
    const result = await c.get("store").deleteArtifact(c.req.param("id"));
    return c.json(result);
  });

  return app;
}

const STATUSES: ArtifactStatus[] = ["active", "expired", "deleted"];

export function parseListParams(
  status: string | undefined,
  limit: string | undefined,
  cursor: string | undefined,
): { status?: ArtifactStatus; limit: number; cursor?: string } | Response {
  let parsedStatus: ArtifactStatus | undefined;
  if (status !== undefined) {
    if (!STATUSES.includes(status as ArtifactStatus)) {
      return errorResponse("invalid_request", "status must be one of active, expired, deleted.");
    }
    parsedStatus = status as ArtifactStatus;
  }
  let parsedLimit = 50;
  if (limit !== undefined) {
    parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      return errorResponse("invalid_request", "limit must be an integer between 1 and 200.");
    }
  }
  return { status: parsedStatus, limit: parsedLimit, cursor };
}

// /v1/* publisher endpoints (Bearer token auth).
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { mintTokenResponse, verifyBootstrapHeader } from "./admin-api";
import { renderMarkdown } from "./markdown";
import { htmlToMarkdown } from "./html-to-markdown";
import { ALLOWED_IMAGE_TYPES, detectImageType } from "./assets";
import { Store, StoreError, type ArtifactStatus, type TokenRecord, type UploadAsset } from "./store";
import { artifactJson, assetJson, commentJson, errorResponse, parseDuration, tokenJson, versionJson } from "./http";
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
  passcode?: string;
  assets?: UploadAsset[];
}

// Validates ?title= and ?ttl= shared by both publish paths. Returns a Response
// on failure.
function validateTitleTtl(
  env: Env,
  query: { title?: string; ttl?: string },
): { title: string | null; ttlSeconds?: number } | Response {
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
  return { title, ttlSeconds };
}

// Validates the shared publish inputs (content type, size, ttl, title) and
// renders markdown to a self-contained HTML document. A multipart/form-data
// body (document + image parts) is handled separately. Returns a Response on
// validation failure.
export async function readPublishInput(
  request: Request,
  env: Env,
  query: { title?: string; ttl?: string },
): Promise<PublishInput | Response> {
  const rawType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (rawType === "multipart/form-data") {
    return readMultipartPublishInput(request, env, query);
  }
  if (rawType !== "text/html" && rawType !== "text/markdown") {
    return errorResponse(
      "unsupported_content_type",
      "Content-Type must be text/html, text/markdown, or multipart/form-data.",
    );
  }

  const maxBytes = Number(env.MAX_ARTIFACT_BYTES);
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > maxBytes) {
    return errorResponse("too_large", "Artifact exceeds the 2 MB size limit.");
  }

  const meta = validateTitleTtl(env, query);
  if (meta instanceof Response) return meta;

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return errorResponse("too_large", "Artifact exceeds the 2 MB size limit.");
  }
  if (raw.trim().length === 0) {
    return errorResponse("invalid_request", "Artifact body must not be empty.");
  }

  let body = raw;
  let resolvedTitle = meta.title;
  if (rawType === "text/markdown") {
    const rendered = await renderMarkdown(raw, meta.title ?? undefined);
    body = rendered.html;
    // Fall back to a frontmatter title when no explicit ?title= was given.
    if (resolvedTitle === null) resolvedTitle = rendered.title;
  }
  // Passcode travels in a header (not a query param, which would be logged).
  const passcode = request.headers.get("X-Snapdoc-Passcode") || undefined;
  return { body, contentType: "text/html", title: resolvedTitle, ttlSeconds: meta.ttlSeconds, passcode };
}

// workers-types models FormData entries as `string`, but file parts arrive as
// File at runtime — narrow through this view rather than fighting the types.
type MultipartForm = {
  get(name: string): File | string | null;
  entries(): IterableIterator<[string, File | string]>;
};

// Handles a `multipart/form-data` publish: one `document` part (text/html or
// text/markdown) plus N image parts whose part filename is the original ref.
// Images are size/type-checked (magic-byte sniff; raster only) and the actual
// upload + reference rewriting happen in the store.
async function readMultipartPublishInput(
  request: Request,
  env: Env,
  query: { title?: string; ttl?: string },
): Promise<PublishInput | Response> {
  const maxBundle = Number(env.MAX_BUNDLE_BYTES);
  const maxImage = Number(env.MAX_IMAGE_BYTES);
  const maxDoc = Number(env.MAX_ARTIFACT_BYTES);
  const maxCount = Number(env.MAX_ASSET_COUNT);

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > maxBundle) {
    return errorResponse("too_large", "Bundle exceeds the total size limit.");
  }

  let form: MultipartForm;
  try {
    form = (await request.formData()) as unknown as MultipartForm;
  } catch {
    return errorResponse("invalid_request", "Malformed multipart/form-data body.");
  }

  const doc = form.get("document");
  if (doc === null || typeof doc === "string") {
    return errorResponse("invalid_request", "A multipart publish requires a 'document' file part.");
  }
  const docType = (doc.type || "").split(";")[0].trim().toLowerCase();
  if (docType !== "text/html" && docType !== "text/markdown") {
    return errorResponse("unsupported_content_type", "The document part must be text/html or text/markdown.");
  }

  const imageFiles: File[] = [];
  for (const [name, value] of form.entries()) {
    if (name === "document") continue;
    if (typeof value !== "string") imageFiles.push(value);
  }
  if (imageFiles.length > maxCount) {
    return errorResponse("too_many_assets", `A publish may include at most ${maxCount} images.`);
  }

  const raw = await doc.text();
  let total = new TextEncoder().encode(raw).byteLength;
  if (total > maxDoc) {
    return errorResponse("too_large", "Artifact exceeds the 2 MB size limit.");
  }
  if (raw.trim().length === 0) {
    return errorResponse("invalid_request", "Artifact body must not be empty.");
  }

  const assets: UploadAsset[] = [];
  for (const file of imageFiles) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > maxImage) {
      return errorResponse("too_large", `Image "${file.name}" exceeds the per-image size limit.`);
    }
    total += bytes.byteLength;
    if (total > maxBundle) {
      return errorResponse("too_large", "Bundle exceeds the total size limit.");
    }
    const detected = detectImageType(bytes);
    if (!detected || !ALLOWED_IMAGE_TYPES.has(detected)) {
      return errorResponse(
        "unsupported_content_type",
        `Image "${file.name}" is not a supported type (png, jpeg, gif, webp, avif).`,
      );
    }
    assets.push({ ref: file.name, bytes, contentType: detected });
  }

  const meta = validateTitleTtl(env, query);
  if (meta instanceof Response) return meta;

  let body = raw;
  let resolvedTitle = meta.title;
  if (docType === "text/markdown") {
    const rendered = await renderMarkdown(raw, meta.title ?? undefined);
    body = rendered.html;
    if (resolvedTitle === null) resolvedTitle = rendered.title;
  }
  const passcode = request.headers.get("X-Snapdoc-Passcode") || undefined;
  return { body, contentType: "text/html", title: resolvedTitle, ttlSeconds: meta.ttlSeconds, passcode, assets };
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
  app.use("/whoami", authMiddleware);

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

  // Identity check: a 200 here proves the bearer token is valid (authMiddleware
  // already authenticated it) and reports which token is calling.
  app.get("/whoami", (c) => c.json({ token: tokenJson(c.get("token")) }));

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
      passcode: input.passcode,
      assets: input.assets,
      artifactHost: c.env.ARTIFACT_HOST,
    });
    await store.recordPublish(token.id);
    const json = artifactJson(artifact, c.env);
    if (input.assets) json.unresolved_refs = artifact.unresolvedRefs ?? [];
    return c.json(json, 201);
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
      assets: input.assets,
      artifactHost: c.env.ARTIFACT_HOST,
    });
    await store.recordPublish(token.id);
    const json = artifactJson(artifact, c.env);
    if (input.assets) json.unresolved_refs = artifact.unresolvedRefs ?? [];
    return c.json(json, 201);
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
    const assets = await store.listAssets(found.artifact.id);
    return c.json({
      artifact: artifactJson(found.artifact, c.env),
      versions: found.versions.map(versionJson),
      assets: assets.map((a) => assetJson(found.artifact.id, a, c.env)),
    });
  });

  app.get("/artifacts/:id/comments", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    if (!(await store.getArtifactGate(id))) return errorResponse("not_found", "Artifact not found.");
    const status = parseCommentStatus(c.req.query("status"));
    if (status instanceof Response) return status;
    const { comments, truncated } = await store.listComments(id, status);
    return c.json({
      artifact_id: id,
      comments: comments.map(commentJson),
      ...(truncated ? { truncated: true } : {}),
    });
  });

  // Content read for agents: Markdown by default (far fewer tokens than HTML),
  // raw HTML with ?format=html. A valid token is necessary but NOT sufficient —
  // passcode-protected artifacts still require the X-Snapdoc-Passcode header.
  app.get("/artifacts/:id/content", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");

    const format = parseContentFormat(c.req.query("format"));
    if (format instanceof Response) return format;
    const version = parseContentVersion(c.req.query("version"));
    if (version instanceof Response) return version;

    const gate = await store.getArtifactGate(id);
    if (!gate) return errorResponse("not_found", "Artifact not found.");
    if (gate.status !== "active") return errorResponse("gone", "Artifact is no longer available.");

    if (gate.hasPasscode) {
      const passcode = c.req.header("X-Snapdoc-Passcode");
      if (!passcode) {
        return errorResponse("passcode_required", "This artifact is passcode-protected; supply X-Snapdoc-Passcode.");
      }
      if (!(await store.verifyPasscode(id, passcode))) {
        return errorResponse("passcode_incorrect", "The passcode is incorrect.");
      }
    }

    const content = await store.getServableContent(id, version);
    if (!content) return errorResponse("not_found", "Artifact not found.");
    if (content.state !== "active") return errorResponse("gone", "Artifact is no longer available.");

    let outFormat: "md" | "html" = format;
    let outContent = content.html;
    let outContentType = content.contentType;
    if (format === "md") {
      // Fail soft to raw HTML if conversion degenerates, so an agent always
      // gets usable content; the echoed `format` makes the downgrade visible.
      let markdown = "";
      try {
        markdown = htmlToMarkdown(content.html);
      } catch (err) {
        console.error("html-to-markdown failed", err);
      }
      if (markdown.trim().length > 0) {
        outContent = markdown;
        outContentType = "text/markdown";
      } else {
        outFormat = "html";
      }
    }

    return c.json({
      id,
      version: content.version,
      format: outFormat,
      content_type: outContentType,
      content: outContent,
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

export type CommentStatusFilter = "open" | "resolved" | "all";
const COMMENT_STATUSES: CommentStatusFilter[] = ["open", "resolved", "all"];

// Parses the comment read filter; defaults to "all" so the no-param contract is
// unchanged (open + resolved). Filtering is thread-level, applied on the root.
export function parseCommentStatus(status: string | undefined): CommentStatusFilter | Response {
  if (status === undefined) return "all";
  if (!COMMENT_STATUSES.includes(status as CommentStatusFilter)) {
    return errorResponse("invalid_request", "status must be one of open, resolved, all.");
  }
  return status as CommentStatusFilter;
}

// Content read format: Markdown (default) or the raw stored HTML.
export function parseContentFormat(format: string | undefined): "md" | "html" | Response {
  if (format === undefined) return "md";
  if (format !== "md" && format !== "html") {
    return errorResponse("invalid_request", "format must be one of md, html.");
  }
  return format;
}

export function parseContentVersion(version: string | undefined): number | undefined | Response {
  if (version === undefined) return undefined;
  const parsed = Number(version);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return errorResponse("invalid_request", "version must be a positive integer.");
  }
  return parsed;
}

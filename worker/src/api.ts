// /v1/* publisher endpoints (Bearer token auth).
import { Hono, type Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { mintTokenResponse, verifyBootstrapHeader } from "./admin-api";
import { renderMarkdown } from "./markdown";
import { htmlToMarkdown } from "./html-to-markdown";
import { extractDocText } from "./doc-text";
import { ALLOWED_IMAGE_TYPES, detectImageType } from "./assets";
import {
  Store,
  StoreError,
  type ArtifactStatus,
  type TokenRecord,
  type UploadAsset,
} from "./store";
import {
  artifactDetailJson,
  artifactJson,
  artifactListJson,
  commentJson,
  errorResponse,
  parseDuration,
  tokenJson,
  versionJson,
  videoFileUrl,
  videoPosterUrl,
} from "./http";
import { VideoValidationError, type VideoValidationErrorCode } from "./video";
import type { Env } from "./types";

interface ApiVariables {
  store: Store;
  token: TokenRecord;
}

export type ApiContext = { Bindings: Env; Variables: ApiVariables };

// Stable, client-facing text for each VideoValidationError code. The
// exception's own `message` (mp4box error text, box names/sizes, etc.) is
// internal parser detail — useful in logs and in video.ts's own tests, but
// never sent to a caller, per the brief's "without leaking parser internals."
const VIDEO_VALIDATION_ERROR_MESSAGES: Record<VideoValidationErrorCode, string> = {
  invalid_video: "The uploaded file is not a valid MP4 video.",
  unsupported_video_codec: "The video must be H.264 with optional AAC audio.",
  video_too_long: "The video duration exceeds the maximum of 10 minutes.",
};

export function mapStoreError(err: unknown): Response {
  if (err instanceof StoreError) return errorResponse(err.code, err.message);
  // VideoValidationError is raised by the MP4 inspector deep inside
  // Store.createVideoArtifact/addVideoVersion; it is not a StoreError, so it
  // needs its own mapping here or an invalid upload would fall through to a
  // generic 500 instead of a stable 400 error code.
  if (err instanceof VideoValidationError) {
    console.error("video validation error", err.message);
    return errorResponse(err.code, VIDEO_VALIDATION_ERROR_MESSAGES[err.code]);
  }
  console.error("internal error", err);
  return errorResponse("internal", "Unexpected server error.");
}

// Video artifacts are dispatched on this exact normalized Content-Type,
// ahead of readPublishInput/multipart handling — never buffered whole like a
// document body.
const VIDEO_CONTENT_TYPE = "video/mp4";
// Not independently configurable: the brief's binding list has a default and
// max video TTL but no minimum, so the 1-hour floor is a fixed constant.
const VIDEO_MIN_TTL_SECONDS = 3600;

function normalizedContentType(request: Request): string {
  return (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
}

interface PublishInput {
  body: string;
  contentType: "text/html";
  title: string | null;
  ttlSeconds?: number;
  passcode?: string;
  commentsEnabled?: boolean;
  assets?: UploadAsset[];
}

// Validates ?title=, ?ttl= and ?comments= shared by both publish paths. Returns
// a Response on failure.
function validateTitleTtl(
  env: Env,
  query: { title?: string; ttl?: string; comments?: string },
): { title: string | null; ttlSeconds?: number; commentsEnabled?: boolean } | Response {
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
  let commentsEnabled: boolean | undefined;
  if (query.comments !== undefined) {
    if (query.comments !== "0" && query.comments !== "1") {
      return errorResponse("invalid_request", "comments must be 0 or 1.");
    }
    commentsEnabled = query.comments === "1";
  }
  return { title, ttlSeconds, commentsEnabled };
}

interface VideoPublishInput {
  title: string | null;
  ttlSeconds: number;
  filename: string;
  contentLength: number;
  passcode?: string;
}

// Validates ?title=, ?ttl=, and ?comments= for a video publish. Bounds differ
// from the document path (video-specific default/min/max TTL) and comments
// are rejected outright: line-anchored reader comments are document-only.
function validateVideoTitleTtl(
  env: Env,
  query: { title?: string; ttl?: string; comments?: string },
): { title: string | null; ttlSeconds: number } | Response {
  const title = query.title ?? null;
  if (title !== null && title.length > 200) {
    return errorResponse("invalid_request", "Title must be at most 200 characters.");
  }
  if (query.comments !== undefined) {
    if (query.comments !== "0" && query.comments !== "1") {
      return errorResponse("invalid_request", "comments must be 0 or 1.");
    }
    if (query.comments === "1") {
      return errorResponse(
        "invalid_request",
        "Reader comments are document-only; video artifacts do not support comments.",
      );
    }
  }
  const maxTtl = parseDuration(env.MAX_VIDEO_TTL)!;
  const defaultTtl = parseDuration(env.DEFAULT_VIDEO_TTL)!;
  let ttlSeconds = defaultTtl;
  if (query.ttl !== undefined) {
    const parsed = parseDuration(query.ttl);
    if (parsed === null || parsed < VIDEO_MIN_TTL_SECONDS || parsed > maxTtl) {
      return errorResponse(
        "invalid_ttl",
        `TTL must be a duration between 1h and ${env.MAX_VIDEO_TTL}, e.g. "12h" or "3d".`,
      );
    }
    ttlSeconds = parsed;
  }
  return { title, ttlSeconds };
}

// Validates a raw video/mp4 publish: title/ttl/comments query params plus a
// required, bounded Content-Length. Never reads the body — request.body
// streams straight to Store untouched.
function readVideoPublishInput(
  request: Request,
  env: Env,
  query: { title?: string; ttl?: string; comments?: string; filename?: string },
): VideoPublishInput | Response {
  const meta = validateVideoTitleTtl(env, query);
  if (meta instanceof Response) return meta;

  const maxBytes = Number(env.MAX_VIDEO_BYTES);
  const contentLengthHeader = request.headers.get("Content-Length");
  const contentLength = contentLengthHeader !== null ? Number(contentLengthHeader) : NaN;
  if (!Number.isFinite(contentLength) || !Number.isInteger(contentLength) || contentLength <= 0) {
    return errorResponse(
      "invalid_request",
      "Content-Length is required for video uploads and must be a positive integer.",
    );
  }
  if (contentLength > maxBytes) {
    return errorResponse("too_large", `Video exceeds the ${maxBytes}-byte size limit.`);
  }

  const passcode = request.headers.get("X-Snapdoc-Passcode") || undefined;
  return {
    title: meta.title,
    ttlSeconds: meta.ttlSeconds,
    filename: query.filename ?? "",
    contentLength,
    passcode,
  };
}

// Validates the shared publish inputs (content type, size, ttl, title) and
// renders markdown to a self-contained HTML document. A multipart/form-data
// body (document + image parts) is handled separately. Returns a Response on
// validation failure.
export async function readPublishInput(
  request: Request,
  env: Env,
  query: { title?: string; ttl?: string; comments?: string },
): Promise<PublishInput | Response> {
  const rawType = normalizedContentType(request);
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
  return {
    body,
    contentType: "text/html",
    title: resolvedTitle,
    ttlSeconds: meta.ttlSeconds,
    passcode,
    commentsEnabled: meta.commentsEnabled,
  };
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
  query: { title?: string; ttl?: string; comments?: string },
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
  return {
    body,
    contentType: "text/html",
    title: resolvedTitle,
    ttlSeconds: meta.ttlSeconds,
    passcode,
    commentsEnabled: meta.commentsEnabled,
    assets,
  };
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

// Poster uploads are small (<= MAX_POSTER_BYTES, 5 MiB), so this may buffer
// the body with arrayBuffer() — unlike the primary video body, which always
// streams straight to R2. Both the declared Content-Length and the actual
// buffered size are checked; Store sniffs the bytes and rejects anything
// that isn't really a JPEG/PNG matching the declared Content-Type.
async function uploadVideoPoster(
  c: Context<ApiContext, "/artifacts/:id/versions/:version/poster">,
): Promise<Response> {
  const store = c.get("store");
  const token = c.get("token");
  const rateLimited = await enforceRateLimit(store, token.id, c.env);
  if (rateLimited) return rateLimited;

  const id = c.req.param("id");
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version) || version < 1) {
    return errorResponse("invalid_request", "version must be a positive integer.");
  }

  const contentType = normalizedContentType(c.req.raw);
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    return errorResponse("unsupported_content_type", "Poster Content-Type must be image/jpeg or image/png.");
  }

  const maxBytes = Number(c.env.MAX_POSTER_BYTES);
  const contentLengthHeader = c.req.raw.headers.get("Content-Length");
  const declaredLength = contentLengthHeader !== null ? Number(contentLengthHeader) : NaN;
  if (!Number.isFinite(declaredLength) || !Number.isInteger(declaredLength) || declaredLength <= 0) {
    return errorResponse(
      "invalid_request",
      "Content-Length is required for poster uploads and must be a positive integer.",
    );
  }
  if (declaredLength > maxBytes) {
    return errorResponse("too_large", `Poster exceeds the ${maxBytes}-byte size limit.`);
  }

  const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
  if (bytes.byteLength !== declaredLength) {
    return errorResponse("invalid_request", "Uploaded poster size does not match the declared Content-Length.");
  }

  const video = await store.setVideoPoster(id, version, bytes, contentType);
  const found = await store.getArtifact(id);
  if (!found) return errorResponse("not_found", "Artifact not found.");
  const versionEntry = found.versions.find((v) => v.version === version);
  if (!versionEntry) return errorResponse("not_found", "Video version not found.");

  const json: Record<string, unknown> = versionJson(versionEntry, { id, env: c.env, video });
  // Only the current version's poster affects the stable (non-versioned) URLs.
  if (found.artifact.currentVersion === version) {
    json.url = `https://${c.env.ARTIFACT_HOST}/${id}`;
    json.file_url = videoFileUrl(id, video.filename, c.env);
    json.poster_url = videoPosterUrl(id, video, c.env);
  }
  return c.json(json);
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

    // Video is dispatched on the normalized Content-Type before any document
    // parsing — request.body streams straight to Store, never buffered.
    if (normalizedContentType(c.req.raw) === VIDEO_CONTENT_TYPE) {
      const input = readVideoPublishInput(c.req.raw, c.env, {
        title: c.req.query("title"),
        ttl: c.req.query("ttl"),
        comments: c.req.query("comments"),
        filename: c.req.query("filename"),
      });
      if (input instanceof Response) return input;
      const body = c.req.raw.body;
      if (!body) return errorResponse("invalid_request", "A video body is required.");

      const artifact = await store.createVideoArtifact({
        tokenId: token.id,
        title: input.title,
        ttlSeconds: input.ttlSeconds,
        filename: input.filename,
        contentLength: input.contentLength,
        maxDurationMs: Number(c.env.MAX_VIDEO_DURATION_SECONDS) * 1000,
        body,
        passcode: input.passcode,
      });
      await store.recordPublish(token.id);
      return c.json(artifactJson(artifact, c.env, { video: artifact.video }), 201);
    }

    const input = await readPublishInput(c.req.raw, c.env, {
      title: c.req.query("title"),
      ttl: c.req.query("ttl"),
      comments: c.req.query("comments"),
    });
    if (input instanceof Response) return input;

    const artifact = await store.createArtifact({
      tokenId: token.id,
      title: input.title,
      ttlSeconds: input.ttlSeconds ?? parseDuration(c.env.DEFAULT_TTL)!,
      contentType: input.contentType,
      body: input.body,
      passcode: input.passcode,
      commentsEnabled: input.commentsEnabled,
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

    if (normalizedContentType(c.req.raw) === VIDEO_CONTENT_TYPE) {
      const input = readVideoPublishInput(c.req.raw, c.env, {
        title: c.req.query("title"),
        ttl: c.req.query("ttl"),
        comments: c.req.query("comments"),
        filename: c.req.query("filename"),
      });
      if (input instanceof Response) return input;
      const body = c.req.raw.body;
      if (!body) return errorResponse("invalid_request", "A video body is required.");

      const artifact = await store.addVideoVersion(c.req.param("id"), {
        title: input.title,
        ttlSeconds: input.ttlSeconds,
        filename: input.filename,
        contentLength: input.contentLength,
        maxDurationMs: Number(c.env.MAX_VIDEO_DURATION_SECONDS) * 1000,
        body,
      });
      await store.recordPublish(token.id);
      return c.json(artifactJson(artifact, c.env, { video: artifact.video }), 201);
    }

    const input = await readPublishInput(c.req.raw, c.env, {
      title: c.req.query("title"),
      ttl: c.req.query("ttl"),
      comments: c.req.query("comments"),
    });
    if (input instanceof Response) return input;

    const artifact = await store.addVersion(c.req.param("id"), {
      title: input.title,
      ttlSeconds: input.ttlSeconds,
      defaultTtlSeconds: parseDuration(c.env.DEFAULT_TTL)!,
      contentType: input.contentType,
      body: input.body,
      commentsEnabled: input.commentsEnabled,
      assets: input.assets,
      artifactHost: c.env.ARTIFACT_HOST,
    });
    await store.recordPublish(token.id);
    const json = artifactJson(artifact, c.env);
    if (input.assets) json.unresolved_refs = artifact.unresolvedRefs ?? [];
    return c.json(json, 201);
  });

  app.put("/artifacts/:id/versions/:version/poster", uploadVideoPoster);

  app.get("/artifacts", async (c) => {
    const store = c.get("store");
    const token = c.get("token");
    const params = parseListParams(c.req.query("status"), c.req.query("limit"), c.req.query("cursor"));
    if (params instanceof Response) return params;
    const { artifacts, nextCursor } = await store.listArtifacts({ tokenId: token.id, ...params });
    const jsons = await artifactListJson(store, artifacts, c.env);
    return c.json({
      artifacts: jsons,
      next_cursor: nextCursor,
    });
  });

  app.get("/artifacts/:id", async (c) => {
    const store = c.get("store");
    const found = await store.getArtifact(c.req.param("id"));
    if (!found) return errorResponse("not_found", "Artifact not found.");
    return c.json(await artifactDetailJson(store, found, c.env));
  });

  app.get("/artifacts/:id/comments", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    if (!(await store.getArtifactGate(id))) return errorResponse("not_found", "Artifact not found.");
    const status = parseCommentStatus(c.req.query("status"));
    if (status instanceof Response) return status;
    const { comments, truncated } = await store.listComments(id, status);

    // Anchored roots get an `orphaned` flag: does the quoted text still exist
    // in the current version? Mirrors the review page's in-browser judgement
    // so agents can skip stale feedback without rendering anything.
    const anchoredRoots = comments.filter((cm) => cm.parentId === null && cm.anchor);
    const orphanedById = new Map<string, boolean>();
    if (anchoredRoots.length > 0) {
      const content = await store.getServableContent(id);
      if (content?.state === "active") {
        const docText = await extractDocText(content.html);
        for (const cm of anchoredRoots) orphanedById.set(cm.id, !docText.includes(cm.anchor!.exact));
      }
    }

    return c.json({
      artifact_id: id,
      comments: comments.map((cm) => {
        const json = commentJson(cm);
        const orphaned = orphanedById.get(cm.id);
        if (orphaned !== undefined) json.orphaned = orphaned;
        return json;
      }),
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

    // getArtifact (not the lighter getArtifactGate) so `kind` is available —
    // this endpoint is document-only and must reject video artifacts below.
    const found = await store.getArtifact(id);
    if (!found) return errorResponse("not_found", "Artifact not found.");
    const gate = found.artifact;
    if (gate.status !== "active") return errorResponse("gone", "Artifact is no longer available.");
    if (gate.kind === "video") {
      return errorResponse(
        "invalid_request",
        "Video artifacts have no text content; use the watch page or file URL from the artifact metadata instead.",
      );
    }

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
    return c.json(artifactJson(artifact, c.env));
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

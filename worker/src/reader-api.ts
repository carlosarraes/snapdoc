// /v1/reader/* — the PUBLIC, unauthenticated comment API behind the review page.
// This is a whole app with no auth middleware (rather than public paths bolted
// onto the Bearer publisher app) so the no-auth boundary can't be eroded by a
// future app.use("*"). Every write is gated by the artifact's comments_enabled
// opt-in and a per-IP + per-artifact rate limit; authors are pseudonymous.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { mapStoreError, parseCommentStatus } from "./api";
import { commentJson, errorResponse, MAX_COMMENT_BYTES } from "./http";
import { Store, type Anchor } from "./store";
import type { Env } from "./types";

type ReaderCtx = { Bindings: Env; Variables: { store: Store } };

const VIEWER_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const VIEWER_COOKIE = "sd_reviewer";
const VIEWER_ID_PATTERN = /^rvw_[A-Za-z0-9_-]{32}$/;
// Long-lived so a reader can still delete their own comments on a later visit.
const VIEWER_COOKIE_MAX_AGE = 180 * 24 * 3600;

const MAX_AUTHOR_NAME = 80;
const MAX_AUTHOR_EMAIL = 254;
const MAX_ANCHOR_EXACT = 1000;
const MAX_ANCHOR_CONTEXT = 64;

function newViewerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = "";
  for (const b of bytes) out += VIEWER_ID_ALPHABET[b & 63];
  return `rvw_${out}`;
}

async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}${salt}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Validates the W3C-style anchor sent by the annotator. Prefix/suffix default to
// "" (a selection at the very start/end of the document has no context on one
// side). Returns a Response on any shape violation.
function parseAnchor(value: unknown): Anchor | Response {
  if (typeof value !== "object" || value === null) {
    return errorResponse("invalid_request", "A root comment requires an anchor.");
  }
  const a = value as Record<string, unknown>;
  const exact = a.exact;
  const prefix = a.prefix ?? "";
  const suffix = a.suffix ?? "";
  const { start, end } = a;
  if (typeof exact !== "string" || exact.length < 1 || exact.length > MAX_ANCHOR_EXACT) {
    return errorResponse("invalid_request", `anchor.exact must be 1–${MAX_ANCHOR_EXACT} characters.`);
  }
  if (typeof prefix !== "string" || prefix.length > MAX_ANCHOR_CONTEXT) {
    return errorResponse("invalid_request", `anchor.prefix must be at most ${MAX_ANCHOR_CONTEXT} characters.`);
  }
  if (typeof suffix !== "string" || suffix.length > MAX_ANCHOR_CONTEXT) {
    return errorResponse("invalid_request", `anchor.suffix must be at most ${MAX_ANCHOR_CONTEXT} characters.`);
  }
  if (!Number.isInteger(start) || (start as number) < 0) {
    return errorResponse("invalid_request", "anchor.start must be a non-negative integer.");
  }
  if (!Number.isInteger(end) || (end as number) < (start as number)) {
    return errorResponse("invalid_request", "anchor.end must be an integer ≥ anchor.start.");
  }
  return { exact, prefix, suffix, start: start as number, end: end as number };
}

export function createReaderApp(): Hono<ReaderCtx> {
  const app = new Hono<ReaderCtx>();

  app.use("*", async (c, next) => {
    c.set("store", new Store(c.env.DB, c.env.BLOBS));
    await next();
  });
  app.onError((err) => mapStoreError(err));

  // Public metadata for the review page shell (no internal/owner fields).
  app.get("/artifacts/:id", async (c) => {
    const found = await c.get("store").getArtifact(c.req.param("id"));
    if (!found) return errorResponse("not_found", "Artifact not found.");
    if (found.artifact.status !== "active") return errorResponse("gone", "Artifact is no longer available.");
    return c.json({
      id: found.artifact.id,
      title: found.artifact.title,
      current_version: found.artifact.currentVersion,
      comments_enabled: found.artifact.commentsEnabled,
      versions: found.versions.map((v) => ({ version: v.version, created_at: v.createdAt })),
    });
  });

  // Reads stay open even if the owner later disables commenting, so existing
  // reader feedback remains visible; only writes are gated.
  app.get("/artifacts/:id/comments", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");
    if (!(await store.getArtifactGate(id))) return errorResponse("not_found", "Artifact not found.");
    const status = parseCommentStatus(c.req.query("status"));
    if (status instanceof Response) return status;
    const { comments, truncated } = await store.listReaderComments(id, status);
    return c.json({
      artifact_id: id,
      comments: comments.map((cm) => commentJson(cm, { public: true })),
      ...(truncated ? { truncated: true } : {}),
    });
  });

  app.post("/artifacts/:id/comments", async (c) => {
    const store = c.get("store");
    const id = c.req.param("id");

    const gate = await store.getArtifactGate(id);
    if (!gate) return errorResponse("not_found", "Artifact not found.");
    if (gate.status !== "active") return errorResponse("gone", "Artifact is no longer available.");
    if (!gate.commentsEnabled) return errorResponse("comments_disabled", "Commenting is not enabled for this artifact.");

    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const ipHash = await hashIp(ip, c.env.COMMENT_IP_SALT ?? "");
    const rate = await store.checkCommentRateLimit(
      ipHash,
      id,
      Number(c.env.COMMENT_RATE_LIMIT_PER_IP_PER_HOUR),
      Number(c.env.COMMENT_RATE_LIMIT_PER_ARTIFACT_PER_HOUR),
    );
    if (!rate.allowed) {
      return errorResponse(
        "rate_limited",
        `Comment rate limit exceeded (${rate.scope}); retry after ${rate.retryAfterSeconds}s.`,
        { "Retry-After": String(rate.retryAfterSeconds) },
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("invalid_request", "Body must be JSON.");
    }

    const authorName = typeof payload.author_name === "string" ? payload.author_name.trim() : "";
    if (authorName.length < 1 || authorName.length > MAX_AUTHOR_NAME) {
      return errorResponse("invalid_request", `author_name must be 1–${MAX_AUTHOR_NAME} characters.`);
    }

    let authorEmail: string | null = null;
    if (payload.author_email !== undefined && payload.author_email !== null && payload.author_email !== "") {
      const email = payload.author_email;
      if (typeof email !== "string" || email.length > MAX_AUTHOR_EMAIL || !email.includes("@")) {
        return errorResponse("invalid_request", "author_email must be a valid email address.");
      }
      authorEmail = email;
    }

    const body = payload.body;
    if (typeof body !== "string" || body.trim().length === 0) {
      return errorResponse("invalid_request", "Comment body is required.");
    }
    if (new TextEncoder().encode(body).byteLength > MAX_COMMENT_BYTES) {
      return errorResponse("invalid_request", "Comment exceeds the 8 KB limit.");
    }

    const parentId = payload.parent_id;
    if (parentId !== undefined && parentId !== null && typeof parentId !== "string") {
      return errorResponse("invalid_request", "parent_id must be a string.");
    }

    const version = payload.version;
    if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1)) {
      return errorResponse("invalid_request", "version must be a positive integer.");
    }

    // A root comment must anchor to selected text; a reply hangs off its thread.
    let anchor: Anchor | null = null;
    if (parentId === undefined || parentId === null) {
      const parsed = parseAnchor(payload.anchor);
      if (parsed instanceof Response) return parsed;
      anchor = parsed;
    }

    let viewerId = getCookie(c, VIEWER_COOKIE);
    let mintCookie = false;
    if (!viewerId || !VIEWER_ID_PATTERN.test(viewerId)) {
      viewerId = newViewerId();
      mintCookie = true;
    }

    const comment = await store.addComment(id, {
      author: authorName,
      authorKind: "anon",
      authorEmail,
      body,
      parentId: typeof parentId === "string" ? parentId : null,
      version: typeof version === "number" ? version : undefined,
      anchor,
      viewerId,
    });
    await store.recordCommentEvent(ipHash, id);

    if (mintCookie) {
      setCookie(c, VIEWER_COOKIE, viewerId, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: VIEWER_COOKIE_MAX_AGE,
      });
    }
    return c.json(commentJson(comment, { public: true }), 201);
  });

  // Thread resolution from the review page. Anyone who can comment can mark a
  // thread resolved or reopen it; the id re-roots to the thread root. The
  // attribution records the typed reader name tagged "(reader)" so it can
  // never be mistaken for a verified Access email in resolved_by.
  app.patch("/comments/:cid", async (c) => {
    const store = c.get("store");

    let payload: Record<string, unknown>;
    try {
      payload = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse("invalid_request", 'Body must be JSON: { "resolved": true|false, "author_name": "..." }.');
    }
    if (typeof payload.resolved !== "boolean") {
      return errorResponse("invalid_request", "resolved must be a boolean.");
    }
    const authorName = typeof payload.author_name === "string" ? payload.author_name.trim() : "";
    if (authorName.length < 1 || authorName.length > MAX_AUTHOR_NAME) {
      return errorResponse("invalid_request", `author_name must be 1–${MAX_AUTHOR_NAME} characters.`);
    }

    const comment = await store.getLiveComment(c.req.param("cid"));
    if (!comment) return errorResponse("not_found", "Comment not found.");
    const gate = await store.getArtifactGate(comment.artifactId);
    if (!gate) return errorResponse("not_found", "Comment not found.");
    if (gate.status !== "active") return errorResponse("gone", "Artifact is no longer available.");
    if (!gate.commentsEnabled) return errorResponse("comments_disabled", "Commenting is not enabled for this artifact.");

    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const ipHash = await hashIp(ip, c.env.COMMENT_IP_SALT ?? "");
    const rate = await store.checkCommentRateLimit(
      ipHash,
      comment.artifactId,
      Number(c.env.COMMENT_RATE_LIMIT_PER_IP_PER_HOUR),
      Number(c.env.COMMENT_RATE_LIMIT_PER_ARTIFACT_PER_HOUR),
    );
    if (!rate.allowed) {
      return errorResponse(
        "rate_limited",
        `Comment rate limit exceeded (${rate.scope}); retry after ${rate.retryAfterSeconds}s.`,
        { "Retry-After": String(rate.retryAfterSeconds) },
      );
    }

    const updated = await store.setCommentResolved(comment.id, payload.resolved, `${authorName} (reader)`);
    if (!updated) return errorResponse("not_found", "Comment not found.");
    await store.recordCommentEvent(ipHash, comment.artifactId);
    return c.json(commentJson(updated, { public: true }));
  });

  // Session self-delete: the viewer cookie is the only capability. A missing
  // cookie or a mismatch reads as "not found", never revealing the comment.
  app.delete("/comments/:cid", async (c) => {
    const viewerId = getCookie(c, VIEWER_COOKIE);
    if (!viewerId) return errorResponse("not_found", "Comment not found.");
    const result = await c.get("store").deleteReaderComment(c.req.param("cid"), viewerId);
    if (!result) return errorResponse("not_found", "Comment not found.");
    return c.json({ id: result.id, deleted_at: result.deletedAt });
  });

  return app;
}

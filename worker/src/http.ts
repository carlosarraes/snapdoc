// Shared HTTP helpers: error envelope, artifact JSON shape, duration parsing.
import type { Artifact, ArtifactVersion, Comment, StoredAsset, StoreErrorCode, TokenRecord } from "./store";
import type { Env } from "./types";

export type ErrorCode =
  | "invalid_request"
  | "invalid_ttl"
  | "unsupported_content_type"
  | "unauthorized"
  | "passcode_required"
  | "passcode_incorrect"
  | "not_found"
  | "gone"
  | "not_active"
  | "too_large"
  | "too_many_assets"
  | "rate_limited"
  | "comments_disabled"
  | "misconfigured"
  | "internal";

const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_ttl: 400,
  unsupported_content_type: 400,
  unauthorized: 401,
  passcode_required: 401,
  passcode_incorrect: 401,
  not_found: 404,
  gone: 410,
  not_active: 409,
  too_large: 413,
  too_many_assets: 400,
  rate_limited: 429,
  comments_disabled: 403,
  misconfigured: 503,
  internal: 500,
};

// Shared cap for both comment channels (team via Access, reader via review page).
export const MAX_COMMENT_BYTES = 8 * 1024;

export function errorResponse(code: ErrorCode, message: string, headers?: Record<string, string>): Response {
  return Response.json(
    { error: { code, message } },
    { status: ERROR_STATUS[code], headers },
  );
}

export function storeErrorResponse(code: StoreErrorCode, message: string): Response {
  return errorResponse(code, message);
}

export function artifactJson(artifact: Artifact, env: Env, opts: { admin?: boolean } = {}) {
  const json: Record<string, unknown> = {
    id: artifact.id,
    url: `https://${env.ARTIFACT_HOST}/${artifact.id}`,
    title: artifact.title,
    status: artifact.status,
    current_version: artifact.currentVersion,
    content_type: artifact.contentType,
    size_bytes: artifact.sizeBytes,
    created_at: artifact.createdAt,
    expires_at: artifact.expiresAt,
    has_passcode: artifact.hasPasscode,
    comments_enabled: artifact.commentsEnabled,
  };
  if (opts.admin) json.token_name = artifact.tokenName ?? null;
  return json;
}

// The `public` shape is served by the anonymous review rail; it carries the
// text anchor but withholds author_email (unverified, and reader-private).
export function commentJson(comment: Comment, opts: { public?: boolean } = {}) {
  const json: Record<string, unknown> = {
    id: comment.id,
    author: comment.author,
    author_kind: comment.authorKind,
    version: comment.version,
    body: comment.body,
    created_at: comment.createdAt,
    parent_id: comment.parentId,
    resolved: comment.resolvedAt !== null,
    resolved_at: comment.resolvedAt,
    resolved_by: comment.resolvedBy,
    anchor: comment.anchor,
  };
  if (!opts.public) json.author_email = comment.authorEmail;
  return json;
}

// Identity subset of a token for /v1/whoami. Deliberately omits last_used_at
// (auth just refreshed it to now, so it would always echo "now") and revoked_at
// (a revoked token never reaches an authenticated handler).
export function tokenJson(token: TokenRecord) {
  return {
    id: token.id,
    name: token.name,
    created_at: token.createdAt,
  };
}

export function versionJson(version: ArtifactVersion) {
  return {
    version: version.version,
    size_bytes: version.sizeBytes,
    content_type: version.contentType,
    created_at: version.createdAt,
  };
}

export function assetJson(artifactId: string, asset: StoredAsset, env: Env) {
  return {
    hash: asset.hash,
    content_type: asset.contentType,
    size_bytes: asset.sizeBytes,
    url: `https://${env.ARTIFACT_HOST}/${artifactId}/a/${asset.hash}`,
    created_at: asset.createdAt,
  };
}

const DURATION_PATTERN = /^(\d+)(h|d)$/;

export function parseDuration(value: string): number | null {
  const match = DURATION_PATTERN.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return amount * (match[2] === "h" ? 3600 : 86400);
}

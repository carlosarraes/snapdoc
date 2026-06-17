// Shared HTTP helpers: error envelope, artifact JSON shape, duration parsing.
import type { Artifact, ArtifactVersion, Comment, StoreErrorCode } from "./store";
import type { Env } from "./types";

export type ErrorCode =
  | "invalid_request"
  | "invalid_ttl"
  | "unsupported_content_type"
  | "unauthorized"
  | "not_found"
  | "not_active"
  | "too_large"
  | "rate_limited"
  | "misconfigured"
  | "internal";

const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_ttl: 400,
  unsupported_content_type: 400,
  unauthorized: 401,
  not_found: 404,
  not_active: 409,
  too_large: 413,
  rate_limited: 429,
  misconfigured: 503,
  internal: 500,
};

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
  };
  if (opts.admin) json.token_name = artifact.tokenName ?? null;
  return json;
}

export function commentJson(comment: Comment) {
  return {
    id: comment.id,
    author: comment.author,
    version: comment.version,
    body: comment.body,
    created_at: comment.createdAt,
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

const DURATION_PATTERN = /^(\d+)(h|d)$/;

export function parseDuration(value: string): number | null {
  const match = DURATION_PATTERN.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return amount * (match[2] === "h" ? 3600 : 86400);
}

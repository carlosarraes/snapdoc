// Shared HTTP helpers: error envelope, artifact JSON shape, duration parsing.
import type {
  Artifact,
  ArtifactVersion,
  Comment,
  StoredAsset,
  StoreErrorCode,
  TokenRecord,
  VideoVersionMetadata,
} from "./store";
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
  | "internal"
  | "kind_mismatch"
  | "invalid_video"
  | "unsupported_video_codec"
  | "video_too_long"
  | "range_not_satisfiable";

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
  kind_mismatch: 400,
  invalid_video: 400,
  unsupported_video_codec: 400,
  video_too_long: 400,
  range_not_satisfiable: 416,
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

// ---- video artifact URLs ----
// R2 keys are private implementation details; every URL below is a
// presentation route resolved through Store at serve time (Task 5), never
// derived from an R2 key. The poster file extension mirrors the sniffed
// content type stored in `video_versions.poster_content_type`.

function posterExtension(contentType: "image/jpeg" | "image/png"): "jpg" | "png" {
  return contentType === "image/jpeg" ? "jpg" : "png";
}

export function videoFileUrl(id: string, filename: string, env: Env): string {
  return `https://${env.ARTIFACT_HOST}/${id}/media/${filename}`;
}

export function videoVersionUrl(id: string, version: number, env: Env): string {
  return `https://${env.ARTIFACT_HOST}/${id}/v/${version}`;
}

export function videoVersionFileUrl(id: string, version: number, filename: string, env: Env): string {
  return `https://${env.ARTIFACT_HOST}/${id}/v/${version}/media/${filename}`;
}

export function videoPosterUrl(id: string, video: VideoVersionMetadata, env: Env): string | null {
  if (!video.posterContentType) return null;
  return `https://${env.ARTIFACT_HOST}/${id}/poster.${posterExtension(video.posterContentType)}`;
}

export function videoVersionPosterUrl(id: string, version: number, video: VideoVersionMetadata, env: Env): string | null {
  if (!video.posterContentType) return null;
  return `https://${env.ARTIFACT_HOST}/${id}/v/${version}/poster.${posterExtension(video.posterContentType)}`;
}

export function artifactJson(
  artifact: Artifact,
  env: Env,
  opts: { admin?: boolean; video?: VideoVersionMetadata } = {},
) {
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
    kind: artifact.kind,
  };
  if (opts.admin) json.token_name = artifact.tokenName ?? null;
  if (artifact.kind === "video" && opts.video) {
    const video = opts.video;
    json.file_url = videoFileUrl(artifact.id, video.filename, env);
    json.version_url = videoVersionUrl(artifact.id, artifact.currentVersion, env);
    json.version_file_url = videoVersionFileUrl(artifact.id, artifact.currentVersion, video.filename, env);
    json.poster_url = videoPosterUrl(artifact.id, video, env);
    json.version_poster_url = videoVersionPosterUrl(artifact.id, artifact.currentVersion, video, env);
    json.duration_ms = video.durationMs;
    json.width = video.width;
    json.height = video.height;
    json.video_codec = video.videoCodec;
    json.audio_codec = video.audioCodec;
  }
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

// `ctx` is optional and additive only: existing callers that pass just a
// version keep the pre-video shape (document behavior unchanged). Video
// fields require `ctx` (the artifact id + env to build URLs, plus the
// version's own video metadata) — without it a video's entry still reports
// its base fields (version, size_bytes, content_type, created_at, kind) but
// no URLs, matching the "additive JSON only" contract rather than guessing.
export function versionJson(
  version: ArtifactVersion,
  ctx?: { id: string; env: Env; video?: VideoVersionMetadata },
) {
  const json: Record<string, unknown> = {
    version: version.version,
    size_bytes: version.sizeBytes,
    content_type: version.contentType,
    created_at: version.createdAt,
    kind: version.kind,
  };
  if (version.kind === "video" && ctx?.video) {
    const { id, env, video } = ctx;
    json.version_url = videoVersionUrl(id, version.version, env);
    json.version_file_url = videoVersionFileUrl(id, version.version, video.filename, env);
    json.version_poster_url = videoVersionPosterUrl(id, version.version, video, env);
    json.duration_ms = video.durationMs;
    json.width = video.width;
    json.height = video.height;
    json.video_codec = video.videoCodec;
    json.audio_codec = video.audioCodec;
  }
  return json;
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

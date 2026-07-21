export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  ARTIFACT_HOST: string;
  API_HOST: string;
  MAX_ARTIFACT_BYTES: string;
  MAX_IMAGE_BYTES: string;
  MAX_BUNDLE_BYTES: string;
  MAX_ASSET_COUNT: string;
  DEFAULT_TTL: string;
  MAX_TTL: string;
  MIN_TTL: string;
  MAX_VIDEO_BYTES: string;
  MAX_VIDEO_DURATION_SECONDS: string;
  DEFAULT_VIDEO_TTL: string;
  MAX_VIDEO_TTL: string;
  MAX_POSTER_BYTES: string;
  RATE_LIMIT_PER_HOUR: string;
  COMMENT_RATE_LIMIT_PER_IP_PER_HOUR: string;
  COMMENT_RATE_LIMIT_PER_ARTIFACT_PER_HOUR: string;
  // "dev" or "test" enables the admin-auth dev stub; leave unset in production.
  ENVIRONMENT?: string;
  ADMIN_BOOTSTRAP?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  // Salt for hashing reader IPs before storing them in comment_events.
  COMMENT_IP_SALT?: string;
}

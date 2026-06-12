export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  ARTIFACT_HOST: string;
  API_HOST: string;
  MAX_ARTIFACT_BYTES: string;
  DEFAULT_TTL: string;
  MAX_TTL: string;
  MIN_TTL: string;
  RATE_LIMIT_PER_HOUR: string;
  ADMIN_BOOTSTRAP?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

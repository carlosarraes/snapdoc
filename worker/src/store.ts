// Deep module owning all R2 + D1 access and artifact/token lifecycle rules.
// No raw SQL should exist outside this file.
import { normalizeRef, rewriteImageRefs } from "./assets";

export type ArtifactStatus = "active" | "expired" | "deleted";

export type ArtifactKind = "document" | "video";

export interface Artifact {
  id: string;
  title: string | null;
  status: ArtifactStatus;
  currentVersion: number;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  tokenId: string;
  tokenName?: string;
  hasPasscode: boolean;
  commentsEnabled: boolean;
  kind: ArtifactKind;
}

export interface ArtifactVersion {
  version: number;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  kind: ArtifactKind;
}

// Per-version video metadata, keyed alongside the shared `versions` row it
// describes. Populated only for `kind = 'video'` artifacts (later tasks).
export interface VideoVersionMetadata {
  artifactId: string;
  version: number;
  filename: string;
  durationMs: number;
  width: number;
  height: number;
  videoCodec: "h264";
  audioCodec: "aac" | null;
  posterR2Key: string | null;
  posterContentType: "image/jpeg" | "image/png" | null;
  posterSizeBytes: number | null;
}

// An image attached to a publish: `ref` is the verbatim reference string from
// the document (used to match and rewrite it), `bytes`/`contentType` the file.
export interface UploadAsset {
  ref: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface StoredAsset {
  hash: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

// A text-anchor: a highlighted span located by its quoted text plus surrounding
// context (W3C-style TextQuote + TextPosition selectors). Reader comments carry
// one; team/Access comments do not (anchor === null).
export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface Comment {
  id: string;
  artifactId: string;
  version: number;
  author: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  authorKind: "access" | "anon";
  authorEmail: string | null;
  anchor: Anchor | null;
  // Opaque self-delete capability for anonymous authors; never serialized.
  viewerId: string | null;
}

export interface TokenRecord {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type ServableContent =
  | { state: "active"; html: string; contentType: string; version: number }
  | { state: "expired" }
  | { state: "deleted" };

export type StoreErrorCode = "not_found" | "not_active" | "invalid_request" | "kind_mismatch";

export class StoreError extends Error {
  constructor(
    public readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const ARTIFACT_ID_LENGTH = 14;
// Blobs of expired artifacts are retained for a grace period (so version history
// survives a quick reactivation) before the cron purge removes them.
const EXPIRED_BLOB_RETENTION_SECONDS = 7 * 86400;
const COMMENTS_LIMIT = 500;

function randomId(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b & 63];
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
}

// Passcodes are low-entropy, so derive a slow salted hash (PBKDF2) rather than a
// bare SHA-256 — resists brute force if the metadata DB ever leaks.
const PASSCODE_ITERATIONS = 100_000;

async function derivePasscodeHash(passcode: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PASSCODE_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

// Opaque viewer token = HMAC(key = stored passcode hash, msg = artifact id).
// Verifiable server-side from the stored hash, so no session table or extra
// secret is needed; knowing it proves the holder already cleared the passcode.
async function deriveViewerToken(passcodeHashHex: string, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(passcodeHashHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  return bytesToHex(new Uint8Array(sig));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function r2Key(artifactId: string, version: number): string {
  return `artifacts/${artifactId}/v${version}`;
}

function assetR2Key(artifactId: string, hash: string): string {
  return `artifacts/${artifactId}/assets/${hash}`;
}

interface ArtifactRow {
  id: string;
  title: string | null;
  status: string;
  effective_status: string;
  token_id: string;
  token_name?: string;
  current_version: number;
  created_at: string;
  expires_at: string;
  content_type: string;
  size_bytes: number;
  has_passcode: number;
  comments_enabled: number;
  kind: string;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  const artifact: Artifact = {
    id: row.id,
    title: row.title,
    status: row.effective_status as ArtifactStatus,
    currentVersion: row.current_version,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    tokenId: row.token_id,
    hasPasscode: !!row.has_passcode,
    commentsEnabled: !!row.comments_enabled,
    kind: row.kind as ArtifactKind,
  };
  if (row.token_name !== undefined) artifact.tokenName = row.token_name;
  return artifact;
}

interface CommentRow {
  id: string;
  artifact_id: string;
  version: number;
  author: string;
  body: string;
  created_at: string;
  parent_id: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  author_kind: string;
  author_email: string | null;
  viewer_id: string | null;
  anchor_exact: string | null;
  anchor_prefix: string | null;
  anchor_suffix: string | null;
  anchor_start: number | null;
  anchor_end: number | null;
}

const COMMENT_COLUMNS =
  "id, artifact_id, version, author, body, created_at, parent_id, resolved_at, resolved_by, " +
  "author_kind, author_email, viewer_id, anchor_exact, anchor_prefix, anchor_suffix, anchor_start, anchor_end";

function rowToComment(r: CommentRow): Comment {
  const anchor: Anchor | null =
    r.anchor_exact !== null && r.anchor_start !== null && r.anchor_end !== null
      ? {
          exact: r.anchor_exact,
          prefix: r.anchor_prefix ?? "",
          suffix: r.anchor_suffix ?? "",
          start: r.anchor_start,
          end: r.anchor_end,
        }
      : null;
  return {
    id: r.id,
    artifactId: r.artifact_id,
    version: r.version,
    author: r.author,
    body: r.body,
    createdAt: r.created_at,
    parentId: r.parent_id,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    authorKind: r.author_kind === "anon" ? "anon" : "access",
    authorEmail: r.author_email,
    anchor,
    viewerId: r.viewer_id,
  };
}

// Groups a flat, time-ordered comment page into thread-contiguous order (each
// root followed by its replies) and filters whole threads by the root's
// resolution state — replies carry no status of their own, they follow the root.
function orderThreads(comments: Comment[], status: "open" | "resolved" | "all"): Comment[] {
  const repliesByRoot = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parentId !== null) {
      const arr = repliesByRoot.get(c.parentId);
      if (arr) arr.push(c);
      else repliesByRoot.set(c.parentId, [c]);
    }
  }
  const out: Comment[] = [];
  for (const root of comments) {
    if (root.parentId !== null) continue;
    const resolved = root.resolvedAt !== null;
    if (status === "open" && resolved) continue;
    if (status === "resolved" && !resolved) continue;
    out.push(root);
    const replies = repliesByRoot.get(root.id);
    if (replies) out.push(...replies);
  }
  return out;
}

// Computes the externally visible status: an "active" row past its expiry is
// already expired even if the cron sweep has not flipped it yet.
const ARTIFACT_SELECT = `
  SELECT a.id, a.title, a.status, a.token_id, a.current_version, a.created_at, a.expires_at,
         CASE WHEN a.status = 'active' AND a.expires_at <= ?1 THEN 'expired' ELSE a.status END AS effective_status,
         (a.passcode_hash IS NOT NULL) AS has_passcode,
         a.comments_enabled,
         a.kind,
         v.content_type, v.size_bytes,
         t.name AS token_name
  FROM artifacts a
  JOIN versions v ON v.artifact_id = a.id AND v.version = a.current_version
  JOIN tokens t ON t.id = a.token_id
`;

export class Store {
  constructor(
    private readonly db: D1Database,
    private readonly blobs: R2Bucket,
  ) {}

  // ---- tokens ----

  async mintToken(name: string): Promise<{ id: string; name: string; token: string; createdAt: string }> {
    const existing = await this.db.prepare("SELECT id FROM tokens WHERE name = ?1").bind(name).first();
    if (existing) throw new StoreError("invalid_request", `Token name "${name}" is already in use.`);
    const id = `tok_${randomId(16)}`;
    const token = `sd_live_${randomId(32)}`;
    const createdAt = isoNow();
    await this.db
      .prepare("INSERT INTO tokens (id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(id, name, await sha256Hex(token), createdAt)
      .run();
    return { id, name, token, createdAt };
  }

  async authenticateToken(secret: string): Promise<TokenRecord | null> {
    const hash = await sha256Hex(secret);
    const row = await this.db
      .prepare("SELECT id, name, created_at, last_used_at, revoked_at FROM tokens WHERE token_hash = ?1 AND revoked_at IS NULL")
      .bind(hash)
      .first<{ id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>();
    if (!row) return null;
    const lastUsedAt = isoNow();
    await this.db.prepare("UPDATE tokens SET last_used_at = ?1 WHERE id = ?2").bind(lastUsedAt, row.id).run();
    return { id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt, revokedAt: null };
  }

  async listTokens(): Promise<TokenRecord[]> {
    const { results } = await this.db
      .prepare("SELECT id, name, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at DESC, id DESC")
      .all<{ id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>();
    return results.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    }));
  }

  async revokeToken(id: string): Promise<{ id: string; revokedAt: string } | null> {
    const row = await this.db
      .prepare("SELECT id, revoked_at FROM tokens WHERE id = ?1")
      .bind(id)
      .first<{ id: string; revoked_at: string | null }>();
    if (!row) return null;
    if (row.revoked_at) return { id, revokedAt: row.revoked_at };
    const revokedAt = isoNow();
    await this.db.prepare("UPDATE tokens SET revoked_at = ?1 WHERE id = ?2").bind(revokedAt, id).run();
    return { id, revokedAt };
  }

  // ---- artifacts ----

  async createArtifact(input: {
    tokenId: string;
    title: string | null;
    ttlSeconds: number;
    contentType: string;
    body: string;
    passcode?: string;
    commentsEnabled?: boolean;
    assets?: UploadAsset[];
    artifactHost?: string;
  }): Promise<Artifact & { unresolvedRefs?: string[] }> {
    if (input.commentsEnabled && input.passcode) {
      throw new StoreError("invalid_request", "Reader comments and a passcode cannot both be enabled on an artifact.");
    }
    const id = randomId(ARTIFACT_ID_LENGTH);
    const now = new Date();
    const createdAt = isoNow(now);
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();

    let passcodeHash: string | null = null;
    let passcodeSalt: string | null = null;
    if (input.passcode) {
      passcodeSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      passcodeHash = await derivePasscodeHash(input.passcode, passcodeSalt);
    }

    const prepared = await this.prepareAssets(id, input.body, input.assets, input.artifactHost, createdAt);

    await this.blobs.put(r2Key(id, 1), prepared.body, { httpMetadata: { contentType: input.contentType } });
    await this.db.batch([
      // `kind` is hard-coded to 'document' here: this is the only artifact-creation
      // path today, and callers cannot choose a different kind.
      this.db
        .prepare(
          "INSERT INTO artifacts (id, title, status, token_id, current_version, created_at, expires_at, passcode_hash, passcode_salt, comments_enabled, kind) VALUES (?1, ?2, 'active', ?3, 1, ?4, ?5, ?6, ?7, ?8, 'document')",
        )
        .bind(id, input.title, input.tokenId, createdAt, expiresAt, passcodeHash, passcodeSalt, input.commentsEnabled ? 1 : 0),
      this.db
        .prepare("INSERT INTO versions (artifact_id, version, r2_key, content_type, size_bytes, created_at) VALUES (?1, 1, ?2, ?3, ?4, ?5)")
        .bind(id, r2Key(id, 1), input.contentType, prepared.sizeBytes, createdAt),
      ...prepared.assetStatements,
    ]);
    const artifact = (await this.fetchArtifact(id))!;
    return input.assets && input.assets.length ? { ...artifact, unresolvedRefs: prepared.unresolvedRefs } : artifact;
  }

  // ---- assets (content-addressed images hosted with an artifact) ----

  // Uploads each image to R2, rewrites the document's local <img src> refs to
  // their hosted URLs, and returns the D1 inserts to fold into the artifact's
  // write batch (so asset rows commit atomically with the version, after the
  // artifact row that they reference). Dedups identical images by content hash.
  private async prepareAssets(
    id: string,
    body: string,
    assets: UploadAsset[] | undefined,
    artifactHost: string | undefined,
    createdAt: string,
  ): Promise<{ body: string; sizeBytes: number; assetStatements: D1PreparedStatement[]; unresolvedRefs: string[] }> {
    if (!assets || assets.length === 0) {
      return { body, sizeBytes: new TextEncoder().encode(body).byteLength, assetStatements: [], unresolvedRefs: [] };
    }

    const refToHash = new Map<string, string>();
    const rows = new Map<string, { contentType: string; sizeBytes: number }>();
    for (const asset of assets) {
      const hash = await sha256HexBytes(asset.bytes);
      await this.blobs.put(assetR2Key(id, hash), asset.bytes, { httpMetadata: { contentType: asset.contentType } });
      refToHash.set(normalizeRef(asset.ref), hash);
      if (!rows.has(hash)) rows.set(hash, { contentType: asset.contentType, sizeBytes: asset.bytes.byteLength });
    }

    const host = artifactHost ?? "";
    const { html, unresolved } = await rewriteImageRefs(body, (ref) => {
      const hash = refToHash.get(ref);
      return hash ? `https://${host}/${id}/a/${hash}` : null;
    });

    const assetStatements = [...rows.entries()].map(([hash, row]) =>
      this.db
        .prepare(
          "INSERT INTO assets (artifact_id, hash, content_type, size_bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(artifact_id, hash) DO NOTHING",
        )
        .bind(id, hash, row.contentType, row.sizeBytes, createdAt),
    );

    return { body: html, sizeBytes: new TextEncoder().encode(html).byteLength, assetStatements, unresolvedRefs: unresolved };
  }

  async listAssets(id: string): Promise<StoredAsset[]> {
    const { results } = await this.db
      .prepare("SELECT hash, content_type, size_bytes, created_at FROM assets WHERE artifact_id = ?1 ORDER BY created_at ASC, hash ASC")
      .bind(id)
      .all<{ hash: string; content_type: string; size_bytes: number; created_at: string }>();
    return results.map((r) => ({ hash: r.hash, contentType: r.content_type, sizeBytes: r.size_bytes, createdAt: r.created_at }));
  }

  // Fetches an asset blob for serving. The caller (serve layer) is responsible
  // for the artifact gate (status/passcode) before calling this.
  async getServableAsset(id: string, hash: string): Promise<{ body: ReadableStream; contentType: string; size: number } | null> {
    const row = await this.db
      .prepare("SELECT content_type FROM assets WHERE artifact_id = ?1 AND hash = ?2")
      .bind(id, hash)
      .first<{ content_type: string }>();
    if (!row) return null;
    const object = await this.blobs.get(assetR2Key(id, hash));
    if (!object) return null;
    return { body: object.body, contentType: row.content_type, size: object.size };
  }

  // ---- passcode access control ----

  // Lightweight routing check for the serving layer: effective status + whether
  // a passcode gate applies, without reading the blob.
  async getArtifactGate(
    id: string,
  ): Promise<{ status: ArtifactStatus; hasPasscode: boolean; commentsEnabled: boolean } | null> {
    const row = await this.db
      .prepare(
        `SELECT CASE WHEN status = 'active' AND expires_at <= ?1 THEN 'expired' ELSE status END AS effective_status,
                passcode_hash, comments_enabled
         FROM artifacts WHERE id = ?2`,
      )
      .bind(isoNow(), id)
      .first<{ effective_status: string; passcode_hash: string | null; comments_enabled: number }>();
    if (!row) return null;
    return {
      status: row.effective_status as ArtifactStatus,
      hasPasscode: row.passcode_hash !== null,
      commentsEnabled: !!row.comments_enabled,
    };
  }

  async verifyPasscode(id: string, passcode: string): Promise<boolean> {
    const row = await this.fetchPasscode(id);
    if (!row) return false;
    const candidate = await derivePasscodeHash(passcode, row.salt);
    return constantTimeEqual(candidate, row.hash);
  }

  // Token to store in the viewer's cookie after a correct unlock.
  async viewerToken(id: string): Promise<string | null> {
    const row = await this.fetchPasscode(id);
    if (!row) return null;
    return deriveViewerToken(row.hash, id);
  }

  async checkViewerToken(id: string, token: string): Promise<boolean> {
    const expected = await this.viewerToken(id);
    if (!expected) return false;
    return constantTimeEqual(expected, token);
  }

  private async fetchPasscode(id: string): Promise<{ hash: string; salt: string } | null> {
    const row = await this.db
      .prepare("SELECT passcode_hash, passcode_salt FROM artifacts WHERE id = ?1")
      .bind(id)
      .first<{ passcode_hash: string | null; passcode_salt: string | null }>();
    if (!row || row.passcode_hash === null || row.passcode_salt === null) return null;
    return { hash: row.passcode_hash, salt: row.passcode_salt };
  }

  async addVersion(
    id: string,
    input: {
      title?: string | null;
      ttlSeconds?: number;
      defaultTtlSeconds: number;
      contentType: string;
      body: string;
      commentsEnabled?: boolean;
      assets?: UploadAsset[];
      artifactHost?: string;
    },
  ): Promise<Artifact & { unresolvedRefs?: string[] }> {
    const current = await this.fetchArtifact(id);
    if (!current) throw new StoreError("not_found", "Artifact not found.");
    if (current.status === "deleted") throw new StoreError("not_active", "Artifact has been deleted.");

    // A new version may flip the comment opt-in; unspecified keeps the current
    // setting. Reader comments and a passcode remain mutually exclusive.
    const commentsEnabled = input.commentsEnabled ?? current.commentsEnabled;
    if (commentsEnabled && current.hasPasscode) {
      throw new StoreError("invalid_request", "Reader comments and a passcode cannot both be enabled on an artifact.");
    }

    const now = new Date();
    const createdAt = isoNow(now);
    const version = current.currentVersion + 1;

    let expiresAt = current.expiresAt;
    if (input.ttlSeconds !== undefined) {
      expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    } else if (current.status === "expired") {
      // Reactivation without an explicit TTL gets the default window from now.
      expiresAt = new Date(now.getTime() + input.defaultTtlSeconds * 1000).toISOString();
    }
    const title = input.title !== undefined && input.title !== null ? input.title : current.title;

    const prepared = await this.prepareAssets(id, input.body, input.assets, input.artifactHost, createdAt);

    await this.blobs.put(r2Key(id, version), prepared.body, { httpMetadata: { contentType: input.contentType } });
    await this.db.batch([
      this.db
        .prepare("INSERT INTO versions (artifact_id, version, r2_key, content_type, size_bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(id, version, r2Key(id, version), input.contentType, prepared.sizeBytes, createdAt),
      this.db
        .prepare("UPDATE artifacts SET status = 'active', current_version = ?1, expires_at = ?2, title = ?3, comments_enabled = ?4, blobs_purged_at = NULL WHERE id = ?5")
        .bind(version, expiresAt, title, commentsEnabled ? 1 : 0, id),
      ...prepared.assetStatements,
    ]);
    const artifact = (await this.fetchArtifact(id))!;
    return input.assets && input.assets.length ? { ...artifact, unresolvedRefs: prepared.unresolvedRefs } : artifact;
  }

  async getArtifact(id: string): Promise<{ artifact: Artifact; versions: ArtifactVersion[] } | null> {
    const artifact = await this.fetchArtifact(id);
    if (!artifact) return null;
    const { results } = await this.db
      .prepare("SELECT version, content_type, size_bytes, created_at FROM versions WHERE artifact_id = ?1 ORDER BY version ASC")
      .bind(id)
      .all<{ version: number; content_type: string; size_bytes: number; created_at: string }>();
    return {
      artifact,
      // Document artifacts are the only kind create/add-version can produce
      // today, so every version row maps to "document".
      versions: results.map((v) => ({
        version: v.version,
        contentType: v.content_type,
        sizeBytes: v.size_bytes,
        createdAt: v.created_at,
        kind: "document" as const,
      })),
    };
  }

  async listArtifacts(opts: {
    tokenId?: string;
    status?: ArtifactStatus;
    limit: number;
    cursor?: string;
  }): Promise<{ artifacts: Artifact[]; nextCursor: string | null }> {
    const now = isoNow();
    const where: string[] = [];
    const params: unknown[] = [now];
    if (opts.tokenId) {
      params.push(opts.tokenId);
      where.push(`a.token_id = ?${params.length}`);
    }
    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      params.push(decoded.createdAt, decoded.id);
      where.push(`(a.created_at, a.id) < (?${params.length - 1}, ?${params.length})`);
    }
    let sql = ARTIFACT_SELECT;
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY a.created_at DESC, a.id DESC";

    // Status filters on the computed effective status, so wrap.
    if (opts.status) {
      params.push(opts.status);
      sql = `SELECT * FROM (${sql}) WHERE effective_status = ?${params.length}`;
    }
    params.push(opts.limit + 1);
    sql += ` LIMIT ?${params.length}`;

    const { results } = await this.db.prepare(sql).bind(...params).all<ArtifactRow>();
    const page = results.slice(0, opts.limit);
    const nextCursor =
      results.length > opts.limit && page.length > 0
        ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
        : null;
    return { artifacts: page.map(rowToArtifact), nextCursor };
  }

  async expireArtifact(id: string): Promise<Artifact> {
    const current = await this.fetchArtifact(id);
    if (!current) throw new StoreError("not_found", "Artifact not found.");
    if (current.status === "deleted") throw new StoreError("not_active", "Artifact has been deleted.");
    if (current.status === "expired") {
      // Idempotent: make sure the row status matches the effective status.
      await this.db.prepare("UPDATE artifacts SET status = 'expired' WHERE id = ?1").bind(id).run();
      return (await this.fetchArtifact(id))!;
    }
    const now = isoNow();
    await this.db.prepare("UPDATE artifacts SET status = 'expired', expires_at = ?1 WHERE id = ?2").bind(now, id).run();
    return (await this.fetchArtifact(id))!;
  }

  // Owner opt-in toggle for the anonymous reader-comment path. Enabling is
  // refused on a passcode-protected artifact (the review page's sandboxed iframe
  // cannot complete the unlock flow, so the two features are mutually exclusive).
  async setCommentsEnabled(id: string, enabled: boolean): Promise<Artifact> {
    const current = await this.fetchArtifact(id);
    if (!current) throw new StoreError("not_found", "Artifact not found.");
    if (current.status === "deleted") throw new StoreError("not_active", "Artifact has been deleted.");
    if (enabled && current.hasPasscode) {
      throw new StoreError("invalid_request", "Reader comments and a passcode cannot both be enabled on an artifact.");
    }
    await this.db.prepare("UPDATE artifacts SET comments_enabled = ?1 WHERE id = ?2").bind(enabled ? 1 : 0, id).run();
    return (await this.fetchArtifact(id))!;
  }

  async deleteArtifact(id: string): Promise<{ id: string; status: "deleted" }> {
    const current = await this.fetchArtifact(id);
    if (!current) throw new StoreError("not_found", "Artifact not found.");
    if (current.status === "deleted") return { id, status: "deleted" };
    await this.purgeBlobs(id);
    await this.db
      .prepare("UPDATE artifacts SET status = 'deleted', blobs_purged_at = ?1 WHERE id = ?2")
      .bind(isoNow(), id)
      .run();
    return { id, status: "deleted" };
  }

  async getServableContent(id: string, version?: number): Promise<ServableContent | null> {
    const artifact = await this.fetchArtifact(id);
    if (!artifact) return null;
    if (artifact.status === "expired") return { state: "expired" };
    if (artifact.status === "deleted") return { state: "deleted" };
    const v = version ?? artifact.currentVersion;
    const row = await this.db
      .prepare("SELECT r2_key, content_type FROM versions WHERE artifact_id = ?1 AND version = ?2")
      .bind(id, v)
      .first<{ r2_key: string; content_type: string }>();
    if (!row) return null;
    const object = await this.blobs.get(row.r2_key);
    if (!object) return null;
    return { state: "active", html: await object.text(), contentType: row.content_type, version: v };
  }

  // ---- comments ----
  // Two channels share this table: team threads authored via Access (author_kind
  // 'access', read by agents) and reader threads authored anonymously through the
  // public review page (author_kind 'anon', text-anchored). A reply always
  // matches its root's kind, so the channels never interleave.

  async addComment(
    artifactId: string,
    input: {
      author: string;
      authorKind?: "access" | "anon";
      authorEmail?: string | null;
      body: string;
      parentId?: string | null;
      anchor?: Anchor | null;
      viewerId?: string | null;
    },
  ): Promise<Comment> {
    const current = await this.fetchArtifact(artifactId);
    if (!current) throw new StoreError("not_found", "Artifact not found.");
    if (current.status === "deleted") throw new StoreError("not_active", "Artifact has been deleted.");
    const authorKind = input.authorKind ?? "access";
    const authorEmail = input.authorEmail ?? null;
    const anchor = input.anchor ?? null;
    const viewerId = input.viewerId ?? null;
    let parentId: string | null = null;
    if (input.parentId) {
      const parent = await this.db
        .prepare("SELECT id, artifact_id, parent_id, author_kind FROM comments WHERE id = ?1 AND deleted_at IS NULL")
        .bind(input.parentId)
        .first<{ id: string; artifact_id: string; parent_id: string | null; author_kind: string }>();
      // Same message for a missing parent and a cross-kind one, so a reader
      // client can neither reach nor probe for team threads.
      if (!parent || parent.artifact_id !== artifactId || parent.author_kind !== authorKind) {
        throw new StoreError("invalid_request", "Parent comment not found on this artifact.");
      }
      // Re-root: a reply always hangs off the thread root, never another reply.
      parentId = parent.parent_id ?? parent.id;
    }
    const id = `cmt_${randomId(16)}`;
    const createdAt = isoNow();
    const version = current.currentVersion;
    await this.db
      .prepare(
        `INSERT INTO comments
           (id, artifact_id, version, author, body, created_at, parent_id,
            author_kind, author_email, viewer_id,
            anchor_exact, anchor_prefix, anchor_suffix, anchor_start, anchor_end)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        id, artifactId, version, input.author, input.body, createdAt, parentId,
        authorKind, authorEmail, viewerId,
        anchor?.exact ?? null, anchor?.prefix ?? null, anchor?.suffix ?? null,
        anchor?.start ?? null, anchor?.end ?? null,
      )
      .run();
    return {
      id, artifactId, version,
      author: input.author, body: input.body, createdAt, parentId,
      resolvedAt: null, resolvedBy: null,
      authorKind, authorEmail, anchor, viewerId,
    };
  }

  async listComments(
    artifactId: string,
    status: "open" | "resolved" | "all" = "all",
  ): Promise<{ comments: Comment[]; truncated: boolean }> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM comments
         WHERE artifact_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at ASC, rowid ASC LIMIT ?2`,
      )
      .bind(artifactId, COMMENTS_LIMIT + 1)
      .all<CommentRow>();
    const truncated = results.length > COMMENTS_LIMIT;
    const page = (truncated ? results.slice(0, COMMENTS_LIMIT) : results).map(rowToComment);
    return { comments: orderThreads(page, status), truncated };
  }

  // Public-rail read: anonymous (reader) comments only, so team/Access threads
  // are never exposed to anyone-with-the-link.
  async listReaderComments(
    artifactId: string,
    status: "open" | "resolved" | "all" = "all",
  ): Promise<{ comments: Comment[]; truncated: boolean }> {
    const { results } = await this.db
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM comments
         WHERE artifact_id = ?1 AND author_kind = 'anon' AND deleted_at IS NULL
         ORDER BY created_at ASC, rowid ASC LIMIT ?2`,
      )
      .bind(artifactId, COMMENTS_LIMIT + 1)
      .all<CommentRow>();
    const truncated = results.length > COMMENTS_LIMIT;
    const page = (truncated ? results.slice(0, COMMENTS_LIMIT) : results).map(rowToComment);
    return { comments: orderThreads(page, status), truncated };
  }

  // Session self-delete for a reader: only the anon author (proven by the
  // viewer_id from their cookie) may remove their own comment. Cascades to
  // replies like a team root delete. Any mismatch reads as "not found".
  async deleteReaderComment(commentId: string, viewerId: string): Promise<{ id: string; deletedAt: string } | null> {
    const row = await this.db
      .prepare("SELECT id, parent_id, deleted_at, viewer_id FROM comments WHERE id = ?1 AND author_kind = 'anon'")
      .bind(commentId)
      .first<{ id: string; parent_id: string | null; deleted_at: string | null; viewer_id: string | null }>();
    if (!row || row.viewer_id === null || !constantTimeEqual(row.viewer_id, viewerId)) return null;
    if (row.deleted_at) return { id: row.id, deletedAt: row.deleted_at };
    const deletedAt = isoNow();
    if (row.parent_id === null) {
      await this.db
        .prepare("UPDATE comments SET deleted_at = ?1 WHERE (id = ?2 OR parent_id = ?2) AND deleted_at IS NULL")
        .bind(deletedAt, commentId)
        .run();
    } else {
      await this.db.prepare("UPDATE comments SET deleted_at = ?1 WHERE id = ?2").bind(deletedAt, commentId).run();
    }
    return { id: commentId, deletedAt };
  }

  async deleteComment(commentId: string): Promise<{ id: string; deletedAt: string } | null> {
    const row = await this.db
      .prepare("SELECT id, parent_id, deleted_at FROM comments WHERE id = ?1")
      .bind(commentId)
      .first<{ id: string; parent_id: string | null; deleted_at: string | null }>();
    if (!row) return null;
    if (row.deleted_at) return { id: row.id, deletedAt: row.deleted_at };
    const deletedAt = isoNow();
    if (row.parent_id === null) {
      // Deleting a root cascades to the whole thread (root + its live replies).
      await this.db
        .prepare("UPDATE comments SET deleted_at = ?1 WHERE (id = ?2 OR parent_id = ?2) AND deleted_at IS NULL")
        .bind(deletedAt, commentId)
        .run();
    } else {
      await this.db.prepare("UPDATE comments SET deleted_at = ?1 WHERE id = ?2").bind(deletedAt, commentId).run();
    }
    return { id: commentId, deletedAt };
  }

  async setCommentResolved(commentId: string, resolved: boolean, resolvedBy: string): Promise<Comment | null> {
    const row = await this.db
      .prepare("SELECT id, parent_id FROM comments WHERE id = ?1 AND deleted_at IS NULL")
      .bind(commentId)
      .first<{ id: string; parent_id: string | null }>();
    if (!row) return null;
    // Re-root: resolution is a thread property, recorded on the root.
    const rootId = row.parent_id ?? row.id;
    if (resolved) {
      // Idempotent: keep the first resolver + timestamp if already resolved.
      await this.db
        .prepare("UPDATE comments SET resolved_at = ?1, resolved_by = ?2 WHERE id = ?3 AND resolved_at IS NULL")
        .bind(isoNow(), resolvedBy, rootId)
        .run();
    } else {
      await this.db.prepare("UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ?1").bind(rootId).run();
    }
    return this.fetchComment(rootId);
  }

  // ---- rate limiting (sliding one-hour window over publish events) ----

  async recordPublish(tokenId: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO publish_events (token_id, created_at) VALUES (?1, ?2)")
      .bind(tokenId, isoNow())
      .run();
  }

  async checkRateLimit(tokenId: string, limitPerHour: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 3600_000).toISOString();
    const { results } = await this.db
      .prepare("SELECT created_at FROM publish_events WHERE token_id = ?1 AND created_at > ?2 ORDER BY created_at ASC")
      .bind(tokenId, windowStart)
      .all<{ created_at: string }>();
    if (results.length < limitPerHour) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = new Date(results[0].created_at).getTime();
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + 3600_000 - now.getTime()) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  async recordCommentEvent(ipHash: string, artifactId: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO comment_events (ip_hash, artifact_id, created_at) VALUES (?1, ?2, ?3)")
      .bind(ipHash, artifactId, isoNow())
      .run();
  }

  // Two independent sliding-hour windows guard the anonymous write path: a
  // per-IP cap (throttles one abuser) and a per-artifact cap (backstops IP
  // rotation on a single leaked link). Mirrors checkRateLimit's shape.
  async checkCommentRateLimit(
    ipHash: string,
    artifactId: string,
    perIp: number,
    perArtifact: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number; scope?: "ip" | "artifact" }> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 3600_000).toISOString();
    const retryAfter = (oldestIso: string): number =>
      Math.max(1, Math.ceil((new Date(oldestIso).getTime() + 3600_000 - now.getTime()) / 1000));

    const ip = await this.db
      .prepare("SELECT created_at FROM comment_events WHERE ip_hash = ?1 AND created_at > ?2 ORDER BY created_at ASC")
      .bind(ipHash, windowStart)
      .all<{ created_at: string }>();
    if (ip.results.length >= perIp) {
      return { allowed: false, retryAfterSeconds: retryAfter(ip.results[0].created_at), scope: "ip" };
    }

    const artifact = await this.db
      .prepare("SELECT created_at FROM comment_events WHERE artifact_id = ?1 AND created_at > ?2 ORDER BY created_at ASC")
      .bind(artifactId, windowStart)
      .all<{ created_at: string }>();
    if (artifact.results.length >= perArtifact) {
      return { allowed: false, retryAfterSeconds: retryAfter(artifact.results[0].created_at), scope: "artifact" };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  // ---- scheduled cleanup ----

  async cleanupExpired(now = new Date()): Promise<{ markedExpired: number; blobsPurged: number }> {
    const nowIso = isoNow(now);
    const marked = await this.db
      .prepare("UPDATE artifacts SET status = 'expired' WHERE status = 'active' AND expires_at <= ?1")
      .bind(nowIso)
      .run();

    const retentionCutoff = new Date(now.getTime() - EXPIRED_BLOB_RETENTION_SECONDS * 1000).toISOString();
    const { results } = await this.db
      .prepare(
        `SELECT id FROM artifacts
         WHERE blobs_purged_at IS NULL
           AND (status = 'deleted' OR (status = 'expired' AND expires_at <= ?1))`,
      )
      .bind(retentionCutoff)
      .all<{ id: string }>();
    for (const row of results) {
      await this.purgeBlobs(row.id);
      await this.db.prepare("UPDATE artifacts SET blobs_purged_at = ?1 WHERE id = ?2").bind(nowIso, row.id).run();
    }

    // Drop rate-limit events older than the sliding one-hour window.
    const rateLimitCutoff = new Date(now.getTime() - 3600_000).toISOString();
    await this.db.prepare("DELETE FROM publish_events WHERE created_at <= ?1").bind(rateLimitCutoff).run();
    await this.db.prepare("DELETE FROM comment_events WHERE created_at <= ?1").bind(rateLimitCutoff).run();

    return { markedExpired: marked.meta.changes ?? 0, blobsPurged: results.length };
  }

  // ---- internals ----

  private async fetchArtifact(id: string): Promise<Artifact | null> {
    const row = await this.db
      .prepare(`${ARTIFACT_SELECT} WHERE a.id = ?2`)
      .bind(isoNow(), id)
      .first<ArtifactRow>();
    return row ? rowToArtifact(row) : null;
  }

  private async fetchComment(id: string): Promise<Comment | null> {
    const row = await this.db
      .prepare(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE id = ?1`)
      .bind(id)
      .first<CommentRow>();
    return row ? rowToComment(row) : null;
  }

  private async purgeBlobs(id: string): Promise<void> {
    const versions = await this.db
      .prepare("SELECT r2_key FROM versions WHERE artifact_id = ?1")
      .bind(id)
      .all<{ r2_key: string }>();
    const assets = await this.db
      .prepare("SELECT hash FROM assets WHERE artifact_id = ?1")
      .bind(id)
      .all<{ hash: string }>();
    const keys = [...versions.results.map((r) => r.r2_key), ...assets.results.map((a) => assetR2Key(id, a.hash))];
    if (keys.length) await this.blobs.delete(keys);
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify([createdAt, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const [createdAt, id] = JSON.parse(atob(padded)) as [string, string];
    if (typeof createdAt !== "string" || typeof id !== "string") throw new Error("bad cursor");
    return { createdAt, id };
  } catch {
    throw new StoreError("invalid_request", "Invalid pagination cursor.");
  }
}

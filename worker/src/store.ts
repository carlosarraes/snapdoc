// Deep module owning all R2 + D1 access and artifact/token lifecycle rules.
// No raw SQL should exist outside this file.

export type ArtifactStatus = "active" | "expired" | "deleted";

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
}

export interface ArtifactVersion {
  version: number;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface Comment {
  id: string;
  artifactId: string;
  version: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface TokenRecord {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type ServableContent =
  | { state: "active"; html: string; contentType: string }
  | { state: "expired" }
  | { state: "deleted" };

export type StoreErrorCode = "not_found" | "not_active" | "invalid_request";

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
  };
  if (row.token_name !== undefined) artifact.tokenName = row.token_name;
  return artifact;
}

// Computes the externally visible status: an "active" row past its expiry is
// already expired even if the cron sweep has not flipped it yet.
const ARTIFACT_SELECT = `
  SELECT a.id, a.title, a.status, a.token_id, a.current_version, a.created_at, a.expires_at,
         CASE WHEN a.status = 'active' AND a.expires_at <= ?1 THEN 'expired' ELSE a.status END AS effective_status,
         (a.passcode_hash IS NOT NULL) AS has_passcode,
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
  }): Promise<Artifact> {
    const id = randomId(ARTIFACT_ID_LENGTH);
    const now = new Date();
    const createdAt = isoNow(now);
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    const sizeBytes = new TextEncoder().encode(input.body).byteLength;

    let passcodeHash: string | null = null;
    let passcodeSalt: string | null = null;
    if (input.passcode) {
      passcodeSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      passcodeHash = await derivePasscodeHash(input.passcode, passcodeSalt);
    }

    await this.blobs.put(r2Key(id, 1), input.body, { httpMetadata: { contentType: input.contentType } });
    await this.db.batch([
      this.db
        .prepare("INSERT INTO artifacts (id, title, status, token_id, current_version, created_at, expires_at, passcode_hash, passcode_salt) VALUES (?1, ?2, 'active', ?3, 1, ?4, ?5, ?6, ?7)")
        .bind(id, input.title, input.tokenId, createdAt, expiresAt, passcodeHash, passcodeSalt),
      this.db
        .prepare("INSERT INTO versions (artifact_id, version, r2_key, content_type, size_bytes, created_at) VALUES (?1, 1, ?2, ?3, ?4, ?5)")
        .bind(id, r2Key(id, 1), input.contentType, sizeBytes, createdAt),
    ]);
    return (await this.fetchArtifact(id))!;
  }

  // ---- passcode access control ----

  // Lightweight routing check for the serving layer: effective status + whether
  // a passcode gate applies, without reading the blob.
  async getArtifactGate(id: string): Promise<{ status: ArtifactStatus; hasPasscode: boolean } | null> {
    const row = await this.db
      .prepare(
        `SELECT CASE WHEN status = 'active' AND expires_at <= ?1 THEN 'expired' ELSE status END AS effective_status,
                passcode_hash
         FROM artifacts WHERE id = ?2`,
      )
      .bind(isoNow(), id)
      .first<{ effective_status: string; passcode_hash: string | null }>();
    if (!row) return null;
    return { status: row.effective_status as ArtifactStatus, hasPasscode: row.passcode_hash !== null };
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
    input: { title?: string | null; ttlSeconds?: number; defaultTtlSeconds: number; contentType: string; body: string },
  ): Promise<Artifact> {
    const current = await this.fetchArtifact(id);
    if (!current) throw new StoreError("not_found", "Artifact not found.");
    if (current.status === "deleted") throw new StoreError("not_active", "Artifact has been deleted.");

    const now = new Date();
    const createdAt = isoNow(now);
    const version = current.currentVersion + 1;
    const sizeBytes = new TextEncoder().encode(input.body).byteLength;

    let expiresAt = current.expiresAt;
    if (input.ttlSeconds !== undefined) {
      expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    } else if (current.status === "expired") {
      // Reactivation without an explicit TTL gets the default window from now.
      expiresAt = new Date(now.getTime() + input.defaultTtlSeconds * 1000).toISOString();
    }
    const title = input.title !== undefined && input.title !== null ? input.title : current.title;

    await this.blobs.put(r2Key(id, version), input.body, { httpMetadata: { contentType: input.contentType } });
    await this.db.batch([
      this.db
        .prepare("INSERT INTO versions (artifact_id, version, r2_key, content_type, size_bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(id, version, r2Key(id, version), input.contentType, sizeBytes, createdAt),
      this.db
        .prepare("UPDATE artifacts SET status = 'active', current_version = ?1, expires_at = ?2, title = ?3, blobs_purged_at = NULL WHERE id = ?4")
        .bind(version, expiresAt, title, id),
    ]);
    return (await this.fetchArtifact(id))!;
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
      versions: results.map((v) => ({
        version: v.version,
        contentType: v.content_type,
        sizeBytes: v.size_bytes,
        createdAt: v.created_at,
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
    return { state: "active", html: await object.text(), contentType: row.content_type };
  }

  // ---- comments (doc-level threads; authored by team via Access, read by agents) ----

  async addComment(artifactId: string, input: { author: string; body: string }): Promise<Comment> {
    const current = await this.fetchArtifact(artifactId);
    if (!current) throw new StoreError("not_found", "Artifact not found.");
    if (current.status === "deleted") throw new StoreError("not_active", "Artifact has been deleted.");
    const id = `cmt_${randomId(16)}`;
    const createdAt = isoNow();
    const version = current.currentVersion;
    await this.db
      .prepare("INSERT INTO comments (id, artifact_id, version, author, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(id, artifactId, version, input.author, input.body, createdAt)
      .run();
    return { id, artifactId, version, author: input.author, body: input.body, createdAt };
  }

  async listComments(artifactId: string): Promise<{ comments: Comment[]; truncated: boolean }> {
    const { results } = await this.db
      .prepare(
        `SELECT id, artifact_id, version, author, body, created_at FROM comments
         WHERE artifact_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at ASC, rowid ASC LIMIT ?2`,
      )
      .bind(artifactId, COMMENTS_LIMIT + 1)
      .all<{ id: string; artifact_id: string; version: number; author: string; body: string; created_at: string }>();
    const truncated = results.length > COMMENTS_LIMIT;
    const page = truncated ? results.slice(0, COMMENTS_LIMIT) : results;
    return {
      comments: page.map((r) => ({
        id: r.id,
        artifactId: r.artifact_id,
        version: r.version,
        author: r.author,
        body: r.body,
        createdAt: r.created_at,
      })),
      truncated,
    };
  }

  async deleteComment(commentId: string): Promise<{ id: string; deletedAt: string } | null> {
    const row = await this.db
      .prepare("SELECT id, deleted_at FROM comments WHERE id = ?1")
      .bind(commentId)
      .first<{ id: string; deleted_at: string | null }>();
    if (!row) return null;
    if (row.deleted_at) return { id: row.id, deletedAt: row.deleted_at };
    const deletedAt = isoNow();
    await this.db.prepare("UPDATE comments SET deleted_at = ?1 WHERE id = ?2").bind(deletedAt, commentId).run();
    return { id: commentId, deletedAt };
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

    // Drop publish events older than the rate-limit window.
    await this.db
      .prepare("DELETE FROM publish_events WHERE created_at <= ?1")
      .bind(new Date(now.getTime() - 3600_000).toISOString())
      .run();

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

  private async purgeBlobs(id: string): Promise<void> {
    const { results } = await this.db
      .prepare("SELECT r2_key FROM versions WHERE artifact_id = ?1")
      .bind(id)
      .all<{ r2_key: string }>();
    if (results.length) await this.blobs.delete(results.map((r) => r.r2_key));
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

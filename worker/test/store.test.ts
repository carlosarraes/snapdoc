import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { detectPosterImageType } from "../src/assets";
import { Store, StoreError, type CreateVideoInput } from "../src/store";
import { sanitizeVideoFilename } from "../src/video";
import { JPEG_BYTES, PNG_BYTES } from "./helpers";

const HTML = "<!doctype html><html><body>hi</body></html>";
const DAY = 86400;

function makeStore() {
  return new Store(env.DB, env.BLOBS);
}

// The workers pool runtime has no filesystem access, so binary test fixtures
// are base64-encoded in vitest.config.ts and handed over as env bindings (see
// test/video.test.ts for the same pattern).
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type VideoFixtureName = "video-h264-aac.mp4" | "video-h264-silent.mp4";

function fixtureBytes(name: VideoFixtureName): Uint8Array {
  switch (name) {
    case "video-h264-aac.mp4":
      return decodeBase64(env.FIXTURE_VIDEO_H264_AAC_B64);
    case "video-h264-silent.mp4":
      return decodeBase64(env.FIXTURE_VIDEO_H264_SILENT_B64);
  }
}

function streamOf(bytes: Uint8Array): ReadableStream {
  return new Blob([bytes]).stream();
}

// A declared-length, chunked zero-filled stream for exercising the upload
// size cap without materializing 100+ MB in a single in-memory buffer. R2's
// `put()` requires a stream with a known length (same constraint a real
// Content-Length-bearing request body satisfies), which a plain generator
// ReadableStream does not have — FixedLengthStream is the runtime primitive
// that provides one while still writing incrementally.
function fixedLengthStream(totalBytes: number): ReadableStream {
  const { readable, writable } = new FixedLengthStream(totalBytes);
  const writer = writable.getWriter();
  const CHUNK = 1024 * 1024;
  void (async () => {
    let sent = 0;
    while (sent < totalBytes) {
      const size = Math.min(CHUNK, totalBytes - sent);
      await writer.write(new Uint8Array(size));
      sent += size;
    }
    await writer.close();
  })();
  return readable;
}

const VIDEO_MAX_DURATION_MS = 600_000;

async function makeVideoArtifact(
  store: Store,
  tokenId: string,
  overrides: Partial<CreateVideoInput> & { bytes?: Uint8Array } = {},
) {
  const bytes = overrides.bytes ?? fixtureBytes("video-h264-aac.mp4");
  const { bytes: _ignored, ...rest } = overrides;
  return store.createVideoArtifact({
    tokenId,
    title: "clip",
    ttlSeconds: 3 * DAY,
    filename: "clip.mp4",
    contentLength: bytes.byteLength,
    maxDurationMs: VIDEO_MAX_DURATION_MS,
    body: streamOf(bytes),
    ...rest,
  });
}

async function makeToken(store: Store, name = `tok-${crypto.randomUUID()}`) {
  return store.mintToken(name);
}

async function makeArtifact(store: Store, tokenId: string, opts: { title?: string; ttlSeconds?: number } = {}) {
  return store.createArtifact({
    tokenId,
    title: opts.title ?? "t",
    ttlSeconds: opts.ttlSeconds ?? 14 * DAY,
    contentType: "text/html",
    body: HTML,
  });
}

describe("tokens", () => {
  it("mints a token and authenticates with the secret", async () => {
    const store = makeStore();
    const minted = await makeToken(store, "laptop");
    expect(minted.token).toMatch(/^sd_live_[A-Za-z0-9_-]+$/);
    expect(minted.id).toMatch(/^tok_/);
    const auth = await store.authenticateToken(minted.token);
    expect(auth?.id).toBe(minted.id);
    expect(auth?.name).toBe("laptop");
  });

  it("rejects duplicate token names", async () => {
    const store = makeStore();
    await makeToken(store, "dup");
    await expect(makeToken(store, "dup")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("updates last_used_at on authentication", async () => {
    const store = makeStore();
    const minted = await makeToken(store);
    await store.authenticateToken(minted.token);
    const tokens = await store.listTokens();
    const row = tokens.find((t) => t.id === minted.id);
    expect(row?.lastUsedAt).toBeTruthy();
  });

  it("revoked tokens no longer authenticate; revoke is idempotent", async () => {
    const store = makeStore();
    const minted = await makeToken(store);
    const first = await store.revokeToken(minted.id);
    expect(first?.revokedAt).toBeTruthy();
    const second = await store.revokeToken(minted.id);
    expect(second?.revokedAt).toBe(first?.revokedAt);
    expect(await store.authenticateToken(minted.token)).toBeNull();
  });

  it("revoking an unknown token id returns null", async () => {
    const store = makeStore();
    expect(await store.revokeToken("tok_nope")).toBeNull();
  });

  it("rejects unknown secrets", async () => {
    const store = makeStore();
    expect(await store.authenticateToken("sd_live_bogus")).toBeNull();
  });
});

describe("artifact lifecycle", () => {
  it("create stores v1 and content is servable", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id, { title: "Plan" });
    expect(art.id).toMatch(/^[A-Za-z0-9_-]{14}$/);
    expect(art.status).toBe("active");
    expect(art.currentVersion).toBe(1);
    expect(art.title).toBe("Plan");
    expect(art.contentType).toBe("text/html");
    expect(art.sizeBytes).toBe(HTML.length);
    expect(art.kind).toBe("document");

    const content = await store.getServableContent(art.id);
    expect(content).toMatchObject({ state: "active" });
    if (content?.state === "active") expect(content.html).toBe(HTML);
  });

  it("addVersion creates v2 at the same id and serves the new content", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const v2 = await store.addVersion(art.id, { contentType: "text/html", body: "<p>v2</p>", defaultTtlSeconds: 14 * DAY });
    expect(v2.id).toBe(art.id);
    expect(v2.currentVersion).toBe(2);
    const content = await store.getServableContent(art.id);
    if (content?.state === "active") expect(content.html).toBe("<p>v2</p>");
  });

  it("version-pinned reads return the intended version", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    await store.addVersion(art.id, { contentType: "text/html", body: "<p>v2</p>", defaultTtlSeconds: 14 * DAY });
    const v1 = await store.getServableContent(art.id, 1);
    if (v1?.state === "active") expect(v1.html).toBe(HTML);
    expect(await store.getServableContent(art.id, 3)).toBeNull();
  });

  it("getArtifact returns metadata plus version list", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    await store.addVersion(art.id, { contentType: "text/html", body: "<p>v2</p>", defaultTtlSeconds: 14 * DAY });
    const got = await store.getArtifact(art.id);
    expect(got?.artifact.currentVersion).toBe(2);
    expect(got?.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(got?.versions[1].sizeBytes).toBe("<p>v2</p>".length);
    expect(got?.versions[0].kind).toBe("document");
  });

  it("addVersion on unknown id throws not_found; on deleted throws not_active", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    await expect(
      store.addVersion("AAAAAAAAAAAAAA", { contentType: "text/html", body: "x", defaultTtlSeconds: DAY }),
    ).rejects.toMatchObject({ code: "not_found" });
    const art = await makeArtifact(store, tok.id);
    await store.deleteArtifact(art.id);
    await expect(
      store.addVersion(art.id, { contentType: "text/html", body: "x", defaultTtlSeconds: DAY }),
    ).rejects.toMatchObject({ code: "not_active" });
  });

  it("updating an expired artifact reactivates it", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id, { ttlSeconds: -3600 });
    expect((await store.getArtifact(art.id))?.artifact.status).toBe("expired");
    const updated = await store.addVersion(art.id, { contentType: "text/html", body: "<p>back</p>", defaultTtlSeconds: 14 * DAY });
    expect(updated.status).toBe("active");
    expect(new Date(updated.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const content = await store.getServableContent(art.id);
    expect(content?.state).toBe("active");
  });

  it("expire is idempotent and deletion wins over expire", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const once = await store.expireArtifact(art.id);
    expect(once.status).toBe("expired");
    const twice = await store.expireArtifact(art.id);
    expect(twice.status).toBe("expired");
    await store.deleteArtifact(art.id);
    await expect(store.expireArtifact(art.id)).rejects.toMatchObject({ code: "not_active" });
    await expect(store.expireArtifact("AAAAAAAAAAAAAA")).rejects.toMatchObject({ code: "not_found" });
  });

  it("delete is idempotent, removes blobs, and tombstones metadata", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const res = await store.deleteArtifact(art.id);
    expect(res).toEqual({ id: art.id, status: "deleted" });
    expect(await store.deleteArtifact(art.id)).toEqual({ id: art.id, status: "deleted" });
    expect(await env.BLOBS.get(`artifacts/${art.id}/v1`)).toBeNull();
    expect((await store.getServableContent(art.id))?.state).toBe("deleted");
    await expect(store.deleteArtifact("AAAAAAAAAAAAAA")).rejects.toMatchObject({ code: "not_found" });
  });

  it("expired artifacts report expired servable state", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id, { ttlSeconds: -60 });
    expect((await store.getServableContent(art.id))?.state).toBe("expired");
  });

  it("missing artifacts are null", async () => {
    const store = makeStore();
    expect(await store.getServableContent("AAAAAAAAAAAAAA")).toBeNull();
    expect(await store.getArtifact("AAAAAAAAAAAAAA")).toBeNull();
  });
});

describe("artifact kind schema", () => {
  it("accepts a video metadata child row keyed to an existing version", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    await env.DB.prepare(
      `INSERT INTO video_versions
         (artifact_id, version, filename, duration_ms, width, height, video_codec, audio_codec)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(art.id, art.currentVersion, "clip.mp4", 12_000, 1920, 1080, "h264", "aac")
      .run();
    const row = await env.DB.prepare("SELECT filename FROM video_versions WHERE artifact_id = ?1 AND version = ?2")
      .bind(art.id, art.currentVersion)
      .first<{ filename: string }>();
    expect(row?.filename).toBe("clip.mp4");
  });

  it("rejects an unknown artifact kind", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    await expect(
      env.DB.prepare(
        "INSERT INTO artifacts (id, title, status, token_id, current_version, created_at, expires_at, kind) VALUES (?1, ?2, 'active', ?3, 1, ?4, ?5, ?6)",
      )
        .bind("AAAAAAAAAAAAAB", "t", tok.id, new Date().toISOString(), new Date().toISOString(), "audio")
        .run(),
    ).rejects.toThrow();
  });
});

describe("listing", () => {
  it("scopes by token and filters by status", async () => {
    const store = makeStore();
    const tokA = await makeToken(store);
    const tokB = await makeToken(store);
    const a1 = await makeArtifact(store, tokA.id);
    await makeArtifact(store, tokB.id);
    const a3 = await makeArtifact(store, tokA.id);
    await store.expireArtifact(a3.id);

    const all = await store.listArtifacts({ tokenId: tokA.id, limit: 50 });
    expect(all.artifacts.map((a) => a.id).sort()).toEqual([a1.id, a3.id].sort());

    const active = await store.listArtifacts({ tokenId: tokA.id, status: "active", limit: 50 });
    expect(active.artifacts.map((a) => a.id)).toEqual([a1.id]);
  });

  it("paginates with an opaque cursor, newest first", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await makeArtifact(store, tok.id)).id);

    const page1 = await store.listArtifacts({ tokenId: tok.id, limit: 2 });
    expect(page1.artifacts).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await store.listArtifacts({ tokenId: tok.id, limit: 2, cursor: page1.nextCursor! });
    const page3 = await store.listArtifacts({ tokenId: tok.id, limit: 2, cursor: page2.nextCursor! });
    expect(page3.nextCursor).toBeNull();
    const seen = [...page1.artifacts, ...page2.artifacts, ...page3.artifacts].map((a) => a.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(ids.sort());
  });

  it("admin listing spans tokens and includes token names", async () => {
    const store = makeStore();
    const tok = await store.mintToken(`named-${crypto.randomUUID()}`);
    await makeArtifact(store, tok.id);
    const list = await store.listArtifacts({ limit: 200 });
    const mine = list.artifacts.find((a) => a.tokenId === tok.id);
    expect(mine?.tokenName).toBe(tok.name);
  });
});

describe("rate limiting", () => {
  it("allows under the limit and blocks at the limit with a retry hint", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    for (let i = 0; i < 3; i++) await store.recordPublish(tok.id);
    const ok = await store.checkRateLimit(tok.id, 4);
    expect(ok.allowed).toBe(true);
    const blocked = await store.checkRateLimit(tok.id, 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(3600);
  });
});

describe("cleanupExpired", () => {
  it("marks past-expiry actives expired, purges old blobs, keeps live ones, and is idempotent", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const live = await makeArtifact(store, tok.id, { ttlSeconds: 14 * DAY });
    const justExpired = await makeArtifact(store, tok.id, { ttlSeconds: -3600 });
    const longExpired = await makeArtifact(store, tok.id, { ttlSeconds: -10 * DAY });

    const first = await store.cleanupExpired();
    expect(first.markedExpired).toBe(2);

    expect((await store.getArtifact(live.id))?.artifact.status).toBe("active");
    expect((await store.getArtifact(justExpired.id))?.artifact.status).toBe("expired");
    expect((await store.getArtifact(longExpired.id))?.artifact.status).toBe("expired");

    // long-expired blob purged; recently expired blob retained
    expect(await env.BLOBS.get(`artifacts/${longExpired.id}/v1`)).toBeNull();
    expect(await env.BLOBS.get(`artifacts/${justExpired.id}/v1`)).not.toBeNull();
    expect(await env.BLOBS.get(`artifacts/${live.id}/v1`)).not.toBeNull();

    const second = await store.cleanupExpired();
    expect(second.markedExpired).toBe(0);
    expect(second.blobsPurged).toBe(0);
  });

  it("returns a StoreError shape for callers", () => {
    const err = new StoreError("not_found", "nope");
    expect(err.code).toBe("not_found");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("comments", () => {
  it("adds a comment recording author and the artifact's current version", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    await store.addVersion(art.id, { defaultTtlSeconds: 14 * DAY, contentType: "text/html", body: HTML });

    const c = await store.addComment(art.id, { author: "jane@team.com", body: "tighten intro" });
    expect(c.id).toMatch(/^cmt_/);
    expect(c.author).toBe("jane@team.com");
    expect(c.body).toBe("tighten intro");
    expect(c.version).toBe(2); // current_version after the addVersion
    expect(c.createdAt).toBeTruthy();
  });

  it("lists comments oldest-first, excluding soft-deleted", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const a = await store.addComment(art.id, { author: "a@t.com", body: "first" });
    await store.addComment(art.id, { author: "b@t.com", body: "second" });

    let list = await store.listComments(art.id);
    expect(list.comments.map((c) => c.body)).toEqual(["first", "second"]);
    expect(list.truncated).toBe(false);

    await store.deleteComment(a.id);
    list = await store.listComments(art.id);
    expect(list.comments.map((c) => c.body)).toEqual(["second"]);
  });

  it("soft-delete is idempotent and returns null for unknown ids", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const c = await store.addComment(art.id, { author: "a@t.com", body: "x" });
    const first = await store.deleteComment(c.id);
    expect(first?.id).toBe(c.id);
    const again = await store.deleteComment(c.id);
    expect(again?.id).toBe(c.id); // idempotent
    expect(await store.deleteComment("cmt_nope")).toBeNull();
  });

  it("rejects comments on missing or deleted artifacts", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    await expect(store.addComment("zzzzzzzzzzzzzz", { author: "a@t.com", body: "x" })).rejects.toThrow(StoreError);
    await store.deleteArtifact(art.id);
    await expect(store.addComment(art.id, { author: "a@t.com", body: "x" })).rejects.toThrow(StoreError);
  });
});

describe("comment threads and resolution", () => {
  it("a reply attaches to its root and captures the current version; reply-to-a-reply re-roots", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const root = await store.addComment(art.id, { author: "a@t.com", body: "root" }); // v1
    await store.addVersion(art.id, { defaultTtlSeconds: 14 * DAY, contentType: "text/html", body: HTML });
    const reply = await store.addComment(art.id, { author: "b@t.com", body: "reply", parentId: root.id });
    expect(reply.parentId).toBe(root.id);
    expect(reply.version).toBe(2); // version-at-reply-time

    const reply2 = await store.addComment(art.id, { author: "c@t.com", body: "reply2", parentId: reply.id });
    expect(reply2.parentId).toBe(root.id); // re-rooted onto the thread
  });

  it("rejects a reply whose parent is missing, soft-deleted, or on another artifact", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const other = await makeArtifact(store, tok.id);
    const elsewhere = await store.addComment(other.id, { author: "a@t.com", body: "root" });
    const gone = await store.addComment(art.id, { author: "a@t.com", body: "doomed" });
    await store.deleteComment(gone.id);

    await expect(store.addComment(art.id, { author: "b@t.com", body: "x", parentId: "cmt_nope" })).rejects.toThrow(StoreError);
    await expect(store.addComment(art.id, { author: "b@t.com", body: "x", parentId: gone.id })).rejects.toThrow(StoreError);
    await expect(store.addComment(art.id, { author: "b@t.com", body: "x", parentId: elsewhere.id })).rejects.toThrow(StoreError);
  });

  it("resolves a thread (idempotent), records the resolver, and unresolves", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const root = await store.addComment(art.id, { author: "a@t.com", body: "root" });

    const resolved = await store.setCommentResolved(root.id, true, "lead@team.com");
    expect(resolved?.resolvedAt).toBeTruthy();
    expect(resolved?.resolvedBy).toBe("lead@team.com");

    const again = await store.setCommentResolved(root.id, true, "other@team.com");
    expect(again?.resolvedAt).toBe(resolved?.resolvedAt); // idempotent: keeps first stamp
    expect(again?.resolvedBy).toBe("lead@team.com");

    const reopened = await store.setCommentResolved(root.id, false, "lead@team.com");
    expect(reopened?.resolvedAt).toBeNull();
    expect(reopened?.resolvedBy).toBeNull();
  });

  it("resolving a reply id resolves its root thread", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const root = await store.addComment(art.id, { author: "a@t.com", body: "root" });
    const reply = await store.addComment(art.id, { author: "b@t.com", body: "reply", parentId: root.id });

    const resolved = await store.setCommentResolved(reply.id, true, "lead@team.com");
    expect(resolved?.id).toBe(root.id);
    expect(resolved?.resolvedAt).toBeTruthy();
  });

  it("a reply to a resolved thread leaves it resolved", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const root = await store.addComment(art.id, { author: "a@t.com", body: "root" });
    await store.setCommentResolved(root.id, true, "lead@team.com");
    await store.addComment(art.id, { author: "b@t.com", body: "still broken?", parentId: root.id });

    const list = await store.listComments(art.id);
    expect(list.comments.find((c) => c.id === root.id)?.resolvedAt).toBeTruthy();
  });

  it("setCommentResolved returns null for unknown or soft-deleted comments", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    expect(await store.setCommentResolved("cmt_nope", true, "x@t.com")).toBeNull();
    const c = await store.addComment(art.id, { author: "a@t.com", body: "x" });
    await store.deleteComment(c.id);
    expect(await store.setCommentResolved(c.id, true, "x@t.com")).toBeNull();
  });

  it("lists threads contiguously: each root is followed by its replies", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const r1 = await store.addComment(art.id, { author: "a@t.com", body: "root1" });
    await store.addComment(art.id, { author: "a@t.com", body: "root2" });
    // reply created after root2, but it belongs under root1
    await store.addComment(art.id, { author: "b@t.com", body: "root1-reply", parentId: r1.id });

    const list = await store.listComments(art.id);
    expect(list.comments.map((c) => c.body)).toEqual(["root1", "root1-reply", "root2"]);
  });

  it("filters by thread status (open keeps unresolved roots + their replies)", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const open = await store.addComment(art.id, { author: "a@t.com", body: "open-root" });
    await store.addComment(art.id, { author: "b@t.com", body: "open-reply", parentId: open.id });
    const done = await store.addComment(art.id, { author: "a@t.com", body: "done-root" });
    await store.addComment(art.id, { author: "b@t.com", body: "done-reply", parentId: done.id });
    await store.setCommentResolved(done.id, true, "lead@team.com");

    const openOnly = await store.listComments(art.id, "open");
    expect(openOnly.comments.map((c) => c.body)).toEqual(["open-root", "open-reply"]);

    const resolvedOnly = await store.listComments(art.id, "resolved");
    expect(resolvedOnly.comments.map((c) => c.body)).toEqual(["done-root", "done-reply"]);

    const all = await store.listComments(art.id, "all");
    expect(all.comments).toHaveLength(4);
  });

  it("deleting a root cascades to its replies; deleting a reply leaves the rest", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const root = await store.addComment(art.id, { author: "a@t.com", body: "root" });
    const reply1 = await store.addComment(art.id, { author: "b@t.com", body: "reply1", parentId: root.id });
    await store.addComment(art.id, { author: "c@t.com", body: "reply2", parentId: root.id });

    await store.deleteComment(reply1.id);
    let list = await store.listComments(art.id);
    expect(list.comments.map((c) => c.body)).toEqual(["root", "reply2"]);

    await store.deleteComment(root.id);
    list = await store.listComments(art.id);
    expect(list.comments).toHaveLength(0);
  });
});

describe("reader comments (store)", () => {
  const ANCHOR = { exact: "metric", prefix: "the ", suffix: " here", start: 4, end: 10 };

  it("toggles comments_enabled and refuses it alongside a passcode", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    expect(art.commentsEnabled).toBe(false);

    const on = await store.setCommentsEnabled(art.id, true);
    expect(on.commentsEnabled).toBe(true);
    expect((await store.getArtifactGate(art.id))?.commentsEnabled).toBe(true);

    const locked = await store.createArtifact({
      tokenId: tok.id, title: null, ttlSeconds: DAY, contentType: "text/html", body: HTML, passcode: "s3cret",
    });
    await expect(store.setCommentsEnabled(locked.id, true)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("stores and round-trips a reader anchor; team comments have none", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);

    const reader = await store.addComment(art.id, {
      author: "Alex", authorKind: "anon", authorEmail: "a@x.com", body: "stale", anchor: ANCHOR, viewerId: "rvw_x",
    });
    expect(reader.authorKind).toBe("anon");
    expect(reader.anchor).toEqual(ANCHOR);

    const team = await store.addComment(art.id, { author: "lead@t.com", body: "team" });
    expect(team.authorKind).toBe("access");
    expect(team.anchor).toBeNull();

    const readerOnly = await store.listReaderComments(art.id);
    expect(readerOnly.comments.map((c) => c.body)).toEqual(["stale"]);
    expect((await store.listComments(art.id)).comments).toHaveLength(2);
  });

  it("self-delete only succeeds for the matching viewer_id", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const c = await store.addComment(art.id, {
      author: "A", authorKind: "anon", body: "x", anchor: ANCHOR, viewerId: "rvw_owner",
    });

    expect(await store.deleteReaderComment(c.id, "rvw_other")).toBeNull();
    const ok = await store.deleteReaderComment(c.id, "rvw_owner");
    expect(ok?.id).toBe(c.id);
    expect((await store.listReaderComments(art.id)).comments).toHaveLength(0);
  });

  it("refuses an anon reply onto a team root", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);
    const team = await store.addComment(art.id, { author: "lead@t.com", body: "team root" });
    await expect(
      store.addComment(art.id, { author: "R", authorKind: "anon", body: "reply", parentId: team.id }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("enforces per-IP and per-artifact comment windows with a retry hint", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeArtifact(store, tok.id);

    await store.recordCommentEvent("ipA", art.id);
    await store.recordCommentEvent("ipA", art.id);

    const ipHit = await store.checkCommentRateLimit("ipA", art.id, 2, 100);
    expect(ipHit.allowed).toBe(false);
    expect(ipHit.scope).toBe("ip");
    expect(ipHit.retryAfterSeconds).toBeGreaterThan(0);

    // A different IP is still under the per-IP cap...
    expect((await store.checkCommentRateLimit("ipB", art.id, 2, 100)).allowed).toBe(true);
    // ...but the per-artifact cap backstops it once the artifact window fills.
    const artHit = await store.checkCommentRateLimit("ipB", art.id, 5, 2);
    expect(artHit.allowed).toBe(false);
    expect(artHit.scope).toBe("artifact");
  });
});

describe("video artifacts", () => {
  it("creates a video artifact: primary blob, kind=video, versions row, video_versions row", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const bytes = fixtureBytes("video-h264-aac.mp4");
    const dirtyName = "../../evil name!!.MOV";
    const art = await store.createVideoArtifact({
      tokenId: tok.id,
      title: "Demo",
      ttlSeconds: 3 * DAY,
      filename: dirtyName,
      contentLength: bytes.byteLength,
      maxDurationMs: VIDEO_MAX_DURATION_MS,
      body: streamOf(bytes),
    });

    expect(art.kind).toBe("video");
    expect(art.currentVersion).toBe(1);
    expect(art.contentType).toBe("video/mp4");
    expect(art.sizeBytes).toBe(bytes.byteLength);
    expect(art.title).toBe("Demo");
    expect(art.video.filename).toBe(sanitizeVideoFilename(dirtyName));
    expect(art.video.durationMs).toBe(1000);
    expect(art.video.width).toBe(320);
    expect(art.video.height).toBe(180);
    expect(art.video.videoCodec).toBe("h264");
    expect(art.video.audioCodec).toBe("aac");
    expect(art.video.posterR2Key).toBeNull();

    const stored = await env.BLOBS.get(`artifacts/${art.id}/v1`);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);

    const versionRow = await env.DB.prepare(
      "SELECT r2_key, content_type, size_bytes FROM versions WHERE artifact_id = ?1 AND version = 1",
    )
      .bind(art.id)
      .first<{ r2_key: string; content_type: string; size_bytes: number }>();
    expect(versionRow).toMatchObject({
      r2_key: `artifacts/${art.id}/v1`,
      content_type: "video/mp4",
      size_bytes: bytes.byteLength,
    });
  });

  it("addVideoVersion increments the version and always resets expiry from upload time", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id, { ttlSeconds: DAY });
    const bytes2 = fixtureBytes("video-h264-silent.mp4");

    const before = Date.now();
    const v2 = await store.addVideoVersion(art.id, {
      ttlSeconds: 3 * DAY,
      filename: "clip2.mp4",
      contentLength: bytes2.byteLength,
      maxDurationMs: VIDEO_MAX_DURATION_MS,
      body: streamOf(bytes2),
    });

    expect(v2.currentVersion).toBe(2);
    expect(v2.video.audioCodec).toBeNull(); // silent fixture
    const expiresAtMs = new Date(v2.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3 * DAY * 1000 - 5000);
    expect(expiresAtMs).toBeLessThanOrEqual(before + 3 * DAY * 1000 + 5000);

    const content = await env.BLOBS.get(`artifacts/${art.id}/v2`);
    expect(new Uint8Array(await content!.arrayBuffer())).toEqual(bytes2);
  });

  it("reactivates an expired, non-deleted video on a new version; its already-purged v1 stays unavailable", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id, { ttlSeconds: -3600 }); // already expired at creation

    await store.cleanupExpired();
    expect((await store.getArtifact(art.id))?.artifact.status).toBe("expired");
    expect(await env.BLOBS.get(`artifacts/${art.id}/v1`)).toBeNull(); // purged immediately, no grace

    const bytes2 = fixtureBytes("video-h264-silent.mp4");
    const v2 = await store.addVideoVersion(art.id, {
      ttlSeconds: 3 * DAY,
      filename: "clip2.mp4",
      contentLength: bytes2.byteLength,
      maxDurationMs: VIDEO_MAX_DURATION_MS,
      body: streamOf(bytes2),
    });

    expect(v2.status).toBe("active");
    expect(v2.currentVersion).toBe(2);
    expect(await env.BLOBS.get(`artifacts/${art.id}/v2`)).not.toBeNull();
    expect(await env.BLOBS.get(`artifacts/${art.id}/v1`)).toBeNull(); // not restored
  });

  it("throws kind_mismatch for cross-kind version updates in both directions", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const doc = await makeArtifact(store, tok.id);
    const bytes = fixtureBytes("video-h264-aac.mp4");

    await expect(
      store.addVideoVersion(doc.id, {
        ttlSeconds: DAY,
        filename: "x.mp4",
        contentLength: bytes.byteLength,
        maxDurationMs: VIDEO_MAX_DURATION_MS,
        body: streamOf(bytes),
      }),
    ).rejects.toMatchObject({ code: "kind_mismatch" });

    const video = await makeVideoArtifact(store, tok.id);
    await expect(
      store.addVersion(video.id, { contentType: "text/html", body: HTML, defaultTtlSeconds: DAY }),
    ).rejects.toMatchObject({ code: "kind_mismatch" });
  });

  it("accepts a sniffed JPEG/PNG poster, records its key, and replaces it with a fresh key", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id);
    const posterKeyPrefix = `artifacts/${art.id}/v${art.currentVersion}/poster-`;

    const jpegType = detectPosterImageType(JPEG_BYTES);
    expect(jpegType).toBe("image/jpeg");
    const accepted = await store.setVideoPoster(art.id, art.currentVersion, JPEG_BYTES, jpegType!);
    expect(accepted.posterR2Key).toMatch(new RegExp(`^${posterKeyPrefix}`));
    expect(accepted.posterContentType).toBe("image/jpeg");
    expect(accepted.posterSizeBytes).toBe(JPEG_BYTES.byteLength);
    const stored = await env.BLOBS.get(accepted.posterR2Key!);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(JPEG_BYTES);

    const pngType = detectPosterImageType(PNG_BYTES);
    expect(pngType).toBe("image/png");
    const replaced = await store.setVideoPoster(art.id, art.currentVersion, PNG_BYTES, pngType!);
    expect(replaced.posterR2Key).toMatch(new RegExp(`^${posterKeyPrefix}`));
    expect(replaced.posterR2Key).not.toBe(accepted.posterR2Key); // fresh key per upload, not overwritten in place
    expect(replaced.posterContentType).toBe("image/png");
    expect(replaced.posterSizeBytes).toBe(PNG_BYTES.byteLength);
    const storedAfter = await env.BLOBS.get(replaced.posterR2Key!);
    expect(new Uint8Array(await storedAfter!.arrayBuffer())).toEqual(PNG_BYTES);
    // The old poster blob is removed only once D1 durably points elsewhere.
    expect(await env.BLOBS.get(accepted.posterR2Key!)).toBeNull();
  });

  it("rejects a poster whose bytes don't sniff to the declared type, and posters on document artifacts", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id);

    await expect(
      store.setVideoPoster(art.id, art.currentVersion, new Uint8Array([1, 2, 3]), "image/jpeg"),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.setVideoPoster(art.id, art.currentVersion, PNG_BYTES, "image/jpeg"),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const doc = await makeArtifact(store, tok.id);
    await expect(store.setVideoPoster(doc.id, 1, JPEG_BYTES, "image/jpeg")).rejects.toMatchObject({
      code: "kind_mismatch",
    });
  });

  it("rejects a poster upload on a deleted video, leaving no new R2 key", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id);
    await store.deleteArtifact(art.id);

    await expect(store.setVideoPoster(art.id, art.currentVersion, JPEG_BYTES, "image/jpeg")).rejects.toMatchObject({
      code: "not_active",
    });
    const listing = await env.BLOBS.list({ prefix: `artifacts/${art.id}/v${art.currentVersion}/poster-` });
    expect(listing.objects).toHaveLength(0);
  });

  it("rejects a poster for a nonexistent version of an existing video artifact", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id); // only version 1 exists

    await expect(store.setVideoPoster(art.id, 2, JPEG_BYTES, "image/jpeg")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("a D1 failure on a first poster upload leaves no newly-orphaned R2 object", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id);
    const jpegType = detectPosterImageType(JPEG_BYTES)!;
    const posterKeyPrefix = `artifacts/${art.id}/v${art.currentVersion}/poster-`;

    // Force only the metadata UPDATE to fail (not the SELECT setVideoPoster
    // already runs to load the existing row, nor the R2 put) via a genuine
    // BEFORE UPDATE trigger that aborts — a real D1/SQLite failure, not a mock.
    await env.DB.prepare(
      "CREATE TRIGGER poster_update_guard BEFORE UPDATE ON video_versions BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    ).run();
    try {
      await expect(store.setVideoPoster(art.id, art.currentVersion, JPEG_BYTES, jpegType)).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER poster_update_guard").run();
    }

    // No prior poster existed, so the newly-written (now unreferenceable)
    // blob must have been cleaned up rather than left as an orphan. There's
    // no key to check by exact name (the failed UPDATE never committed one to
    // D1), so scan for anything left under this version's poster prefix.
    const listing = await env.BLOBS.list({ prefix: posterKeyPrefix });
    expect(listing.objects).toHaveLength(0);
    expect((await store.getVideoVersion(art.id, art.currentVersion))?.posterR2Key).toBeNull();
  });

  it("a D1 failure on a poster replace leaves the OLD poster's bytes and metadata fully intact and deletes only the new key", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id);
    const jpegType = detectPosterImageType(JPEG_BYTES)!;
    const pngType = detectPosterImageType(PNG_BYTES)!;

    const original = await store.setVideoPoster(art.id, art.currentVersion, JPEG_BYTES, jpegType);
    const originalKey = original.posterR2Key!;

    await env.DB.prepare(
      "CREATE TRIGGER poster_update_guard BEFORE UPDATE ON video_versions BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    ).run();
    try {
      await expect(store.setVideoPoster(art.id, art.currentVersion, PNG_BYTES, pngType)).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER poster_update_guard").run();
    }

    // The old poster's blob and D1 metadata must be completely untouched —
    // no silent three-way mismatch between R2 bytes, R2 httpMetadata, and D1.
    const afterFailure = await store.getVideoVersion(art.id, art.currentVersion);
    expect(afterFailure?.posterR2Key).toBe(originalKey);
    expect(afterFailure?.posterContentType).toBe("image/jpeg");
    expect(afterFailure?.posterSizeBytes).toBe(JPEG_BYTES.byteLength);
    const stillStored = await env.BLOBS.get(originalKey);
    expect(new Uint8Array(await stillStored!.arrayBuffer())).toEqual(JPEG_BYTES);

    // Only the new (never-committed) key was written for this attempt, and it
    // must be gone — scan the version's poster prefix for anything besides
    // the original key.
    const posterKeyPrefix = `artifacts/${art.id}/v${art.currentVersion}/poster-`;
    const listing = await env.BLOBS.list({ prefix: posterKeyPrefix });
    expect(listing.objects.map((o) => o.key)).toEqual([originalKey]);
  });

  it("delete purges both the MP4 and poster blobs", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id);
    const jpegType = detectPosterImageType(JPEG_BYTES)!;
    const withPoster = await store.setVideoPoster(art.id, art.currentVersion, JPEG_BYTES, jpegType);

    await store.deleteArtifact(art.id);

    expect(await env.BLOBS.get(`artifacts/${art.id}/v1`)).toBeNull();
    expect(await env.BLOBS.get(withPoster.posterR2Key!)).toBeNull();
  });

  it("cleanup purges an expired video's blobs immediately, but keeps a recently expired document's blob", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const video = await makeVideoArtifact(store, tok.id, { ttlSeconds: -60 });
    const doc = await makeArtifact(store, tok.id, { ttlSeconds: -60 });

    await store.cleanupExpired();

    expect(await env.BLOBS.get(`artifacts/${video.id}/v1`)).toBeNull();
    expect(await env.BLOBS.get(`artifacts/${doc.id}/v1`)).not.toBeNull();
  });

  it("rejects and deletes the object when the stored size doesn't match the declared content length", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const bytes = fixtureBytes("video-h264-aac.mp4");

    await expect(
      store.createVideoArtifact({
        tokenId: tok.id,
        title: null,
        ttlSeconds: DAY,
        filename: "x.mp4",
        contentLength: bytes.byteLength + 10, // lies about the size
        maxDurationMs: VIDEO_MAX_DURATION_MS,
        body: streamOf(bytes),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const { results } = await env.DB.prepare("SELECT id FROM artifacts WHERE token_id = ?1").bind(tok.id).all();
    expect(results).toHaveLength(0);
    const listing = await env.BLOBS.list({ prefix: "artifacts/" });
    expect(listing.objects).toHaveLength(0);
  });

  it("rejects and deletes the object when the declared content length is smaller than the actual stored size", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const bytes = fixtureBytes("video-h264-aac.mp4");

    await expect(
      store.createVideoArtifact({
        tokenId: tok.id,
        title: null,
        ttlSeconds: DAY,
        filename: "x.mp4",
        contentLength: bytes.byteLength - 10, // understates the size
        maxDurationMs: VIDEO_MAX_DURATION_MS,
        body: streamOf(bytes),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const { results } = await env.DB.prepare("SELECT id FROM artifacts WHERE token_id = ?1").bind(tok.id).all();
    expect(results).toHaveLength(0);
    const listing = await env.BLOBS.list({ prefix: "artifacts/" });
    expect(listing.objects).toHaveLength(0);
  });

  it("rejects and deletes a zero-byte upload (stored size must be positive)", async () => {
    const store = makeStore();
    const tok = await makeToken(store);

    await expect(
      store.createVideoArtifact({
        tokenId: tok.id,
        title: null,
        ttlSeconds: DAY,
        filename: "empty.mp4",
        contentLength: 0,
        maxDurationMs: VIDEO_MAX_DURATION_MS,
        body: streamOf(new Uint8Array(0)),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const { results } = await env.DB.prepare("SELECT id FROM artifacts WHERE token_id = ?1").bind(tok.id).all();
    expect(results).toHaveLength(0);
    const listing = await env.BLOBS.list({ prefix: "artifacts/" });
    expect(listing.objects).toHaveLength(0);
  });

  it("rejects and deletes a stored object that exceeds the 100,000,000-byte hard cap, even when it matches the declared length", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const size = 100_000_001; // one byte over the cap

    await expect(
      store.createVideoArtifact({
        tokenId: tok.id,
        title: null,
        ttlSeconds: DAY,
        filename: "big.mp4",
        contentLength: size,
        maxDurationMs: VIDEO_MAX_DURATION_MS,
        body: fixedLengthStream(size),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const { results } = await env.DB.prepare("SELECT id FROM artifacts WHERE token_id = ?1").bind(tok.id).all();
    expect(results).toHaveLength(0);
    const listing = await env.BLOBS.list({ prefix: "artifacts/" });
    expect(listing.objects).toHaveLength(0);
  }, 30_000);

  it("a parser failure (not a valid MP4) leaves no R2 object and creates nothing", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const bytes = new TextEncoder().encode("this is not an mp4 container at all, just text bytes");

    await expect(
      store.createVideoArtifact({
        tokenId: tok.id,
        title: null,
        ttlSeconds: DAY,
        filename: "x.mp4",
        contentLength: bytes.byteLength,
        maxDurationMs: VIDEO_MAX_DURATION_MS,
        body: streamOf(bytes),
      }),
    ).rejects.toThrow();

    const listing = await env.BLOBS.list({ prefix: "artifacts/" });
    expect(listing.objects).toHaveLength(0);
  });

  it("a D1 batch failure leaves no R2 object and the artifact unchanged", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const art = await makeVideoArtifact(store, tok.id); // v1

    // Simulate a race/corruption: a `versions` row already occupies (id, 2),
    // so addVideoVersion's own insert for version 2 collides on the primary key.
    await env.DB.prepare(
      "INSERT INTO versions (artifact_id, version, r2_key, content_type, size_bytes, created_at) VALUES (?1, 2, 'bogus', 'text/plain', 1, ?2)",
    )
      .bind(art.id, new Date().toISOString())
      .run();

    const bytes2 = fixtureBytes("video-h264-silent.mp4");
    await expect(
      store.addVideoVersion(art.id, {
        ttlSeconds: DAY,
        filename: "y.mp4",
        contentLength: bytes2.byteLength,
        maxDurationMs: VIDEO_MAX_DURATION_MS,
        body: streamOf(bytes2),
      }),
    ).rejects.toThrow();

    expect(await env.BLOBS.get(`artifacts/${art.id}/v2`)).toBeNull();
    expect((await store.getArtifact(art.id))?.artifact.currentVersion).toBe(1);
  });
});

describe("auditOrphanVideoBlobs", () => {
  it("deletes only unreferenced, stale primary/poster keys, ignores non-matching shapes, and progresses its cursor", async () => {
    const store = makeStore();
    const tok = await makeToken(store);
    const video = await makeVideoArtifact(store, tok.id);
    const doc = await makeArtifact(store, tok.id);
    const jpegType = detectPosterImageType(JPEG_BYTES)!;
    const realPoster = await store.setVideoPoster(video.id, video.currentVersion, JPEG_BYTES, jpegType);

    await env.BLOBS.put("artifacts/orphanA/v1", new Uint8Array([1]));
    // Unreferenced synthetic poster using the real (suffixed) key shape.
    await env.BLOBS.put("artifacts/orphanB/v1/poster-deadbeef", new Uint8Array([2]));
    // Not a primary/poster key shape — must survive even though unreferenced.
    await env.BLOBS.put("artifacts/orphanC/assets/deadbeef", new Uint8Array([3]));

    const future = new Date(Date.now() + 2 * 3600_000); // pretend >1h has passed

    const first = await store.auditOrphanVideoBlobs(1, future);
    const row1 = await env.DB.prepare("SELECT cursor FROM cleanup_state WHERE name = 'orphan_video_blobs'").first<{
      cursor: string | null;
    }>();
    expect(first.scanned).toBe(1);
    expect(row1?.cursor).toBeTruthy();

    const second = await store.auditOrphanVideoBlobs(1, future);
    const row2 = await env.DB.prepare("SELECT cursor FROM cleanup_state WHERE name = 'orphan_video_blobs'").first<{
      cursor: string | null;
    }>();
    expect(second.scanned).toBe(1);
    expect(row2?.cursor).not.toBe(row1?.cursor); // cursor advanced, not stuck rescanning page one

    // Keep sweeping (bucket has 6 objects total) until fully covered.
    let totalScanned = first.scanned + second.scanned;
    for (let i = 0; i < 10 && totalScanned < 6; i++) {
      const r = await store.auditOrphanVideoBlobs(1, future);
      totalScanned += r.scanned;
      if (r.scanned === 0) break;
    }
    expect(totalScanned).toBe(6);

    expect(await env.BLOBS.get("artifacts/orphanA/v1")).toBeNull();
    expect(await env.BLOBS.get("artifacts/orphanB/v1/poster-deadbeef")).toBeNull();
    expect(await env.BLOBS.get("artifacts/orphanC/assets/deadbeef")).not.toBeNull();
    expect(await env.BLOBS.get(`artifacts/${video.id}/v1`)).not.toBeNull();
    expect(await env.BLOBS.get(`artifacts/${doc.id}/v1`)).not.toBeNull();
    // A referenced poster (matches the same key shape as the deleted orphan)
    // must survive the sweep too.
    expect(await env.BLOBS.get(realPoster.posterR2Key!)).not.toBeNull();
  });

  it("leaves a freshly written orphan blob alone until it is older than one hour", async () => {
    const store = makeStore();
    await env.BLOBS.put("artifacts/freshOrphan/v1", new Uint8Array([9]));

    const result = await store.auditOrphanVideoBlobs(100); // real "now": object is only moments old
    expect(result.deleted).toBe(0);
    expect(await env.BLOBS.get("artifacts/freshOrphan/v1")).not.toBeNull();
  });
});

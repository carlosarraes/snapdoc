import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Store, StoreError } from "../src/store";

const HTML = "<!doctype html><html><body>hi</body></html>";
const DAY = 86400;

function makeStore() {
  return new Store(env.DB, env.BLOBS);
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

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

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, ARTIFACT_BASE, expectError, mintToken, publish } from "./helpers";

interface ReaderComment {
  id: string;
  author: string;
  author_kind: string;
  version: number;
  body: string;
  created_at: string;
  parent_id: string | null;
  resolved: boolean;
  anchor: { exact: string; prefix: string; suffix: string; start: number; end: number } | null;
  author_email?: string;
}

const ANCHOR = { exact: "report", prefix: "the ", suffix: " here", start: 4, end: 10 };

async function publishArtifact(token: string, opts: { comments?: boolean; passcode?: string } = {}): Promise<string> {
  const res = await publish({ token, comments: opts.comments, passcode: opts.passcode });
  return ((await res.json()) as { id: string }).id;
}

async function enableComments(id: string, token: string, enabled = true) {
  return SELF.fetch(`${API_BASE}/v1/artifacts/${id}/comment-settings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

type ReaderPayload = {
  author_name?: string;
  author_email?: string;
  body?: string;
  anchor?: unknown;
  parent_id?: string;
  version?: number;
};

async function postReader(id: string, payload: ReaderPayload, opts: { cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  return SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

async function readReader(id: string, status?: string) {
  const q = status ? `?status=${status}` : "";
  return SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}/comments${q}`);
}

// Returns the `sd_reviewer=...` pair to echo back as a Cookie header.
function cookieFrom(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const match = /sd_reviewer=[^;]+/.exec(raw);
  return match ? match[0] : null;
}

async function root(id: string, body = "note", extra: ReaderPayload = {}, opts: { cookie?: string } = {}) {
  return postReader(id, { author_name: "Alex R.", body, anchor: ANCHOR, ...extra }, opts);
}

describe("reader comments — opt-in gating", () => {
  it("rejects writes until the owner enables comments, then accepts them", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);

    await expectError(await root(id), 403, "comments_disabled");

    expect((await enableComments(id, tok.token)).status).toBe(200);
    const ok = await root(id);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as ReaderComment).author_kind).toBe("anon");
  });

  it("accepts comments when enabled at publish via ?comments=1", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    expect((await root(id)).status).toBe(201);
  });

  it("a later comment-settings=false stops new writes but keeps existing reads", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    await root(id, "still here");
    expect((await enableComments(id, tok.token, false)).status).toBe(200);

    await expectError(await root(id), 403, "comments_disabled");
    const body = (await (await readReader(id)).json()) as { comments: ReaderComment[] };
    expect(body.comments).toHaveLength(1);
  });
});

describe("reader comments — validation", () => {
  async function enabledArtifact(): Promise<string> {
    const tok = await mintToken();
    return publishArtifact(tok.token, { comments: true });
  }

  it("requires a 1–80 char author_name", async () => {
    const id = await enabledArtifact();
    await expectError(await postReader(id, { body: "x", anchor: ANCHOR }), 400, "invalid_request");
    await expectError(await root(id, "x", { author_name: "  " }), 400, "invalid_request");
    await expectError(await root(id, "x", { author_name: "n".repeat(81) }), 400, "invalid_request");
  });

  it("requires a non-empty body within the 8 KB cap", async () => {
    const id = await enabledArtifact();
    await expectError(await root(id, ""), 400, "invalid_request");
    await expectError(await root(id, "x".repeat(8 * 1024 + 1)), 400, "invalid_request");
  });

  it("requires a well-formed anchor on a root comment", async () => {
    const id = await enabledArtifact();
    await expectError(await postReader(id, { author_name: "A", body: "x" }), 400, "invalid_request");
    await expectError(await root(id, "x", { anchor: { exact: "", prefix: "", suffix: "", start: 0, end: 0 } }), 400, "invalid_request");
    await expectError(await root(id, "x", { anchor: { exact: "a", prefix: "", suffix: "", start: 5, end: 2 } }), 400, "invalid_request");
  });

  it("stores a valid author_email but never exposes it on the public rail", async () => {
    const id = await enabledArtifact();
    await expectError(await root(id, "x", { author_email: "not-an-email" }), 400, "invalid_request");

    const created = (await (await root(id, "flagged", { author_email: "alex@example.com" })).json()) as ReaderComment;
    expect(created.author_email).toBeUndefined();

    const body = (await (await readReader(id)).json()) as { comments: ReaderComment[] };
    expect(body.comments[0].author_email).toBeUndefined();
    expect(body.comments[0].anchor).toEqual(ANCHOR);
    expect(body.comments[0].author_kind).toBe("anon");
  });
});

describe("reader comments — threads and self-delete", () => {
  it("replies attach to an anon root without an anchor and thread in order", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    const rootC = (await (await root(id, "root note")).json()) as ReaderComment;

    const reply = await postReader(id, { author_name: "Bo", body: "a reply", parent_id: rootC.id });
    expect(reply.status).toBe(201);
    expect(((await reply.json()) as ReaderComment).parent_id).toBe(rootC.id);

    const body = (await (await readReader(id)).json()) as { comments: ReaderComment[] };
    expect(body.comments.map((c) => c.body)).toEqual(["root note", "a reply"]);
  });

  it("refuses a reader reply onto a team (Access) comment", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    const team = (await (
      await SELF.fetch(`${API_BASE}/v1/admin/artifacts/${id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Access-Email": "lead@team.com" },
        body: JSON.stringify({ body: "team note" }),
      })
    ).json()) as { id: string };
    await expectError(await postReader(id, { author_name: "Bo", body: "sneaky", parent_id: team.id }), 400, "invalid_request");
  });

  it("lets a reader delete only their own comment, gated by the viewer cookie", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    const res = await root(id, "delete me");
    const cookie = cookieFrom(res)!;
    expect(cookie).toBeTruthy();
    const created = (await res.json()) as ReaderComment;

    // No cookie → not found (never reveals the comment).
    await expectError(
      await SELF.fetch(`${API_BASE}/v1/reader/comments/${created.id}`, { method: "DELETE" }),
      404,
      "not_found",
    );
    // Wrong cookie → not found.
    await expectError(
      await SELF.fetch(`${API_BASE}/v1/reader/comments/${created.id}`, {
        method: "DELETE",
        headers: { Cookie: "sd_reviewer=rvw_wrongwrongwrongwrongwrongwrongwr" },
      }),
      404,
      "not_found",
    );
    // Correct cookie → deleted, and it drops out of reads.
    const del = await SELF.fetch(`${API_BASE}/v1/reader/comments/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const body = (await (await readReader(id)).json()) as { comments: ReaderComment[] };
    expect(body.comments).toHaveLength(0);
  });
});

describe("reader comments — rate limiting", () => {
  it("throttles a single IP after the per-IP hourly cap (429 + Retry-After)", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    const ip = "203.0.113.7";
    const limit = 20; // COMMENT_RATE_LIMIT_PER_IP_PER_HOUR

    for (let i = 0; i < limit; i++) {
      const res = await postReader(id, { author_name: "A", body: `c${i}`, anchor: ANCHOR }, { ip });
      expect(res.status).toBe(201);
    }
    const blocked = await postReader(id, { author_name: "A", body: "over", anchor: ANCHOR }, { ip });
    await expectError(blocked, 429, "rate_limited");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);

    // A different IP is unaffected by the first IP's window.
    const other = await postReader(id, { author_name: "B", body: "fresh", anchor: ANCHOR }, { ip: "198.51.100.9" });
    expect(other.status).toBe(201);
  });
});

describe("reader comments — reviewed version attribution", () => {
  it("records a root against the explicitly reviewed historical version", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    await publish({ token: tok.token, id, body: "<p>version two</p>" });

    const created = (await (await root(id, "v1 feedback", { version: 1 })).json()) as ReaderComment;
    expect(created.version).toBe(1);
  });

  it("defaults omitted versions to latest for backward-compatible clients", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    await publish({ token: tok.token, id, body: "<p>version two</p>" });

    const created = (await (await root(id, "latest feedback")).json()) as ReaderComment;
    expect(created.version).toBe(2);
  });

  it("rejects invalid and nonexistent reviewed versions", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });

    await expectError(await root(id, "bad", { version: 0 }), 400, "invalid_request");
    await expectError(await root(id, "missing", { version: 99 }), 400, "invalid_request");
  });

  it("keeps replies attached to their root thread's version", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    await publish({ token: tok.token, id, body: "<p>version two</p>" });
    const rootComment = (await (await root(id, "v1 root", { version: 1 })).json()) as ReaderComment;

    const reply = (await (
      await postReader(id, { author_name: "Bo", body: "reply", parent_id: rootComment.id, version: 2 })
    ).json()) as ReaderComment;
    expect(reply.version).toBe(1);
  });
});

describe("reader comments — meta and errors", () => {
  it("exposes public metadata and 404/410 via the gate", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    const meta = (await (await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}`)).json()) as {
      id: string;
      comments_enabled: boolean;
      current_version: number;
      versions: { version: number }[];
      token_name?: string;
    };
    expect(meta.id).toBe(id);
    expect(meta.comments_enabled).toBe(true);
    expect(meta.versions).toHaveLength(1);
    expect(meta.token_name).toBeUndefined();

    await expectError(await SELF.fetch(`${API_BASE}/v1/reader/artifacts/zzzzzzzzzzzzzz`), 404, "not_found");
    await expectError(await root("zzzzzzzzzzzzzz"), 404, "not_found");
  });
});

describe("reader comments — unified agent read-back", () => {
  it("Bearer read returns both team and reader comments with anchors and kinds", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    await root(id, "reader feedback", { author_email: "alex@example.com" });
    await SELF.fetch(`${API_BASE}/v1/admin/artifacts/${id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Email": "lead@team.com" },
      body: JSON.stringify({ body: "team note" }),
    });

    const read = await SELF.fetch(`${API_BASE}/v1/artifacts/${id}/comments`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    const body = (await read.json()) as { comments: ReaderComment[] };
    const reader = body.comments.find((c) => c.author_kind === "anon")!;
    const team = body.comments.find((c) => c.author_kind === "access")!;
    expect(reader.anchor).toEqual(ANCHOR);
    expect(reader.author).toBe("Alex R.");
    // The agent read-back keeps author_email (unlike the public rail).
    expect(reader.author_email).toBe("alex@example.com");
    expect(team.anchor).toBeNull();
    expect(team.author).toBe("lead@team.com");
  });
});

describe("reader comments — passcode-protected artifacts", () => {
  const PW = "hunter2";

  async function protectedArtifact(): Promise<{ id: string; token: string }> {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true, passcode: PW });
    return { id, token: tok.token };
  }

  function withPasscode(passcode: string, ip = "6.6.6.6"): Record<string, string> {
    return { "X-Snapdoc-Passcode": passcode, "CF-Connecting-IP": ip };
  }

  it("publishes with both comments and a passcode, and the toggle works too", async () => {
    const { id } = await protectedArtifact();
    const tok = await mintToken();
    const toggledId = await publishArtifact(tok.token, { passcode: PW });
    const toggled = await enableComments(toggledId, tok.token);
    expect(toggled.status).toBe(200);
    expect(id).toBeTruthy();
  });

  it("locks all reader endpoints without an unlock cookie or passcode header", async () => {
    const { id } = await protectedArtifact();

    const meta = await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}`);
    await expectError(meta, 401, "passcode_required");

    await expectError(await readReader(id), 401, "passcode_required");
    await expectError(
      await postReader(id, { author_name: "Ana", body: "x", anchor: ANCHOR }),
      401,
      "passcode_required",
    );
  });

  it("does not leak the title or versions of a locked artifact", async () => {
    const tok = await mintToken();
    const res = await publish({ token: tok.token, comments: true, passcode: PW, title: "Top Secret Plan" });
    const { id } = (await res.json()) as { id: string };
    const meta = await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}`);
    expect(meta.status).toBe(401);
    expect(await meta.text()).not.toContain("Top Secret Plan");
  });

  it("accepts a correct X-Snapdoc-Passcode header on every endpoint", async () => {
    const { id } = await protectedArtifact();

    const meta = await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}`, { headers: withPasscode(PW) });
    expect(meta.status).toBe(200);

    const posted = await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...withPasscode(PW) },
      body: JSON.stringify({ author_name: "Ana", body: "note", anchor: ANCHOR }),
    });
    expect(posted.status).toBe(201);
    const root = (await posted.json()) as ReaderComment;

    const list = await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}/comments`, { headers: withPasscode(PW) });
    expect(list.status).toBe(200);

    const patched = await SELF.fetch(`${API_BASE}/v1/reader/comments/${root.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...withPasscode(PW) },
      body: JSON.stringify({ resolved: true, author_name: "Carlos" }),
    });
    expect(patched.status).toBe(200);
  });

  it("rejects a wrong header passcode and rate-limits repeated failures", async () => {
    const { id } = await protectedArtifact();
    const ip = "7.7.7.7";
    await expectError(
      await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}`, { headers: withPasscode("wrong", ip) }),
      401,
      "passcode_incorrect",
    );
    // Failed guesses consume the per-IP comment budget (20/h in test vars);
    // once exhausted, further guesses are refused before verification.
    for (let i = 0; i < 19; i++) {
      await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}`, { headers: withPasscode("wrong", ip) });
    }
    await expectError(
      await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}`, { headers: withPasscode("wrong", ip) }),
      429,
      "rate_limited",
    );
  });

  it("honors the unlock cookie across reader routes and gates delete", async () => {
    const { id } = await protectedArtifact();

    const unlock = await SELF.fetch(`${ARTIFACT_BASE}/${id}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: PW }),
      redirect: "manual",
    });
    expect(unlock.status).toBe(303);
    const unlockCookie = (unlock.headers.get("Set-Cookie") ?? "").split(";")[0];
    expect(unlockCookie).toContain(`sd_unlock_${id}=`);

    // Post with the unlock cookie (artifact-host reader route, same origin as the cookie).
    const posted = await SELF.fetch(`${ARTIFACT_BASE}/v1/reader/artifacts/${id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: unlockCookie },
      body: JSON.stringify({ author_name: "Ana", body: "note", anchor: ANCHOR }),
    });
    expect(posted.status).toBe(201);
    const reviewerCookie = cookieFrom(posted)!;
    const root = (await posted.json()) as ReaderComment;

    // Delete still needs the reviewer cookie, and now also the unlock.
    await expectError(
      await SELF.fetch(`${API_BASE}/v1/reader/comments/${root.id}`, {
        method: "DELETE",
        headers: { Cookie: reviewerCookie },
      }),
      401,
      "passcode_required",
    );
    const deleted = await SELF.fetch(`${API_BASE}/v1/reader/comments/${root.id}`, {
      method: "DELETE",
      headers: { Cookie: `${reviewerCookie}; ${unlockCookie}` },
    });
    expect(deleted.status).toBe(200);
  });

  it("keeps unprotected artifacts working without any credentials", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    expect((await SELF.fetch(`${API_BASE}/v1/reader/artifacts/${id}`)).status).toBe(200);
    expect((await postReader(id, { author_name: "Ana", body: "x", anchor: ANCHOR })).status).toBe(201);
  });
});

describe("reader resolve", () => {
  async function resolveReader(cid: string, body: unknown, ip = "9.9.9.9") {
    return SELF.fetch(`${API_BASE}/v1/reader/comments/${cid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    });
  }

  it("resolves and reopens a thread from the review page", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    const root = (await (
      await postReader(id, { author_name: "Ana", body: "typo here", anchor: ANCHOR })
    ).json()) as ReaderComment;

    const res = await resolveReader(root.id, { resolved: true, author_name: "Carlos" });
    expect(res.status).toBe(200);
    const resolved = (await res.json()) as ReaderComment & { resolved_by: string | null };
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolved_by).toBe("Carlos (reader)");

    const open = (await (await readReader(id, "open")).json()) as { comments: ReaderComment[] };
    expect(open.comments).toHaveLength(0);
    const done = (await (await readReader(id, "resolved")).json()) as { comments: ReaderComment[] };
    expect(done.comments.map((c) => c.id)).toContain(root.id);

    const reopened = await resolveReader(root.id, { resolved: false, author_name: "Carlos" });
    expect(((await reopened.json()) as ReaderComment).resolved).toBe(false);
  });

  it("re-roots a reply id to its thread root", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    const root = (await (
      await postReader(id, { author_name: "Ana", body: "root", anchor: ANCHOR })
    ).json()) as ReaderComment;
    const reply = (await (
      await postReader(id, { author_name: "Bo", body: "reply", parent_id: root.id })
    ).json()) as ReaderComment;

    const res = await resolveReader(reply.id, { resolved: true, author_name: "Bo" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ReaderComment).id).toBe(root.id);
  });

  it("gates writes on comments_enabled and validates the body", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token, { comments: true });
    const root = (await (
      await postReader(id, { author_name: "Ana", body: "x", anchor: ANCHOR })
    ).json()) as ReaderComment;

    await expectError(await resolveReader(root.id, { resolved: "yes", author_name: "A" }), 400, "invalid_request");
    await expectError(await resolveReader(root.id, { resolved: true }), 400, "invalid_request");
    await expectError(await resolveReader("cmt_missing00000", { resolved: true, author_name: "A" }), 404, "not_found");

    await enableComments(id, tok.token, false);
    await expectError(await resolveReader(root.id, { resolved: true, author_name: "A" }), 403, "comments_disabled");
  });
});

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, expectError, mintToken, publish } from "./helpers";

interface CommentJson {
  id: string;
  author: string;
  version: number;
  body: string;
  created_at: string;
  parent_id: string | null;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
}

async function publishArtifact(token: string): Promise<string> {
  const res = await publish({ token });
  return ((await res.json()) as { id: string }).id;
}

// Admin (Access-gated) write — the dev/test stub lets it through and reads the
// author from X-Access-Email.
async function addComment(id: string, body: string, email = "jane@team.com", parentId?: string) {
  return SELF.fetch(`${API_BASE}/v1/admin/artifacts/${id}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Access-Email": email },
    body: JSON.stringify(parentId ? { body, parent_id: parentId } : { body }),
  });
}

async function setResolved(cid: string, resolved: boolean, email = "lead@team.com") {
  return SELF.fetch(`${API_BASE}/v1/admin/comments/${cid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Access-Email": email },
    body: JSON.stringify({ resolved }),
  });
}

async function readComments(id: string, token: string, status?: string) {
  const q = status ? `?status=${status}` : "";
  return SELF.fetch(`${API_BASE}/v1/artifacts/${id}/comments${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("comments", () => {
  it("writes a comment (Access) with author from email, reads it back (token)", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);

    const add = await addComment(id, "tighten the intro", "reviewer@team.com");
    expect(add.status).toBe(201);
    const created = (await add.json()) as CommentJson;
    expect(created.author).toBe("reviewer@team.com");
    expect(created.version).toBe(1);
    expect(created.body).toBe("tighten the intro");

    const read = await readComments(id, tok.token);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { artifact_id: string; comments: CommentJson[] };
    expect(body.artifact_id).toBe(id);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].body).toBe("tighten the intro");
  });

  it("soft-deleted comments disappear from reads (idempotent delete)", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    const created = (await (await addComment(id, "remove me")).json()) as CommentJson;

    const del = await SELF.fetch(`${API_BASE}/v1/admin/comments/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    await SELF.fetch(`${API_BASE}/v1/admin/comments/${created.id}`, { method: "DELETE" }); // idempotent

    const body = (await (await readComments(id, tok.token)).json()) as { comments: CommentJson[] };
    expect(body.comments).toHaveLength(0);
  });

  it("rejects an oversized comment body", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    const huge = "x".repeat(8 * 1024 + 1);
    await expectError(await addComment(id, huge), 400, "invalid_request");
  });

  it("404 on unknown artifact for read and write", async () => {
    const tok = await mintToken();
    await expectError(await readComments("zzzzzzzzzzzzzz", tok.token), 404, "not_found");
    await expectError(await addComment("zzzzzzzzzzzzzz", "hi"), 404, "not_found");
  });

  it("409 when commenting on a deleted artifact", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    await SELF.fetch(`${API_BASE}/v1/artifacts/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    await expectError(await addComment(id, "too late"), 409, "not_active");
  });

  it("requires a token to read comments", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    const res = await SELF.fetch(`${API_BASE}/v1/artifacts/${id}/comments`);
    await expectError(res, 401, "unauthorized");
  });

  it("posts a reply with parent_id and reads the thread back in order", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    const root = (await (await addComment(id, "root note")).json()) as CommentJson;
    const reply = (await (await addComment(id, "a clarification", "b@team.com", root.id)).json()) as CommentJson;
    expect(reply.parent_id).toBe(root.id);

    const body = (await (await readComments(id, tok.token)).json()) as { comments: CommentJson[] };
    expect(body.comments.map((c) => c.body)).toEqual(["root note", "a clarification"]);
    expect(body.comments[0].parent_id).toBeNull();
    expect(body.comments[1].parent_id).toBe(root.id);
  });

  it("resolves and unresolves a thread, recording the resolver", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    const root = (await (await addComment(id, "needs work")).json()) as CommentJson;

    const resolved = (await (await setResolved(root.id, true, "lead@team.com")).json()) as CommentJson;
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolved_by).toBe("lead@team.com");
    expect(resolved.resolved_at).toBeTruthy();

    const reopened = (await (await setResolved(root.id, false)).json()) as CommentJson;
    expect(reopened.resolved).toBe(false);
    expect(reopened.resolved_at).toBeNull();
  });

  it("filters reads by ?status= and rejects a bogus value", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    await addComment(id, "open one");
    const done = (await (await addComment(id, "done one")).json()) as CommentJson;
    await setResolved(done.id, true);

    const openOnly = (await (await readComments(id, tok.token, "open")).json()) as { comments: CommentJson[] };
    expect(openOnly.comments.map((c) => c.body)).toEqual(["open one"]);
    const resolvedOnly = (await (await readComments(id, tok.token, "resolved")).json()) as { comments: CommentJson[] };
    expect(resolvedOnly.comments.map((c) => c.body)).toEqual(["done one"]);
    const all = (await (await readComments(id, tok.token)).json()) as { comments: CommentJson[] };
    expect(all.comments).toHaveLength(2);

    await expectError(await readComments(id, tok.token, "bogus"), 400, "invalid_request");
  });

  it("deleting a root cascades its replies out of the thread", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    const root = (await (await addComment(id, "root")).json()) as CommentJson;
    await addComment(id, "reply", "b@team.com", root.id);

    const del = await SELF.fetch(`${API_BASE}/v1/admin/comments/${root.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const body = (await (await readComments(id, tok.token)).json()) as { comments: CommentJson[] };
    expect(body.comments).toHaveLength(0);
  });

  it("rejects a reply whose parent is on another artifact, and 404s PATCH on unknown ids", async () => {
    const tok = await mintToken();
    const id = await publishArtifact(tok.token);
    const other = await publishArtifact(tok.token);
    const elsewhere = (await (await addComment(other, "root")).json()) as CommentJson;
    await expectError(await addComment(id, "reply", "b@team.com", elsewhere.id), 400, "invalid_request");
    await expectError(await setResolved("cmt_nope", true), 404, "not_found");
  });
});

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, expectError, mintToken, publish } from "./helpers";

interface CommentJson {
  id: string;
  author: string;
  version: number;
  body: string;
  created_at: string;
}

async function publishArtifact(token: string): Promise<string> {
  const res = await publish({ token });
  return ((await res.json()) as { id: string }).id;
}

// Admin (Access-gated) write — the dev/test stub lets it through and reads the
// author from X-Access-Email.
async function addComment(id: string, body: string, email = "jane@team.com") {
  return SELF.fetch(`${API_BASE}/v1/admin/artifacts/${id}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Access-Email": email },
    body: JSON.stringify({ body }),
  });
}

async function readComments(id: string, token: string) {
  return SELF.fetch(`${API_BASE}/v1/artifacts/${id}/comments`, {
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
});

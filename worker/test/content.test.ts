import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_BASE, expectError, mintToken, publish } from "./helpers";

interface Envelope {
  id: string;
  version: number;
  format: string;
  content_type: string;
  content: string;
}

async function publishProtected(token: string, passcode: string, body: string) {
  const res = await SELF.fetch(`${API_BASE}/v1/artifacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/markdown",
      "X-Snapdoc-Passcode": passcode,
    },
    body,
  });
  return (await res.json()) as { id: string };
}

function readContent(
  token: string | null,
  id: string,
  opts: { format?: string; version?: string; passcode?: string } = {},
) {
  const params = new URLSearchParams();
  if (opts.format !== undefined) params.set("format", opts.format);
  if (opts.version !== undefined) params.set("version", opts.version);
  const query = params.size ? `?${params}` : "";
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.passcode !== undefined) headers["X-Snapdoc-Passcode"] = opts.passcode;
  return SELF.fetch(`${API_BASE}/v1/artifacts/${id}/content${query}`, { headers });
}

async function publishMarkdown(token: string, body: string) {
  const res = await publish({ token, body, contentType: "text/markdown" });
  return ((await res.json()) as { id: string }).id;
}

describe("GET /v1/artifacts/:id/content", () => {
  it("returns reconstructed Markdown by default, without the HTML wrapper", async () => {
    const tok = await mintToken();
    const id = await publishMarkdown(tok.token, "# Title\n\n**bold** and `code`.");
    const res = await readContent(tok.token, id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.id).toBe(id);
    expect(body.format).toBe("md");
    expect(body.content_type).toBe("text/markdown");
    expect(body.content).toContain("# Title");
    expect(body.content).toContain("**bold**");
    expect(body.content).toContain("`code`");
    expect(body.content).not.toContain("<!doctype");
    expect(body.content).not.toContain("<style>");
  });

  it("returns the raw stored HTML with format=html", async () => {
    const tok = await mintToken();
    const id = await publishMarkdown(tok.token, "# Title\n\ntext");
    const res = await readContent(tok.token, id, { format: "html" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.format).toBe("html");
    expect(body.content_type).toBe("text/html");
    expect(body.content).toMatch(/^<!doctype html>/i);
    expect(body.content).toContain("<style>");
  });

  it("requires the passcode for a protected doc — a token alone is not enough", async () => {
    const tok = await mintToken();
    const { id } = await publishProtected(tok.token, "pw", "# secret");
    const res = await readContent(tok.token, id);
    await expectError(res, 401, "passcode_required");
  });

  it("rejects a wrong passcode", async () => {
    const tok = await mintToken();
    const { id } = await publishProtected(tok.token, "right", "# secret");
    const res = await readContent(tok.token, id, { passcode: "wrong" });
    await expectError(res, 401, "passcode_incorrect");
  });

  it("serves protected content when the correct passcode is supplied", async () => {
    const tok = await mintToken();
    const { id } = await publishProtected(tok.token, "letmein", "# secret heading");
    const res = await readContent(tok.token, id, { passcode: "letmein" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.content).toContain("# secret heading");
  });

  it("pins a specific version and reports the resolved version", async () => {
    const tok = await mintToken();
    const id = await publishMarkdown(tok.token, "# Version one");
    await publish({ token: tok.token, id, body: "# Version two", contentType: "text/markdown" });

    const latest = (await (await readContent(tok.token, id)).json()) as Envelope;
    expect(latest.version).toBe(2);
    expect(latest.content).toContain("# Version two");

    const pinned = (await (await readContent(tok.token, id, { version: "1" })).json()) as Envelope;
    expect(pinned.version).toBe(1);
    expect(pinned.content).toContain("# Version one");
  });

  it("rejects an invalid format or version", async () => {
    const tok = await mintToken();
    const id = await publishMarkdown(tok.token, "# Title");
    await expectError(await readContent(tok.token, id, { format: "pdf" }), 400, "invalid_request");
    await expectError(await readContent(tok.token, id, { version: "0" }), 400, "invalid_request");
    await expectError(await readContent(tok.token, id, { version: "abc" }), 400, "invalid_request");
  });

  it("returns gone for expired and deleted artifacts", async () => {
    const tok = await mintToken();
    const expiredId = await publishMarkdown(tok.token, "# soon gone");
    await SELF.fetch(`${API_BASE}/v1/artifacts/${expiredId}/expire`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    await expectError(await readContent(tok.token, expiredId), 410, "gone");

    const deletedId = await publishMarkdown(tok.token, "# delete me");
    await SELF.fetch(`${API_BASE}/v1/artifacts/${deletedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    await expectError(await readContent(tok.token, deletedId), 410, "gone");
  });

  it("returns not_found for an unknown artifact or version", async () => {
    const tok = await mintToken();
    await expectError(await readContent(tok.token, "doesNotExist99"), 404, "not_found");
    const id = await publishMarkdown(tok.token, "# Title");
    await expectError(await readContent(tok.token, id, { version: "99" }), 404, "not_found");
  });

  it("requires a valid bearer token", async () => {
    const tok = await mintToken();
    const id = await publishMarkdown(tok.token, "# Title");
    await expectError(await readContent(null, id), 401, "unauthorized");
  });
});

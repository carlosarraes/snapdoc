import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  API_BASE,
  ARTIFACT_BASE,
  GIF_BYTES,
  JPEG_BYTES,
  PNG_BYTES,
  SVG_BYTES,
  expectError,
  mintToken,
  publishMultipart,
  store,
} from "./helpers";

interface AssetJson {
  hash: string;
  content_type: string;
  size_bytes: number;
  url: string;
  created_at: string;
}

async function detail(token: string, id: string): Promise<{ assets: AssetJson[] }> {
  const res = await SELF.fetch(`${API_BASE}/v1/artifacts/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { assets: AssetJson[] };
}

async function servedHtml(id: string, cookie?: string): Promise<string> {
  const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}`, cookie ? { headers: { Cookie: cookie } } : undefined);
  return res.text();
}

describe("image hosting — publish + rewrite", () => {
  it("uploads a referenced image, hosts it, and rewrites the ref", async () => {
    const tok = await mintToken();
    const res = await publishMultipart({
      token: tok.token,
      doc: "# report\n\n![diagram](diagram.png)\n",
      docType: "text/markdown",
      assets: [{ ref: "diagram.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; unresolved_refs: string[] };
    expect(body.unresolved_refs).toEqual([]);

    const { assets } = await detail(tok.token, body.id);
    expect(assets).toHaveLength(1);
    expect(assets[0].content_type).toBe("image/png");
    expect(assets[0].size_bytes).toBe(PNG_BYTES.byteLength);
    expect(assets[0].url).toBe(`${ARTIFACT_BASE}/${body.id}/a/${assets[0].hash}`);

    const html = await servedHtml(body.id);
    expect(html).toContain(`${ARTIFACT_BASE}/${body.id}/a/${assets[0].hash}`);
    expect(html).not.toContain("diagram.png");
  });

  it("matches refs in subdirectories", async () => {
    const tok = await mintToken();
    const res = await publishMultipart({
      token: tok.token,
      doc: '<img src="shots/a.png">',
      assets: [{ ref: "shots/a.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; unresolved_refs: string[] };
    expect(body.unresolved_refs).toEqual([]);
    const html = await servedHtml(body.id);
    expect(html).not.toContain('src="shots/a.png"');
  });

  it("leaves remote and data refs untouched, rewrites only local ones", async () => {
    const tok = await mintToken();
    const doc = [
      '<img src="https://example.com/remote.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="local.png">',
    ].join("\n");
    const res = await publishMultipart({
      token: tok.token,
      doc,
      docType: "text/html",
      assets: [{ ref: "local.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const html = await servedHtml(id);
    expect(html).toContain("https://example.com/remote.png");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).not.toContain('src="local.png"');
  });

  it("reports local refs with no uploaded file in unresolved_refs", async () => {
    const tok = await mintToken();
    const res = await publishMultipart({
      token: tok.token,
      doc: '<img src="here.png"><img src="missing.png">',
      docType: "text/html",
      assets: [{ ref: "here.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; unresolved_refs: string[] };
    expect(body.unresolved_refs).toEqual(["missing.png"]);
    const html = await servedHtml(body.id);
    expect(html).toContain('src="missing.png"');
  });
});

describe("image hosting — serving", () => {
  async function publishOne(token: string, passcode?: string) {
    const res = await publishMultipart({
      token,
      doc: '<img src="a.png">',
      docType: "text/html",
      assets: [{ ref: "a.png", bytes: PNG_BYTES, contentType: "image/png" }],
      passcode,
    });
    const { id } = (await res.json()) as { id: string };
    const { assets } = await detail(token, id);
    return { id, hash: assets[0].hash };
  }

  it("serves the asset with an immutable cache and nosniff", async () => {
    const tok = await mintToken();
    const { id, hash } = await publishOne(tok.token);

    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}/a/${hash}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);

    const head = await SELF.fetch(`${ARTIFACT_BASE}/${id}/a/${hash}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(PNG_BYTES.byteLength));
  });

  it("accepts the version-pinned asset path", async () => {
    const tok = await mintToken();
    const { id, hash } = await publishOne(tok.token);
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}/v/1/a/${hash}`);
    expect(res.status).toBe(200);
  });

  it("404s an unknown hash", async () => {
    const tok = await mintToken();
    const { id } = await publishOne(tok.token);
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${id}/a/${"0".repeat(64)}`);
    expect(res.status).toBe(404);
  });

  it("gates assets behind the artifact passcode", async () => {
    const tok = await mintToken();
    const { id, hash } = await publishOne(tok.token, "letmein");

    const locked = await SELF.fetch(`${ARTIFACT_BASE}/${id}/a/${hash}`);
    expect(locked.status).toBe(401);

    const unlock = await SELF.fetch(`${ARTIFACT_BASE}/${id}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: "letmein" }),
      redirect: "manual",
    });
    const cookie = (unlock.headers.get("Set-Cookie") ?? "").split(";")[0];

    const unlocked = await SELF.fetch(`${ARTIFACT_BASE}/${id}/a/${hash}`, { headers: { Cookie: cookie } });
    expect(unlocked.status).toBe(200);
    expect(unlocked.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("image hosting — lifecycle", () => {
  it("410s assets once the artifact is expired", async () => {
    const tok = await mintToken();
    const res = await publishMultipart({
      token: tok.token,
      doc: '<img src="a.png">',
      assets: [{ ref: "a.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    const { id } = (await res.json()) as { id: string };
    const { assets } = await detail(tok.token, id);
    await SELF.fetch(`${API_BASE}/v1/artifacts/${id}/expire`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    const view = await SELF.fetch(`${ARTIFACT_BASE}/${id}/a/${assets[0].hash}`);
    expect(view.status).toBe(410);
  });

  it("purges the asset object on delete", async () => {
    const tok = await mintToken();
    const res = await publishMultipart({
      token: tok.token,
      doc: '<img src="a.png">',
      assets: [{ ref: "a.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    const { id } = (await res.json()) as { id: string };
    const { assets } = await detail(tok.token, id);
    const hash = assets[0].hash;
    expect(await store().getServableAsset(id, hash)).not.toBeNull();

    await SELF.fetch(`${API_BASE}/v1/artifacts/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    expect(await store().getServableAsset(id, hash)).toBeNull();
    const view = await SELF.fetch(`${ARTIFACT_BASE}/${id}/a/${hash}`);
    expect(view.status).toBe(410);
  });
});

describe("image hosting — limits + validation", () => {
  it("rejects an oversized image", async () => {
    const tok = await mintToken();
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG_BYTES);
    const res = await publishMultipart({
      token: tok.token,
      doc: '<img src="big.png">',
      assets: [{ ref: "big.png", bytes: big, contentType: "image/png" }],
    });
    await expectError(res, 413, "too_large");
  });

  it("rejects more than the max image count", async () => {
    const tok = await mintToken();
    const assets = Array.from({ length: 21 }, (_, i) => ({ ref: `i${i}.png`, bytes: PNG_BYTES, contentType: "image/png" }));
    const res = await publishMultipart({ token: tok.token, doc: "<p>x</p>", assets });
    await expectError(res, 400, "too_many_assets");
  });

  it("rejects SVG and other non-raster types", async () => {
    const tok = await mintToken();
    const res = await publishMultipart({
      token: tok.token,
      doc: '<img src="x.svg">',
      assets: [{ ref: "x.svg", bytes: SVG_BYTES, contentType: "image/svg+xml" }],
    });
    await expectError(res, 400, "unsupported_content_type");
  });

  it("accepts jpeg and gif alongside png", async () => {
    const tok = await mintToken();
    const res = await publishMultipart({
      token: tok.token,
      doc: '<img src="a.jpg"><img src="b.gif">',
      assets: [
        { ref: "a.jpg", bytes: JPEG_BYTES, contentType: "image/jpeg" },
        { ref: "b.gif", bytes: GIF_BYTES, contentType: "image/gif" },
      ],
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const { assets } = await detail(tok.token, id);
    expect(assets.map((a) => a.content_type).sort()).toEqual(["image/gif", "image/jpeg"]);
  });
});

describe("image hosting — versions + read-back", () => {
  it("dedupes an identical image across versions", async () => {
    const tok = await mintToken();
    const v1 = await publishMultipart({
      token: tok.token,
      doc: '<img src="a.png">',
      assets: [{ ref: "a.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    const { id } = (await v1.json()) as { id: string };
    const v2 = await publishMultipart({
      token: tok.token,
      id,
      doc: '<p>v2</p><img src="a.png">',
      assets: [{ ref: "a.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    expect(v2.status).toBe(201);

    const { assets } = await detail(tok.token, id);
    expect(assets).toHaveLength(1);
    const v1Html = await (await SELF.fetch(`${ARTIFACT_BASE}/${id}/v/1`)).text();
    const v2Html = await (await SELF.fetch(`${ARTIFACT_BASE}/${id}/v/2`)).text();
    expect(v1Html).toContain(`/a/${assets[0].hash}`);
    expect(v2Html).toContain(`/a/${assets[0].hash}`);
  });

  it("returns the hosted image URL in markdown read-back", async () => {
    const tok = await mintToken();
    const res = await publishMultipart({
      token: tok.token,
      doc: "![diagram](diagram.png)\n",
      docType: "text/markdown",
      assets: [{ ref: "diagram.png", bytes: PNG_BYTES, contentType: "image/png" }],
    });
    const { id } = (await res.json()) as { id: string };
    const { assets } = await detail(tok.token, id);

    const read = await SELF.fetch(`${API_BASE}/v1/artifacts/${id}/content?format=md`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    const content = ((await read.json()) as { content: string }).content;
    expect(content).toContain(`/a/${assets[0].hash}`);
  });
});

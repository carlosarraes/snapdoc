import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BASE,
  JPEG_BYTES,
  mintToken,
  PNG_BYTES,
  publish,
  publishVideo,
  uploadPoster,
  videoFixtureBytes,
} from "./helpers";

interface VideoArtifactJson {
  id: string;
  file_url: string;
  version_url: string;
  version_file_url: string;
  poster_url: string | null;
  version_poster_url: string | null;
  has_passcode: boolean;
  current_version: number;
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

async function publishedVideo(opts: { title?: string; filename?: string; passcode?: string } = {}) {
  const tok = await mintToken();
  const bytes = videoFixtureBytes();
  const res = await publishVideo({ token: tok.token, ...opts });
  expect(res.status).toBe(201);
  const art = (await res.json()) as VideoArtifactJson;
  return { tok: tok.token, art, bytes };
}

function cookieFor(setCookie: string | null, id: string): string {
  const name = `sd_unlock_${id}`;
  const part = (setCookie ?? "").split(";")[0];
  expect(part.startsWith(`${name}=`)).toBe(true);
  return part;
}

describe("video media byte ranges", () => {
  it("streams the whole file with no Range header", async () => {
    const { art, bytes } = await publishedVideo();
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it("answers HEAD with the same headers and an empty body", async () => {
    const { art, bytes } = await publishedVideo();
    const head = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Accept-Ranges")).toBe("bytes");
    expect(head.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(head.headers.get("Content-Type")).toBe("video/mp4");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("answers HEAD with a valid Range identically to GET, minus the body", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const get = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, { headers: { Range: "bytes=0-9" } });
    const head = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      method: "HEAD",
      headers: { Range: "bytes=0-9" },
    });
    expect(head.status).toBe(get.status);
    expect(head.status).toBe(206);
    expect(head.headers.get("Content-Range")).toBe(get.headers.get("Content-Range"));
    expect(head.headers.get("Content-Range")).toBe(`bytes 0-9/${size}`);
    expect(head.headers.get("Content-Length")).toBe(get.headers.get("Content-Length"));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("serves a standard byte range", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const partial = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      headers: { Range: "bytes=0-9" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe(`bytes 0-9/${size}`);
    expect(partial.headers.get("Content-Length")).toBe("10");
    const body = new Uint8Array(await partial.arrayBuffer());
    expect(body).toEqual(bytes.slice(0, 10));
  });

  it("serves an open-ended byte range", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      headers: { Range: "bytes=10-" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 10-${size - 1}/${size}`);
    expect(res.headers.get("Content-Length")).toBe(String(size - 10));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(bytes.slice(10));
  });

  it("serves a suffix byte range", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      headers: { Range: "bytes=-10" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    expect(res.headers.get("Content-Length")).toBe("10");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(bytes.slice(size - 10));
  });

  it("clamps a range end that extends beyond EOF", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      headers: { Range: `bytes=0-${size + 999}` },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-${size - 1}/${size}`);
    expect(res.headers.get("Content-Length")).toBe(String(size));
  });

  it("rejects a syntactically invalid range as unsatisfiable", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const bad = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      headers: { Range: "bytes=abc-def" },
    });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe(`bytes */${size}`);
  });

  it("rejects multiple ranges as unsatisfiable", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      headers: { Range: "bytes=0-9,20-29" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${size}`);
  });

  it("rejects an overflowing start as unsatisfiable", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      headers: { Range: `bytes=${size + 1000}-` },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${size}`);
  });

  it("rejects a reversed/zero-size range as unsatisfiable", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      headers: { Range: "bytes=10-5" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${size}`);
  });

  it("HEAD returns the same 416 headers with no body for an invalid range", async () => {
    const { art, bytes } = await publishedVideo();
    const size = bytes.byteLength;
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, {
      method: "HEAD",
      headers: { Range: "bytes=abc-def" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${size}`);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects non-GET/HEAD methods", async () => {
    const { art } = await publishedVideo();
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });
});

describe("video media filename matching", () => {
  it("404s when the URL filename doesn't match the stored version metadata", async () => {
    const { art } = await publishedVideo({ filename: "clip.mp4" });
    const wrongPath = pathOf(art.file_url).replace("clip.mp4", "other.mp4");
    const res = await SELF.fetch(`${ARTIFACT_BASE}${wrongPath}`);
    expect(res.status).toBe(404);
  });

  it("404s a media request against a document artifact id", async () => {
    const tok = await mintToken();
    const doc = (await (await publish({ token: tok.token })).json()) as { id: string };
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${doc.id}/media/recording.mp4`);
    expect(res.status).toBe(404);
  });
});

describe("video version pinning", () => {
  it("serves each version's own media bytes at /:id/v/:n/media/:filename", async () => {
    const { tok, art, bytes: v1Bytes } = await publishedVideo({ filename: "v1.mp4" });
    const v2Bytes = videoFixtureBytes();
    const v2Res = await publishVideo({ token: tok, id: art.id, filename: "v2.mp4" });
    const v2 = (await v2Res.json()) as VideoArtifactJson;
    expect(v2.current_version).toBe(2);

    const v1Fetch = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/v/1/media/v1.mp4`);
    expect(v1Fetch.status).toBe(200);
    expect(new Uint8Array(await v1Fetch.arrayBuffer())).toEqual(v1Bytes);

    const v2Fetch = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/v/2/media/v2.mp4`);
    expect(v2Fetch.status).toBe(200);
    expect(new Uint8Array(await v2Fetch.arrayBuffer())).toEqual(v2Bytes);

    // The pinned filename must match that specific version, not any version.
    const mismatched = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/v/1/media/v2.mp4`);
    expect(mismatched.status).toBe(404);

    const missingVersion = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/v/99/media/v1.mp4`);
    expect(missingVersion.status).toBe(404);
  });

  it("pins the watch page to a specific version's media/poster URLs", async () => {
    const { tok, art } = await publishedVideo({ filename: "v1.mp4" });
    await publishVideo({ token: tok, id: art.id, filename: "v2.mp4" });

    const pinned = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/v/1`);
    expect(pinned.status).toBe(200);
    const html = await pinned.text();
    expect(html).toContain(`/${art.id}/v/1/media/v1.mp4`);
    expect(html).not.toContain(`/${art.id}/v/1/media/v2.mp4`);

    const current = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    const currentHtml = await current.text();
    expect(currentHtml).toContain(`/${art.id}/media/v2.mp4`);
  });
});

describe("video watch page", () => {
  it("renders a trusted page with the video element, escaping a hostile title", async () => {
    const { art } = await publishedVideo({ title: "<script>alert(1)</script>" });
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<video controls preload="metadata">');
    expect(html).toContain(pathOf(art.file_url));
    expect(html).toContain("Download");

    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("media-src 'self'");
    expect(csp).toContain("img-src 'self'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("escapes a hostile filename too", async () => {
    // sanitizeVideoFilename strips HTML-hostile characters, but the page
    // must still be defensive about anything it renders as text.
    const { art } = await publishedVideo({ filename: '"><img src=x onerror=alert(1)>.mp4' });
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    const html = await res.text();
    expect(html).not.toContain("onerror=alert(1)");
  });

  it("shows a poster attribute when the version has a poster", async () => {
    const { tok, art } = await publishedVideo();
    await uploadPoster({ token: tok, id: art.id, version: 1, bytes: JPEG_BYTES, contentType: "image/jpeg" });
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    const html = await res.text();
    expect(html).toContain(`poster="https://snapdoc.carraes.dev/${art.id}/poster.jpg"`);
  });

  it("omits the poster attribute when there is none", async () => {
    const { art } = await publishedVideo();
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    const html = await res.text();
    expect(html).not.toContain("poster=");
  });

  it("404s for an unknown video id", async () => {
    const res = await SELF.fetch(`${ARTIFACT_BASE}/AAAAAAAAAAAAAA`);
    expect(res.status).toBe(404);
  });

  it("rejects non-GET/HEAD methods", async () => {
    const { art } = await publishedVideo();
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`, { method: "POST", body: "x" });
    expect(res.status).toBe(405);
  });
});

describe("video posters", () => {
  it("serves a JPEG poster at /:id/poster.jpg", async () => {
    const { tok, art } = await publishedVideo();
    const uploadRes = await uploadPoster({ token: tok, id: art.id, version: 1, bytes: JPEG_BYTES, contentType: "image/jpeg" });
    const uploaded = (await uploadRes.json()) as { poster_url: string };
    expect(uploaded.poster_url).toBe(`https://snapdoc.carraes.dev/${art.id}/poster.jpg`);

    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(uploaded.poster_url)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    expect(res.headers.get("Content-Length")).toBe(String(JPEG_BYTES.byteLength));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(JPEG_BYTES);
  });

  it("serves a PNG poster at /:id/poster.png", async () => {
    const { tok, art } = await publishedVideo();
    const uploadRes = await uploadPoster({ token: tok, id: art.id, version: 1, bytes: PNG_BYTES, contentType: "image/png" });
    const uploaded = (await uploadRes.json()) as { poster_url: string };
    expect(uploaded.poster_url).toBe(`https://snapdoc.carraes.dev/${art.id}/poster.png`);
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(uploaded.poster_url)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });

  it("404s when the URL extension doesn't match the stored poster type", async () => {
    const { tok, art } = await publishedVideo();
    await uploadPoster({ token: tok, id: art.id, version: 1, bytes: JPEG_BYTES, contentType: "image/jpeg" });
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/poster.png`);
    expect(res.status).toBe(404);
  });

  it("404s when the version has no poster", async () => {
    const { art } = await publishedVideo();
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/poster.jpg`);
    expect(res.status).toBe(404);
  });
});

describe("video passcode protection", () => {
  it("returns 401 for media without an unlock cookie, and streams once unlocked", async () => {
    const { art } = await publishedVideo({ passcode: "hunter2" });
    expect(art.has_passcode).toBe(true);

    const denied = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const unlock = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ passcode: "hunter2" }),
      redirect: "manual",
    });
    const cookie = cookieFor(unlock.headers.get("Set-Cookie"), art.id);

    const allowed = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`, { headers: { Cookie: cookie } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns 401 for a protected poster without a cookie", async () => {
    const { tok, art } = await publishedVideo({ passcode: "hunter2" });
    await uploadPoster({ token: tok, id: art.id, version: 1, bytes: JPEG_BYTES, contentType: "image/jpeg" });
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}/poster.jpg`);
    expect(res.status).toBe(401);
  });

  it("shows the unlock form (not the video) for the watch page without a cookie", async () => {
    const { art } = await publishedVideo({ passcode: "hunter2", title: "secret clip" });
    const res = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="/${art.id}/unlock"`);
    expect(html).not.toContain("secret clip");
  });
});

describe("video public CORS and caching", () => {
  it("exposes Access-Control-Allow-Origin on unprotected media and posters", async () => {
    const { tok, art } = await publishedVideo();
    const posterRes = await uploadPoster({ token: tok, id: art.id, version: 1, bytes: JPEG_BYTES, contentType: "image/jpeg" });
    const poster = (await posterRes.json()) as { poster_url: string };

    const media = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`);
    expect(media.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const posterFetch = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(poster.poster_url)}`);
    expect(posterFetch.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("caps Cache-Control at 60s max-age and is never immutable", async () => {
    const { art } = await publishedVideo();
    const res = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`);
    const cacheControl = res.headers.get("Cache-Control")!;
    expect(cacheControl).not.toContain("immutable");
    const match = /^public, max-age=(\d+)$/.exec(cacheControl);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(60);
  });

  it("never caches past the artifact's remaining TTL", async () => {
    const { art } = await publishedVideo();
    // Fast-forward the artifact to a short remaining TTL, mirroring the
    // direct-DB-write pattern other Store tests use to simulate near-expiry
    // states without waiting real time.
    await env.DB.prepare("UPDATE artifacts SET expires_at = ?1 WHERE id = ?2")
      .bind(new Date(Date.now() + 10_000).toISOString(), art.id)
      .run();

    const media = await SELF.fetch(`${ARTIFACT_BASE}${pathOf(art.file_url)}`);
    const mediaMatch = /^public, max-age=(\d+)$/.exec(media.headers.get("Cache-Control")!);
    expect(mediaMatch).not.toBeNull();
    expect(Number(mediaMatch![1])).toBeLessThanOrEqual(10);

    const watch = await SELF.fetch(`${ARTIFACT_BASE}/${art.id}`);
    const watchMatch = /^public, max-age=(\d+)$/.exec(watch.headers.get("Cache-Control")!);
    expect(watchMatch).not.toBeNull();
    expect(Number(watchMatch![1])).toBeLessThanOrEqual(10);
  });
});

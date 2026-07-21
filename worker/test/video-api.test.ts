import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  API_BASE,
  JPEG_BYTES,
  PNG_BYTES,
  expectError,
  mintToken,
  publish,
  publishVideo,
  unsupportedCodecVideoFixtureBytes,
  uploadPoster,
  videoFixtureBytes,
} from "./helpers";

interface VideoArtifactJson {
  id: string;
  kind: string;
  url: string;
  file_url: string;
  version_url: string;
  version_file_url: string;
  poster_url: string | null;
  version_poster_url: string | null;
  title: string | null;
  status: string;
  current_version: number;
  content_type: string;
  size_bytes: number;
  duration_ms: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  created_at: string;
  expires_at: string;
  has_passcode: boolean;
  comments_enabled: boolean;
}

describe("POST /v1/artifacts (video)", () => {
  it("publishes an MP4 and returns additive video URLs and metadata", async () => {
    const tok = await mintToken();
    const bytes = videoFixtureBytes();
    const res = await publishVideo({ token: tok.token, title: "QA clip", filename: "checkout flow.mp4" });
    expect(res.status).toBe(201);
    const art = (await res.json()) as VideoArtifactJson;

    expect(art.kind).toBe("video");
    expect(art.id).toMatch(/^[A-Za-z0-9_-]{14}$/);
    expect(art.url).toBe(`https://snapdoc.carraes.dev/${art.id}`);
    expect(art.file_url).toBe(`https://snapdoc.carraes.dev/${art.id}/media/checkout-flow.mp4`);
    expect(art.version_url).toBe(`https://snapdoc.carraes.dev/${art.id}/v/1`);
    expect(art.version_file_url).toBe(`https://snapdoc.carraes.dev/${art.id}/v/1/media/checkout-flow.mp4`);
    expect(art.poster_url).toBeNull();
    expect(art.version_poster_url).toBeNull();
    expect(art.title).toBe("QA clip");
    expect(art.status).toBe("active");
    expect(art.current_version).toBe(1);
    expect(art.content_type).toBe("video/mp4");
    expect(art.size_bytes).toBe(bytes.byteLength);
    expect(art.duration_ms).toBe(1000);
    expect(art.width).toBe(320);
    expect(art.height).toBe(180);
    expect(art.video_codec).toBe("h264");
    expect(art.audio_codec).toBe("aac");
    expect(art.comments_enabled).toBe(false);
    expect(art.has_passcode).toBe(false);
  });

  it("defaults the video TTL to three days", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token });
    const art = (await res.json()) as VideoArtifactJson;
    const expiresIn = new Date(art.expires_at).getTime() - new Date(art.created_at).getTime();
    expect(expiresIn).toBe(3 * 86400 * 1000);
  });

  it("accepts the 1h minimum and 7d maximum video TTL", async () => {
    const tok = await mintToken();
    for (const ttl of ["1h", "7d"]) {
      const res = await publishVideo({ token: tok.token, ttl });
      expect(res.status).toBe(201);
    }
  });

  it("rejects a video TTL above the 7-day maximum", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token, ttl: "8d" });
    await expectError(res, 400, "invalid_ttl");
  });

  it("rejects a video TTL below the 1-hour minimum", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token, ttl: "30m" });
    await expectError(res, 400, "invalid_ttl");
  });

  it("rejects a missing Content-Length", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token, contentLength: null });
    await expectError(res, 400, "invalid_request");
  });

  it("rejects a declared Content-Length over the video size cap without streaming it", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token, contentLength: 100_000_001 });
    await expectError(res, 413, "too_large");
  });

  it("rejects comments=1 for a video publish", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token, comments: true });
    await expectError(res, 400, "invalid_request");
  });

  it("rejects a malformed upload with a stable error code and no parser internals in the message", async () => {
    const tok = await mintToken();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const res = await publishVideo({ token: tok.token, bytes });
    const body = await expectError(res, 400, "invalid_video");
    // The MP4 inspector's own message ("missing ftyp box", "mp4box error
    // (...)", etc.) must never reach the client — only this stable string.
    expect(body.error.message).toBe("The uploaded file is not a valid MP4 video.");
    expect(body.error.message).not.toMatch(/mp4box|box/i);
  });

  it("rejects an unsupported (VP9) video codec with a stable error code and no parser internals in the message", async () => {
    const tok = await mintToken();
    const bytes = unsupportedCodecVideoFixtureBytes();
    const res = await publishVideo({ token: tok.token, bytes });
    const body = await expectError(res, 400, "unsupported_video_codec");
    expect(body.error.message).toBe("The video must be H.264 with optional AAC audio.");
    expect(body.error.message).not.toMatch(/mp4box|codec: |avc1|vp09/i);
  });

  it("publishes with a passcode", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token, passcode: "letmein" });
    expect(res.status).toBe(201);
    const art = (await res.json()) as VideoArtifactJson;
    expect(art.has_passcode).toBe(true);
  });

  it("sanitizes the filename and falls back to a default when omitted", async () => {
    const tok = await mintToken();
    const res = await publishVideo({ token: tok.token });
    const art = (await res.json()) as VideoArtifactJson;
    expect(art.file_url).toBe(`https://snapdoc.carraes.dev/${art.id}/media/recording.mp4`);
  });
});

describe("POST /v1/artifacts/{id}/versions (video)", () => {
  it("adds a video version, resetting expiry from upload time", async () => {
    const tok = await mintToken();
    const created = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    const res = await publishVideo({ token: tok.token, id: created.id, title: "v2" });
    expect(res.status).toBe(201);
    const updated = (await res.json()) as VideoArtifactJson;
    expect(updated.id).toBe(created.id);
    expect(updated.current_version).toBe(2);
    expect(updated.version_url).toBe(`https://snapdoc.carraes.dev/${created.id}/v/2`);
    expect(new Date(updated.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns kind_mismatch when posting a video version onto a document artifact", async () => {
    const tok = await mintToken();
    const doc = (await (await publish({ token: tok.token })).json()) as { id: string };
    const res = await publishVideo({ token: tok.token, id: doc.id });
    await expectError(res, 400, "kind_mismatch");
  });

  it("returns kind_mismatch when posting a document version onto a video artifact", async () => {
    const tok = await mintToken();
    const video = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    const res = await publish({ token: tok.token, id: video.id });
    await expectError(res, 400, "kind_mismatch");
  });
});

describe("GET /v1/artifacts/{id} (video)", () => {
  it("lists video versions with their own watch/file/poster/metadata fields", async () => {
    const tok = await mintToken();
    const created = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    await publishVideo({ token: tok.token, id: created.id });

    const res = await SELF.fetch(`${API_BASE}/v1/artifacts/${created.id}`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: VideoArtifactJson;
      versions: Array<{
        version: number;
        kind: string;
        version_url: string;
        version_file_url: string;
        version_poster_url: string | null;
        duration_ms: number;
        width: number;
        height: number;
        video_codec: string;
        audio_codec: string | null;
      }>;
    };

    expect(body.artifact.kind).toBe("video");
    expect(body.artifact.current_version).toBe(2);
    expect(body.versions.map((v) => v.version)).toEqual([1, 2]);
    for (const v of body.versions) {
      expect(v.kind).toBe("video");
      expect(v.version_url).toBe(`https://snapdoc.carraes.dev/${created.id}/v/${v.version}`);
      expect(v.version_file_url).toBe(`https://snapdoc.carraes.dev/${created.id}/v/${v.version}/media/recording.mp4`);
      expect(v.duration_ms).toBe(1000);
      expect(v.width).toBe(320);
      expect(v.height).toBe(180);
      expect(v.video_codec).toBe("h264");
      expect(v.audio_codec).toBe("aac");
    }
  });
});

describe("GET /v1/artifacts (list, video)", () => {
  it("includes additive video fields for video artifacts alongside documents", async () => {
    const tok = await mintToken();
    const video = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    const doc = (await (await publish({ token: tok.token })).json()) as { id: string; kind: string };

    const res = await SELF.fetch(`${API_BASE}/v1/artifacts`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: VideoArtifactJson[] };
    const videoEntry = body.artifacts.find((a) => a.id === video.id)!;
    const docEntry = body.artifacts.find((a) => a.id === doc.id)! as unknown as { kind: string; file_url?: string };

    expect(videoEntry.kind).toBe("video");
    expect(videoEntry.file_url).toBe(`https://snapdoc.carraes.dev/${video.id}/media/recording.mp4`);
    expect(docEntry.kind).toBe("document");
    expect(docEntry.file_url).toBeUndefined();
  });
});

describe("PUT /v1/artifacts/{id}/versions/{version}/poster", () => {
  it("uploads a poster and returns the updated version metadata plus current URLs", async () => {
    const tok = await mintToken();
    const created = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;

    const res = await uploadPoster({ token: tok.token, id: created.id, version: 1, bytes: JPEG_BYTES });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      version_poster_url: string;
      poster_url: string;
      file_url: string;
      url: string;
    };
    expect(body.version).toBe(1);
    expect(body.version_poster_url).toBe(`https://snapdoc.carraes.dev/${created.id}/v/1/poster.jpg`);
    // Version 1 is still the current version, so the stable (non-versioned)
    // URLs are refreshed too.
    expect(body.poster_url).toBe(`https://snapdoc.carraes.dev/${created.id}/poster.jpg`);
    expect(body.url).toBe(`https://snapdoc.carraes.dev/${created.id}`);
    expect(body.file_url).toBe(`https://snapdoc.carraes.dev/${created.id}/media/recording.mp4`);
  });

  it("replaces a poster and reports the new extension", async () => {
    const tok = await mintToken();
    const created = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    await uploadPoster({ token: tok.token, id: created.id, version: 1, bytes: JPEG_BYTES });
    const res = await uploadPoster({
      token: tok.token,
      id: created.id,
      version: 1,
      bytes: PNG_BYTES,
      contentType: "image/png",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { poster_url: string };
    expect(body.poster_url).toBe(`https://snapdoc.carraes.dev/${created.id}/poster.png`);
  });

  it("rejects bytes that don't sniff as the declared image type", async () => {
    const tok = await mintToken();
    const created = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    const res = await uploadPoster({
      token: tok.token,
      id: created.id,
      version: 1,
      bytes: new Uint8Array([1, 2, 3]),
    });
    await expectError(res, 400, "invalid_request");
  });

  it("rejects a poster over the size cap without buffering an oversized body", async () => {
    const tok = await mintToken();
    const created = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    const res = await uploadPoster({
      token: tok.token,
      id: created.id,
      version: 1,
      bytes: JPEG_BYTES,
      contentLength: 5 * 1024 * 1024 + 1,
    });
    await expectError(res, 413, "too_large");
  });

  it("404s on an unknown version", async () => {
    const tok = await mintToken();
    const created = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    const res = await uploadPoster({ token: tok.token, id: created.id, version: 99, bytes: JPEG_BYTES });
    await expectError(res, 404, "not_found");
  });

  it("returns kind_mismatch for a document artifact", async () => {
    const tok = await mintToken();
    const doc = (await (await publish({ token: tok.token })).json()) as { id: string };
    const res = await uploadPoster({ token: tok.token, id: doc.id, version: 1, bytes: JPEG_BYTES });
    await expectError(res, 400, "kind_mismatch");
  });
});

describe("GET /v1/artifacts/{id}/content (video rejection)", () => {
  it("rejects reading video content as text, pointing at the watch/file URLs instead", async () => {
    const tok = await mintToken();
    const created = (await (await publishVideo({ token: tok.token })).json()) as VideoArtifactJson;
    const res = await SELF.fetch(`${API_BASE}/v1/artifacts/${created.id}/content`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    const body = await expectError(res, 400, "invalid_request");
    expect(body.error.message).toMatch(/watch|file URL/i);
  });
});

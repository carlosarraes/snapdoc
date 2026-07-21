import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_BASE, mintToken, store } from "./helpers";

const DAY = 86400;

async function runScheduled() {
  const { default: worker } = await import("../src/index");
  const controller = { scheduledTime: Date.now(), cron: "0 * * * *", noRetry() {} } as ScheduledController;
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  await worker.scheduled(controller, env, ctx);
}

// Same base64-fixture pattern as test/video.test.ts and test/store.test.ts:
// the workers pool runtime has no filesystem access.
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

describe("scheduled cleanup", () => {
  it("expires past-expiry artifacts so they stop serving, keeps live ones, and is idempotent", async () => {
    const s = store();
    const tok = await mintToken();
    const live = await s.createArtifact({
      tokenId: tok.id, title: null, ttlSeconds: 14 * DAY, contentType: "text/html", body: "<p>live</p>",
    });
    const pastExpiry = await s.createArtifact({
      tokenId: tok.id, title: null, ttlSeconds: -3600, contentType: "text/html", body: "<p>old</p>",
    });
    const longGone = await s.createArtifact({
      tokenId: tok.id, title: null, ttlSeconds: -30 * DAY, contentType: "text/html", body: "<p>gone</p>",
    });

    await runScheduled();
    await runScheduled(); // idempotent

    expect((await SELF.fetch(`${ARTIFACT_BASE}/${live.id}`)).status).toBe(200);
    expect((await SELF.fetch(`${ARTIFACT_BASE}/${pastExpiry.id}`)).status).toBe(410);
    expect((await SELF.fetch(`${ARTIFACT_BASE}/${longGone.id}`)).status).toBe(410);

    expect((await s.getArtifact(pastExpiry.id))?.artifact.status).toBe("expired");
    // Blobs past the retention grace period are purged; recent ones retained.
    expect(await env.BLOBS.get(`artifacts/${longGone.id}/v1`)).toBeNull();
    expect(await env.BLOBS.get(`artifacts/${pastExpiry.id}/v1`)).not.toBeNull();
    expect(await env.BLOBS.get(`artifacts/${live.id}/v1`)).not.toBeNull();
  });

  it("trims comment_events older than the rate-limit window, keeping recent ones", async () => {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare("INSERT INTO comment_events (ip_hash, artifact_id, created_at) VALUES (?1, ?2, ?3)")
      .bind("ip-old", "art", old)
      .run();
    await env.DB.prepare("INSERT INTO comment_events (ip_hash, artifact_id, created_at) VALUES (?1, ?2, ?3)")
      .bind("ip-new", "art", recent)
      .run();

    await runScheduled();

    const { results } = await env.DB.prepare("SELECT ip_hash FROM comment_events").all<{ ip_hash: string }>();
    expect(results.map((r) => r.ip_hash)).toEqual(["ip-new"]);
  });

  it("purges an expired video's blobs immediately through the full scheduled handler, unlike a document's grace period", async () => {
    const s = store();
    const tok = await mintToken();
    const bytes = decodeBase64(env.FIXTURE_VIDEO_H264_AAC_B64);
    const video = await s.createVideoArtifact({
      tokenId: tok.id,
      title: null,
      ttlSeconds: -60, // already expired
      filename: "clip.mp4",
      contentLength: bytes.byteLength,
      maxDurationMs: 600_000,
      body: new Blob([bytes]).stream(),
    });
    const doc = await s.createArtifact({
      tokenId: tok.id, title: null, ttlSeconds: -60, contentType: "text/html", body: "<p>old</p>",
    });

    await runScheduled();

    expect((await SELF.fetch(`${ARTIFACT_BASE}/${video.id}`)).status).toBe(410);
    expect(await env.BLOBS.get(`artifacts/${video.id}/v1`)).toBeNull();
    // Document blobs still get the retention grace period.
    expect(await env.BLOBS.get(`artifacts/${doc.id}/v1`)).not.toBeNull();
  });

  it("runs the orphan video blob audit as part of the full scheduled handler, removing a stale unreferenced key while a referenced one survives", async () => {
    const s = store();
    const tok = await mintToken();
    const bytes = decodeBase64(env.FIXTURE_VIDEO_H264_AAC_B64);
    const video = await s.createVideoArtifact({
      tokenId: tok.id,
      title: null,
      ttlSeconds: 14 * DAY,
      filename: "clip.mp4",
      contentLength: bytes.byteLength,
      maxDurationMs: 600_000,
      body: new Blob([bytes]).stream(),
    });
    // An unreferenced, primary-key-shaped blob with no D1 row pointing to it.
    await env.BLOBS.put("artifacts/orphanScheduled/v1", new Uint8Array([1]));

    // auditOrphanVideoBlobs() (called with no args from src/index.ts's
    // scheduled handler) only considers objects older than one hour, and R2's
    // `uploaded` timestamp is real wall-clock time set at put() — it can't be
    // backdated. Advance the system clock instead (this test file runs inside
    // the same workerd realm as the handler it's exercising, so faking time
    // here reaches the handler's own `new Date()` calls too) so the object
    // genuinely reads as stale to the audit without needing to wait an hour.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 2 * 3600_000));
    try {
      await runScheduled();
    } finally {
      vi.useRealTimers();
    }

    expect(await env.BLOBS.get("artifacts/orphanScheduled/v1")).toBeNull();
    // The video's own (referenced) primary blob must survive the same sweep.
    expect(await env.BLOBS.get(`artifacts/${video.id}/v1`)).not.toBeNull();
  });
});

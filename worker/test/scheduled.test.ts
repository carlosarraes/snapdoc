import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ARTIFACT_BASE, mintToken, store } from "./helpers";

const DAY = 86400;

async function runScheduled() {
  const { default: worker } = await import("../src/index");
  const controller = { scheduledTime: Date.now(), cron: "0 * * * *", noRetry() {} } as ScheduledController;
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  await worker.scheduled(controller, env, ctx);
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
});

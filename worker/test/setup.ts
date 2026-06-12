import { env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

beforeAll(async () => {
  const statements = env.TEST_SCHEMA.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
});

// Storage is shared across tests (isolatedStorage is off), so reset explicitly.
beforeEach(async () => {
  for (const table of ["versions", "artifacts", "publish_events", "tokens"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  let cursor: string | undefined;
  do {
    const listing = await env.BLOBS.list({ cursor });
    if (listing.objects.length) await env.BLOBS.delete(listing.objects.map((o) => o.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
});

import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const statements = env.TEST_SCHEMA.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
});

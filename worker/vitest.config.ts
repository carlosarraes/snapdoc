import { readFileSync } from "node:fs";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const schema = readFileSync("./schema.sql", "utf-8");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_SCHEMA: schema,
            ADMIN_BOOTSTRAP: "test-bootstrap-secret",
          },
        },
      },
    },
  },
});

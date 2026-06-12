import { readFileSync } from "node:fs";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const schema = readFileSync("./schema.sql", "utf-8");

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    poolOptions: {
      workers: {
        // Isolated storage stacking currently trips over R2's sqlite WAL files,
        // so tests run sequentially in one worker and reset state explicitly.
        singleWorker: true,
        isolatedStorage: false,
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

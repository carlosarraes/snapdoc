import { readFileSync } from "node:fs";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const schema = readFileSync("./schema.sql", "utf-8");

// The workers pool runtime has no filesystem access, so binary test fixtures
// (see test/video.test.ts) are base64-encoded here in Node and handed over as
// plain string bindings, same as TEST_SCHEMA above.
function fixtureBase64(name: string): string {
  return readFileSync(`./test/fixtures/${name}`).toString("base64");
}

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
            ENVIRONMENT: "test",
            FIXTURE_VIDEO_H264_AAC_B64: fixtureBase64("video-h264-aac.mp4"),
            FIXTURE_VIDEO_H264_SILENT_B64: fixtureBase64("video-h264-silent.mp4"),
            FIXTURE_VIDEO_VP9_B64: fixtureBase64("video-vp9.mp4"),
            FIXTURE_VIDEO_AUDIO_ONLY_B64: fixtureBase64("video-audio-only.mp4"),
            FIXTURE_VIDEO_H264_OPUS_B64: fixtureBase64("video-h264-opus.mp4"),
            FIXTURE_VIDEO_H264_DUAL_AUDIO_B64: fixtureBase64("video-h264-dual-audio.mp4"),
            FIXTURE_VIDEO_ZERO_DURATION_B64: fixtureBase64("video-h264-zero-duration.mp4"),
          },
        },
      },
    },
  },
});

import type { Env } from "../src/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_SCHEMA: string;
    FIXTURE_VIDEO_H264_AAC_B64: string;
    FIXTURE_VIDEO_H264_SILENT_B64: string;
    FIXTURE_VIDEO_VP9_B64: string;
    FIXTURE_VIDEO_AUDIO_ONLY_B64: string;
    FIXTURE_VIDEO_H264_OPUS_B64: string;
    FIXTURE_VIDEO_H264_DUAL_AUDIO_B64: string;
    FIXTURE_VIDEO_ZERO_DURATION_B64: string;
  }
}

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inspectMp4, sanitizeVideoFilename, VideoValidationError, type RangeReader } from "../src/video";

const MAX_DURATION_MS = 600_000;
const MOOV_CAP_BYTES = 8 * 1024 * 1024;

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type FixtureName =
  | "video-h264-aac.mp4"
  | "video-h264-silent.mp4"
  | "video-vp9.mp4"
  | "video-audio-only.mp4"
  | "video-h264-opus.mp4"
  | "video-h264-dual-audio.mp4";

function fixtureBytes(name: FixtureName): Uint8Array {
  switch (name) {
    case "video-h264-aac.mp4":
      return decodeBase64(env.FIXTURE_VIDEO_H264_AAC_B64);
    case "video-h264-silent.mp4":
      return decodeBase64(env.FIXTURE_VIDEO_H264_SILENT_B64);
    case "video-vp9.mp4":
      return decodeBase64(env.FIXTURE_VIDEO_VP9_B64);
    case "video-audio-only.mp4":
      return decodeBase64(env.FIXTURE_VIDEO_AUDIO_ONLY_B64);
    case "video-h264-opus.mp4":
      return decodeBase64(env.FIXTURE_VIDEO_H264_OPUS_B64);
    case "video-h264-dual-audio.mp4":
      return decodeBase64(env.FIXTURE_VIDEO_H264_DUAL_AUDIO_B64);
  }
}

// A spy RangeReader over an in-memory buffer, recording every (offset, length)
// requested so tests can assert bounded-read behavior.
function makeReader(bytes: Uint8Array) {
  const reads: Array<{ offset: number; length: number }> = [];
  const reader: RangeReader = {
    async read(offset, length) {
      reads.push({ offset, length });
      return bytes.slice(offset, offset + length).buffer;
    },
  };
  return { reader, reads };
}

// A sparse spy RangeReader that only knows about explicitly registered byte
// regions. Any read outside those regions (e.g. a real mdat payload) throws,
// so tests never need to allocate a multi-megabyte fixture to prove a large
// declared box is skipped rather than read.
function makeSparseReader(regions: Array<{ offset: number; bytes: Uint8Array }>) {
  const reads: Array<{ offset: number; length: number }> = [];
  const reader: RangeReader = {
    async read(offset, length) {
      reads.push({ offset, length });
      if (length > MOOV_CAP_BYTES + 16) {
        throw new Error(`read exceeded bound: offset=${offset} length=${length}`);
      }
      for (const region of regions) {
        if (offset >= region.offset && offset + length <= region.offset + region.bytes.length) {
          const start = offset - region.offset;
          return region.bytes.slice(start, start + length).buffer;
        }
      }
      throw new Error(`unexpected read outside known regions: offset=${offset} length=${length}`);
    },
  };
  return { reader, reads };
}

async function inspectFile(name: FixtureName, maxDurationMs = MAX_DURATION_MS) {
  const bytes = fixtureBytes(name);
  const { reader } = makeReader(bytes);
  return inspectMp4(reader, bytes.byteLength, maxDurationMs);
}

async function inspectBytes(bytes: Uint8Array, maxDurationMs = MAX_DURATION_MS) {
  const { reader } = makeReader(bytes);
  return inspectMp4(reader, bytes.byteLength, maxDurationMs);
}

// Builds a raw top-level box: 4-byte big-endian size + 4-char type + payload.
// `declaredSize` lets tests lie about the size independently of the actual
// payload length, to construct hostile inputs.
function box(type: string, declaredSize: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, declaredSize, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

// A structurally valid, minimal ftyp box (major_brand + minor_version, no
// compatible_brands), so MP4Box's own ftyp parser doesn't warn about a
// truncated box in tests that are hostile about something else entirely.
function validFtyp(): Uint8Array {
  return box("ftyp", 16, concat(Uint8Array.from(asciiBytes("isom")), new Uint8Array(4)));
}

function asciiBytes(s: string): number[] {
  return Array.from(s).map((c) => c.charCodeAt(0));
}

function box64(type: string, largeSize: bigint): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  view.setUint32(8, Number(largeSize >> 32n), false);
  view.setUint32(12, Number(largeSize & 0xffffffffn), false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe("inspectMp4", () => {
  it("extracts width, height, video codec, and audio codec from an H.264+AAC file", async () => {
    await expect(inspectFile("video-h264-aac.mp4")).resolves.toMatchObject({
      width: 320,
      height: 180,
      videoCodec: "h264",
      audioCodec: "aac",
      durationMs: 1000,
    });
  });

  it("reports a null audio codec for a video with no audio track", async () => {
    await expect(inspectFile("video-h264-silent.mp4")).resolves.toMatchObject({
      width: 320,
      height: 180,
      videoCodec: "h264",
      audioCodec: null,
    });
  });

  it("rejects a VP9 video as an unsupported codec", async () => {
    await expect(inspectFile("video-vp9.mp4")).rejects.toMatchObject({
      code: "unsupported_video_codec",
    });
  });

  it("rejects bytes that are not a valid MP4 container", async () => {
    await expect(inspectBytes(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: "invalid_video",
    });
  });

  it("rejects a duration exactly one millisecond above the supplied limit", async () => {
    await expect(inspectFile("video-h264-silent.mp4", 999)).rejects.toMatchObject({
      code: "video_too_long",
    });
  });

  it("accepts a duration exactly at the supplied limit", async () => {
    await expect(inspectFile("video-h264-silent.mp4", 1000)).resolves.toMatchObject({
      durationMs: 1000,
    });
  });

  it("rejects a non-positive maxDurationMs before performing any reads", async () => {
    const { reader, reads } = makeReader(fixtureBytes("video-h264-silent.mp4"));
    await expect(inspectMp4(reader, 2302, 0)).rejects.toMatchObject({ code: "invalid_video" });
    await expect(inspectMp4(reader, 2302, -1)).rejects.toMatchObject({ code: "invalid_video" });
    expect(reads).toHaveLength(0);
  });

  it("rejects a non-finite maxDurationMs before performing any reads", async () => {
    const { reader, reads } = makeReader(fixtureBytes("video-h264-silent.mp4"));
    await expect(inspectMp4(reader, 2302, NaN)).rejects.toMatchObject({ code: "invalid_video" });
    await expect(inspectMp4(reader, 2302, Infinity)).rejects.toMatchObject({ code: "invalid_video" });
    expect(reads).toHaveLength(0);
  });

  it("rejects a file missing the ftyp box", async () => {
    const bytes = box("moov", 8);
    await expect(inspectBytes(bytes)).rejects.toMatchObject({ code: "invalid_video" });
  });

  it("rejects a file missing the moov box", async () => {
    const bytes = validFtyp();
    await expect(inspectBytes(bytes)).rejects.toMatchObject({ code: "invalid_video" });
  });

  it("rejects a box whose declared size is smaller than its header", async () => {
    const bytes = box("ftyp", 4);
    await expect(inspectBytes(bytes)).rejects.toMatchObject({ code: "invalid_video" });
  });

  it("rejects a box that declares a size extending beyond the end of the file", async () => {
    // Declared box size (1000) is far larger than the total file size passed
    // to inspectMp4 (8 bytes — just this header).
    const bytes = box("ftyp", 1000);
    await expect(inspectBytes(bytes)).rejects.toMatchObject({ code: "invalid_video" });
  });

  it("rejects a 64-bit box size that is not a safe integer", async () => {
    const bytes = box64("ftyp", 0xffffffffffffffn);
    await expect(inspectBytes(bytes)).rejects.toMatchObject({ code: "invalid_video" });
  });

  it("rejects a moov box larger than 8 MiB without reading its content", async () => {
    const ftyp = validFtyp();
    const moovOffset = ftyp.length;
    const moovDeclaredSize = MOOV_CAP_BYTES + 1000;
    // Padded to 16 bytes so the region can satisfy the scanner's header probe
    // even though the moov box is rejected long before its content is read.
    const moovHeader = concat(box("moov", moovDeclaredSize), new Uint8Array(8));
    const declaredTotalSize = moovOffset + moovDeclaredSize;

    const { reader, reads } = makeSparseReader([
      { offset: 0, bytes: ftyp },
      { offset: moovOffset, bytes: moovHeader },
    ]);

    await expect(inspectMp4(reader, declaredTotalSize, MAX_DURATION_MS)).rejects.toMatchObject({
      code: "invalid_video",
    });
    expect(reads.every((r) => r.length <= 16)).toBe(true);
  });

  it("skips a huge mdat box by advancing past its declared size, never reading its payload", async () => {
    const real = fixtureBytes("video-h264-aac.mp4");
    const realFtyp = real.slice(0, 32);
    const realMoov = real.slice(32, 32 + 2145);
    expect(realMoov.byteLength).toBe(2145);

    const fakeMdatDeclaredSize = 50 * 1024 * 1024; // 50 MiB, never actually backed
    // Pad the registered mdat header region to 16 bytes so it can satisfy the
    // scanner's 16-byte header probe even though only the first 8 bytes matter.
    const fakeMdatHeader = concat(box("mdat", fakeMdatDeclaredSize), new Uint8Array(8));
    const mdatOffset = realFtyp.length;
    const moovOffset = mdatOffset + fakeMdatDeclaredSize;
    const declaredTotalSize = moovOffset + realMoov.length;

    const { reader, reads } = makeSparseReader([
      { offset: 0, bytes: realFtyp },
      { offset: mdatOffset, bytes: fakeMdatHeader },
      { offset: moovOffset, bytes: realMoov },
    ]);

    await expect(inspectMp4(reader, declaredTotalSize, MAX_DURATION_MS)).resolves.toMatchObject({
      width: 320,
      height: 180,
      videoCodec: "h264",
      audioCodec: "aac",
    });

    expect(reads.every((r) => r.length <= MOOV_CAP_BYTES + 16)).toBe(true);
    expect(reads.some((r) => r.offset >= mdatOffset + 16 && r.offset < moovOffset)).toBe(false);
  });

  it("never reads more than a header for a pile of huge non-mdat filler boxes, keeping total bytes read bounded", async () => {
    // Simulates a hostile file well under a 100 MB upload cap, built almost
    // entirely out of oversized `free`/`skip`/`uuid` filler boxes between
    // ftyp and moov. None of them is `mdat`, so MP4Box can't bridge past them
    // on its own (verified separately) — inspectMp4 is expected to reject,
    // but the point of this test is that it must never come close to
    // reading the ~32 MiB these boxes *declare*.
    const ftyp = validFtyp();
    const fillerTypes = ["free", "skip", "uuid"] as const;
    const fillerDeclaredSize = MOOV_CAP_BYTES; // 8 MiB each, never actually backed
    let offset = ftyp.length;
    const regions = [{ offset: 0, bytes: ftyp }];
    for (const type of fillerTypes) {
      // Padded to 16 bytes so the region can satisfy the header probe.
      regions.push({ offset, bytes: concat(box(type, fillerDeclaredSize), new Uint8Array(8)) });
      offset += fillerDeclaredSize;
    }
    const real = fixtureBytes("video-h264-aac.mp4");
    const realMoov = real.slice(32, 32 + 2145);
    const moovOffset = offset;
    regions.push({ offset: moovOffset, bytes: realMoov });
    const declaredTotalSize = moovOffset + realMoov.length;

    const { reader, reads } = makeSparseReader(regions);

    await expect(inspectMp4(reader, declaredTotalSize, MAX_DURATION_MS)).rejects.toMatchObject({
      code: "invalid_video",
    });

    const totalBytesRead = reads.reduce((sum, r) => sum + r.length, 0);
    // ftyp (16B) + moov (2145B) content plus a 16-byte header probe per
    // filler box — nowhere near the ~24 MiB the three filler boxes declare.
    expect(totalBytesRead).toBeLessThan(64 * 1024);
    expect(reads.every((r) => r.length <= MOOV_CAP_BYTES + 16)).toBe(true);
  });

  it("rejects a file with zero video tracks", async () => {
    await expect(inspectFile("video-audio-only.mp4")).rejects.toMatchObject({
      code: "invalid_video",
    });
  });

  it("rejects a non-AAC audio track alongside a valid H.264 video track", async () => {
    await expect(inspectFile("video-h264-opus.mp4")).rejects.toMatchObject({
      code: "unsupported_video_codec",
    });
  });

  it("rejects a file with more than one audio track", async () => {
    await expect(inspectFile("video-h264-dual-audio.mp4")).rejects.toMatchObject({
      code: "invalid_video",
    });
  });
});

describe("sanitizeVideoFilename", () => {
  it("strips directory components, replaces disallowed characters, and forces a lowercase .mp4 suffix", () => {
    expect(sanitizeVideoFilename("../../QA demo.MP4")).toBe("QA-demo.mp4");
  });

  it("falls back to a default name when no filename is given", () => {
    expect(sanitizeVideoFilename(undefined)).toBe("recording.mp4");
  });

  it("falls back to a default name for an empty string", () => {
    expect(sanitizeVideoFilename("")).toBe("recording.mp4");
  });

  it("collapses repeated replacement characters", () => {
    expect(sanitizeVideoFilename("a   b!!!c.mov")).toBe("a-b-c.mp4");
  });

  it("limits the stem to 80 characters", () => {
    const longName = `${"a".repeat(120)}.mov`;
    const result = sanitizeVideoFilename(longName);
    expect(result).toBe(`${"a".repeat(80)}.mp4`);
  });
});

describe("VideoValidationError", () => {
  it("carries its error code and name", () => {
    const err = new VideoValidationError("invalid_video", "bad video");
    expect(err.code).toBe("invalid_video");
    expect(err.name).toBe("VideoValidationError");
    expect(err.message).toBe("bad video");
  });
});

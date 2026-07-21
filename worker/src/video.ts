// Bounded MP4 metadata inspection: filename normalization + ISO-BMFF parsing
// that never materializes a whole video. The scanner walks top-level box
// headers with small range reads and hands each box's bytes to MP4Box as it
// goes: only `ftyp` and `moov` (each capped at 8 MiB) get their full content;
// every other box — `mdat`, `free`, `skip`, `uuid`, unknown — gets only the
// header we already probed, so a file padded with huge filler boxes can never
// force a large aggregate read. Callers supply a `RangeReader` backed by R2
// `get({ offset, length })` calls.
import { createFile, MP4BoxBuffer, type ISOFile, type Movie } from "mp4box";

export interface RangeReader {
  read(offset: number, length: number): Promise<ArrayBuffer>;
}

export interface VideoMetadata {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: "h264";
  audioCodec: "aac" | null;
}

export type VideoValidationErrorCode = "invalid_video" | "unsupported_video_codec" | "video_too_long";

export class VideoValidationError extends Error {
  constructor(
    public readonly code: VideoValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VideoValidationError";
  }
}

const MIN_BOX_HEADER_BYTES = 8;
const LARGE_SIZE_HEADER_BYTES = 16;
const HEADER_PROBE_BYTES = 16;
const MAX_BOX_CONTENT_BYTES = 8 * 1024 * 1024; // moov cap from the brief; also applied to ftyp for the same bounded-read guarantee.

const DEFAULT_FILENAME = "recording.mp4";
const MAX_FILENAME_STEM_LENGTH = 80;

export async function inspectMp4(reader: RangeReader, size: number, maxDurationMs: number): Promise<VideoMetadata> {
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new VideoValidationError("invalid_video", "maxDurationMs must be a positive, finite number");
  }

  const info = await parseWithMp4Box(reader, size);
  return toVideoMetadata(info, maxDurationMs);
}

function asciiBoxType(header: Uint8Array): string {
  let type = "";
  for (let i = 4; i < 8; i++) type += String.fromCharCode(header[i]);
  return type;
}

// Drives the whole parse: scans top-level ISO-BMFF box headers with bounded
// reads and feeds each box to MP4Box as it goes. Only `ftyp` and `moov` get
// their full content (each capped at 8 MiB); every other box gets only the
// header bytes already probed, never its payload. Resolves with MP4Box's
// `onReady` info, or rejects once the scan finishes without a moov ever
// becoming ready.
function parseWithMp4Box(reader: RangeReader, size: number): Promise<Movie> {
  return new Promise((resolve, reject) => {
    const isoFile = createFile();
    let settled = false;

    const settleReject = (err: VideoValidationError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    isoFile.onError = (module, message) => {
      settleReject(new VideoValidationError("invalid_video", `mp4box error (${module}): ${message}`));
    };
    isoFile.onReady = (info) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };

    scanAndFeed(reader, size, isoFile)
      .then(({ ftypFound, moovFound }) => {
        if (settled) return;
        if (!ftypFound) {
          settleReject(new VideoValidationError("invalid_video", "missing ftyp box"));
        } else if (!moovFound) {
          settleReject(new VideoValidationError("invalid_video", "missing moov box"));
        } else {
          // Both boxes were complete and handed to MP4Box, so a well-formed
          // moov always fires onReady synchronously as it's appended. If it
          // didn't, the internal box tree was malformed, not just incomplete.
          settleReject(new VideoValidationError("invalid_video", "moov box could not be parsed"));
        }
      })
      .catch((err: unknown) => {
        settleReject(err instanceof VideoValidationError ? err : new VideoValidationError("invalid_video", `failed to parse mp4 metadata: ${String(err)}`));
      });
  });
}

async function scanAndFeed(reader: RangeReader, size: number, isoFile: ISOFile): Promise<{ ftypFound: boolean; moovFound: boolean }> {
  let offset = 0;
  let ftypFound = false;
  let moovFound = false;

  while (offset < size && (!ftypFound || !moovFound)) {
    const remaining = size - offset;
    if (remaining < MIN_BOX_HEADER_BYTES) {
      throw new VideoValidationError("invalid_video", "box smaller than its header");
    }

    const probeLength = Math.min(HEADER_PROBE_BYTES, remaining);
    const headerBuffer = await reader.read(offset, probeLength);
    const header = new Uint8Array(headerBuffer);
    if (header.byteLength < MIN_BOX_HEADER_BYTES) {
      throw new VideoValidationError("invalid_video", "box smaller than its header");
    }

    const view = new DataView(headerBuffer);
    const type = asciiBoxType(header);
    let boxSize = view.getUint32(0, false);
    let headerLength = MIN_BOX_HEADER_BYTES;

    if (boxSize === 1) {
      // 64-bit "largesize" variant: the real size lives in the next 8 bytes.
      if (header.byteLength < LARGE_SIZE_HEADER_BYTES) {
        throw new VideoValidationError("invalid_video", "box smaller than its header");
      }
      const largeSize = (BigInt(view.getUint32(8, false)) << 32n) | BigInt(view.getUint32(12, false));
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new VideoValidationError("invalid_video", "unsafe 64-bit box size");
      }
      boxSize = Number(largeSize);
      headerLength = LARGE_SIZE_HEADER_BYTES;
    } else if (boxSize === 0) {
      boxSize = remaining; // size 0 means "extends to EOF" (only valid for the last box).
    }

    if (!Number.isSafeInteger(boxSize) || boxSize < headerLength) {
      throw new VideoValidationError("invalid_video", "box smaller than its header");
    }
    if (offset + boxSize > size) {
      throw new VideoValidationError("invalid_video", "box extends beyond end of file");
    }

    if (type === "ftyp" || type === "moov") {
      if (boxSize > MAX_BOX_CONTENT_BYTES) {
        throw new VideoValidationError("invalid_video", `'${type}' box exceeds the maximum readable size`);
      }
      const content = await reader.read(offset, boxSize);
      isoFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(content, offset));
      if (type === "ftyp") ftypFound = true;
      else moovFound = true;
    } else {
      // Never read the payload for anything else (mdat, free, skip, uuid,
      // ...), regardless of its declared size: only `ftyp` and `moov` are
      // ever worth their full content, so a file padded with many huge
      // filler boxes never turns into a large aggregate read. MP4Box has a
      // dedicated "seek past declared size" retry for `mdat` specifically
      // (confirmed empirically), so the header we already probed is enough
      // for it to bridge straight past an `mdat` to whatever comes next —
      // e.g. the common non-faststart `ftyp, mdat, moov` layout. A large
      // non-mdat filler box between `ftyp` and `moov` has no such bridge in
      // MP4Box and will make the scan finish without `onReady` firing,
      // which `parseWithMp4Box` turns into an `invalid_video` rejection
      // rather than a hang.
      isoFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(headerBuffer, offset));
    }

    offset += boxSize;
  }

  return { ftypFound, moovFound };
}

function toVideoMetadata(info: Movie, maxDurationMs: number): VideoMetadata {
  const videoTracks = info.videoTracks;
  if (videoTracks.length !== 1) {
    throw new VideoValidationError("invalid_video", `expected exactly one video track, found ${videoTracks.length}`);
  }
  const videoTrack = videoTracks[0];
  if (!videoTrack.codec.startsWith("avc1") && !videoTrack.codec.startsWith("avc3")) {
    throw new VideoValidationError("unsupported_video_codec", `unsupported video codec: ${videoTrack.codec}`);
  }

  const audioTracks = info.audioTracks;
  if (audioTracks.length > 1) {
    throw new VideoValidationError("invalid_video", `expected at most one audio track, found ${audioTracks.length}`);
  }
  let audioCodec: "aac" | null = null;
  if (audioTracks.length === 1) {
    const audioTrack = audioTracks[0];
    if (!audioTrack.codec.startsWith("mp4a.40")) {
      throw new VideoValidationError("unsupported_video_codec", `unsupported audio codec: ${audioTrack.codec}`);
    }
    audioCodec = "aac";
  }

  const rawDurationMs = (info.duration / info.timescale) * 1000;
  if (!Number.isFinite(rawDurationMs)) {
    throw new VideoValidationError("invalid_video", "video duration is not finite");
  }
  if (rawDurationMs > maxDurationMs) {
    throw new VideoValidationError("video_too_long", `video duration ${rawDurationMs}ms exceeds limit ${maxDurationMs}ms`);
  }

  const width = videoTrack.video?.width ?? videoTrack.track_width;
  const height = videoTrack.video?.height ?? videoTrack.track_height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new VideoValidationError("invalid_video", "video track is missing dimensions");
  }

  return {
    durationMs: Math.round(rawDurationMs),
    width: Math.round(width),
    height: Math.round(height),
    videoCodec: "h264",
    audioCodec,
  };
}

export function sanitizeVideoFilename(value: string | undefined): string {
  if (!value) return DEFAULT_FILENAME;

  const base = basename(value);
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  if (!sanitized) return DEFAULT_FILENAME;

  const lastDot = sanitized.lastIndexOf(".");
  let stem = lastDot > 0 ? sanitized.slice(0, lastDot) : sanitized;
  if (!stem) stem = "recording";
  if (stem.length > MAX_FILENAME_STEM_LENGTH) stem = stem.slice(0, MAX_FILENAME_STEM_LENGTH);

  return `${stem}.mp4`;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

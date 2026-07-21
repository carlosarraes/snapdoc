// Single-range `Range:` header parsing plus the response-header construction
// that follows from it. Kept together (rather than split across parser vs.
// route files) so GET and HEAD always compute the exact same header set —
// only the presence of a body ever differs between them.

export type ParsedRange =
  | { kind: "full" }
  | { kind: "partial"; offset: number; length: number; end: number }
  | { kind: "invalid" };

const RANGE_PATTERN = /^bytes=(\d+)?-(\d+)?$/;

// Accepts exactly one `bytes=` range in the standard (`0-9`), open-ended
// (`10-`), and suffix (`-10`) forms. Every rejection — no unit match, more
// than one range, a reversed/zero-size span, a start at or beyond EOF, or a
// number outside the safe-integer range — collapses to `invalid`; the caller
// always answers those with 416 (see `buildMediaResponse`). A present `end`
// beyond EOF is clamped rather than rejected.
export function parseSingleRange(header: string | null | undefined, size: number): ParsedRange {
  if (!header) return { kind: "full" };
  // A comma means more than one range was requested; this parser only ever
  // honors a single range, so treat it as unsatisfiable rather than serving
  // just the first one silently.
  if (header.includes(",")) return { kind: "invalid" };

  const match = RANGE_PATTERN.exec(header.trim());
  if (!match) return { kind: "invalid" };
  const [, startStr, endStr] = match;
  if (startStr === undefined && endStr === undefined) return { kind: "invalid" };

  let start: number;
  let end: number;

  if (startStr === undefined) {
    // Suffix range: last N bytes of the resource.
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isSafeInteger(start)) return { kind: "invalid" };
    if (endStr === undefined) {
      end = size - 1; // open-ended: through EOF
    } else {
      end = Number(endStr);
      if (!Number.isSafeInteger(end) || end < start) return { kind: "invalid" };
      end = Math.min(end, size - 1); // clamp a final end beyond EOF
    }
  }

  if (start < 0 || start >= size || end < start) return { kind: "invalid" };
  const length = end - start + 1;
  if (length <= 0) return { kind: "invalid" };
  return { kind: "partial", offset: start, length, end };
}

export interface MediaResponseInput {
  range: ParsedRange;
  size: number;
  contentType: string;
  etag: string;
  cors: boolean;
  cacheControl: string;
}

export interface MediaResponseSpec {
  status: number;
  headers: Record<string, string>;
}

// Builds the exact header set (and status) for a range-aware media response.
// Never touches the body — callers decide separately whether to attach one
// (GET) or not (HEAD), which is what keeps the two in lockstep.
export function buildMediaResponse(input: MediaResponseInput): MediaResponseSpec {
  const headers: Record<string, string> = {
    "Content-Type": input.contentType,
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
    ETag: input.etag,
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": input.cacheControl,
  };
  if (input.cors) headers["Access-Control-Allow-Origin"] = "*";

  if (input.range.kind === "invalid") {
    return { status: 416, headers: { ...headers, "Content-Range": `bytes */${input.size}` } };
  }
  if (input.range.kind === "partial") {
    return {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${input.range.offset}-${input.range.end}/${input.size}`,
        "Content-Length": String(input.range.length),
      },
    };
  }
  return { status: 200, headers: { ...headers, "Content-Length": String(input.size) } };
}

// Public cache policy for video artifacts: bounded to 60s and to whatever
// remains of the artifact's TTL, whichever is smaller — never `immutable`,
// since the same URL keeps serving after a version is replaced.
export function videoCacheControl(expiresAt: string, now: Date = new Date()): string {
  const remainingSeconds = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000);
  const maxAge = Math.max(0, Math.min(60, remainingSeconds));
  return `public, max-age=${maxAge}`;
}

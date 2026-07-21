# First-Class Video Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class, short-lived MP4 video artifacts to Snapdoc with streaming upload/playback, optional posters, CLI support, dashboard visibility, and a stable API that `qa-pr` can consume.

**Architecture:** Add an immutable `ArtifactKind` discriminator and a `video_versions` extension table while retaining the existing artifact/version lifecycle. Stream raw `video/mp4` bodies into R2, inspect bounded R2 ranges with MP4Box before committing D1 metadata, and serve trusted watch pages plus range-capable raw media URLs. Keep document and image paths unchanged.

**Tech Stack:** Cloudflare Workers, Hono, R2, D1/SQLite, TypeScript, Vitest Workers pool, `mp4box@2.4.1`, Go 1.26, Kong, `github.com/Eyevinn/mp4ff@v0.54.0`, React 19, Vite.

## Global Constraints

- Read the approved design first: `docs/superpowers/specs/2026-07-21-first-class-video-artifacts-design.md`.
- Video input is MP4 only: H.264 (`avc1`/`avc3`) video and optional AAC audio.
- Maximum video body is exactly `100000000` bytes; require `Content-Length` and verify actual R2 size.
- Maximum duration is `600000` milliseconds.
- Video TTL is `3d` by default, `1h` minimum, and `7d` maximum.
- Posters are optional sniffed JPEG/PNG files no larger than `5242880` bytes.
- Video requests and responses must stream; never use `request.arrayBuffer()`, `request.formData()`, `io.ReadAll`, or `os.ReadFile` for an MP4.
- Videos are unlisted-public by default; passcode-protected video media is `private, no-store` and is never intended for forge embedding.
- Expired video blobs/posters are purged during the same hourly cleanup run, without document blob grace.
- Existing document/image API, serving, comments, passcodes, retention, and CLI behavior must remain backward compatible.
- Embedding videos in HTML/Markdown documents, transcoding, resumable uploads, WebM/MOV input, adaptive streaming, and permanent retention are out of scope.
- Implement test-first and make one conventional commit per task. Do not deploy, push, tag, or run remote migrations without explicit user approval.

---

## File map

New focused files:

- `worker/migrations/0006_add_video_artifacts.sql` — production D1 migration.
- `worker/src/video.ts` — filename normalization and bounded MP4 inspection.
- `worker/src/media-range.ts` — single byte-range parsing and response header calculation.
- `worker/src/video-page.ts` — trusted watch-page rendering and video CSP.
- `worker/test/video.test.ts` — parser/filename unit tests.
- `worker/test/video-api.test.ts` — publish, version, poster, metadata, and kind contract tests.
- `worker/test/video-serve.test.ts` — watch page, `HEAD`, ranges, passcode, and caching tests.
- `worker/test/fixtures/video-h264-aac.mp4` — tiny synthetic accepted fixture.
- `worker/test/fixtures/video-h264-silent.mp4` — tiny synthetic accepted fixture.
- `worker/test/fixtures/video-vp9.mp4` — tiny synthetic rejected fixture.
- `cli/internal/video/inspect.go` — local MP4 preflight without external executables.
- `cli/internal/video/inspect_test.go` — local preflight tests.

Existing files to modify:

- `worker/schema.sql` — current complete schema used by local/test setup.
- `worker/package.json`, `worker/package-lock.json` — pin MP4Box.
- `worker/src/types.ts` — video limit environment bindings.
- `worker/src/store.ts` — typed video persistence, reads, posters, purge, and lifecycle.
- `worker/src/http.ts` — additive JSON fields and error codes.
- `worker/src/api.ts` — video dispatch and poster route.
- `worker/src/serve.ts` — kind-aware watch/media/poster routing.
- `worker/test/setup.ts` — reset `video_versions` before parent tables.
- `worker/test/helpers.ts` — streamed video fixture publisher.
- `worker/test/api.test.ts`, `worker/test/serve.test.ts`, `worker/test/scheduled.test.ts`, `worker/test/store.test.ts` — document regressions and video lifecycle.
- `worker/wrangler.toml`, `worker/test/env.d.ts` — video configuration.
- `cli/internal/api/client.go`, `cli/internal/api/client_test.go` — video API contract and streaming methods.
- `cli/internal/cli/publish.go`, `cli/internal/cli/cli_test.go` — early video branch, poster, and output.
- `cli/internal/cli/llm.go` — agent-facing video usage.
- `dashboard/src/api.ts` — video types.
- `dashboard/src/views/Artifacts.tsx` — kind badge.
- `dashboard/src/views/ArtifactDetail.tsx` — player and video metadata.
- `dashboard/src/theme.css` — responsive player/expiry styling.
- `API.md`, `README.md`, `docs/PRD.md` — public contract and scope.

### Task 1: Add the artifact-kind schema and domain contract

**Files:**
- Create: `worker/migrations/0006_add_video_artifacts.sql`
- Modify: `worker/schema.sql`
- Modify: `worker/src/store.ts:5-80,183-230,295-315,579-635,950-980`
- Modify: `worker/src/http.ts:1-125`
- Modify: `worker/test/setup.ts:10-24`
- Modify: `worker/test/api.test.ts:1-55`
- Modify: `worker/test/store.test.ts`

**Interfaces:**
- Produces: `type ArtifactKind = "document" | "video"`.
- Produces: `Artifact.kind`, `ArtifactVersion.kind`, and additive JSON `kind`.
- Produces: `VideoVersionMetadata` rows keyed by `(artifactId, version)` for later tasks.
- Produces: `kind_mismatch` in both `StoreErrorCode` and the shared HTTP error map.

- [ ] **Step 1: Write failing schema/domain tests**

Add assertions that a normal HTML publish returns `kind: "document"`, lists preserve it, and the schema accepts a video metadata child row but rejects an unknown artifact kind. Add `video_versions` to the reset loop before `versions`.

```ts
expect(art.kind).toBe("document");
expect(body.artifact.kind).toBe("document");
expect(body.versions[0].kind).toBe("document");
```

Run: `cd worker && npm test -- --run test/api.test.ts test/store.test.ts`

Expected: FAIL because `kind` and `video_versions` do not exist.

- [ ] **Step 2: Add the migration and complete schema**

Use the same SQL in the migration and `schema.sql`:

```sql
ALTER TABLE artifacts
ADD COLUMN kind TEXT NOT NULL DEFAULT 'document'
CHECK (kind IN ('document', 'video'));

CREATE TABLE video_versions (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  filename TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  video_codec TEXT NOT NULL,
  audio_codec TEXT,
  poster_r2_key TEXT,
  poster_content_type TEXT,
  poster_size_bytes INTEGER,
  PRIMARY KEY (artifact_id, version),
  FOREIGN KEY (artifact_id, version)
    REFERENCES versions(artifact_id, version)
);

CREATE TABLE cleanup_state (
  name TEXT PRIMARY KEY,
  cursor TEXT
);
```

In `schema.sql`, place `kind` directly in the `CREATE TABLE artifacts` statement and create `video_versions` immediately after `versions`; do not include the `ALTER TABLE` there. Create `cleanup_state` in both migration/schema, and reset it in `worker/test/setup.ts` so orphan-audit cursor tests are isolated.

- [ ] **Step 3: Thread kind through store and HTTP types**

Add these exact types and mappings:

```ts
export type ArtifactKind = "document" | "video";

export interface VideoVersionMetadata {
  artifactId: string;
  version: number;
  filename: string;
  durationMs: number;
  width: number;
  height: number;
  videoCodec: "h264";
  audioCodec: "aac" | null;
  posterR2Key: string | null;
  posterContentType: "image/jpeg" | "image/png" | null;
  posterSizeBytes: number | null;
}
```

Add `kind` to `ArtifactRow`, `ARTIFACT_SELECT`, `rowToArtifact`, `Artifact`, and `artifactJson`. Add `kind` to `ArtifactVersion` and `versionJson`; document versions map to `document`. Keep create/add-document methods hard-coded to `document` so callers cannot choose a kind accidentally.

Add `kind_mismatch` to `StoreErrorCode`, `ErrorCode`, and `ERROR_STATUS` with HTTP 400 so Task 3 can reject cross-kind updates without creating a temporary type mismatch.

- [ ] **Step 4: Run focused and full regressions**

Run: `cd worker && npm test -- --run test/api.test.ts test/store.test.ts`

Expected: PASS.

Run: `just test-worker`

Expected: all existing Worker tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/migrations/0006_add_video_artifacts.sql worker/schema.sql worker/src/store.ts worker/src/http.ts worker/test/setup.ts worker/test/api.test.ts worker/test/store.test.ts
git commit -m "feat: add video artifact metadata schema"
```

### Task 2: Implement bounded MP4 inspection

**Files:**
- Create: `worker/src/video.ts`
- Create: `worker/test/video.test.ts`
- Create: `worker/test/fixtures/video-h264-aac.mp4`
- Create: `worker/test/fixtures/video-h264-silent.mp4`
- Create: `worker/test/fixtures/video-vp9.mp4`
- Modify: `worker/package.json`
- Modify: `worker/package-lock.json`

**Interfaces:**
- Produces: `sanitizeVideoFilename(value: string | undefined): string`.
- Produces: `inspectMp4(reader: RangeReader, size: number, maxDurationMs: number): Promise<VideoMetadata>`.
- Produces: `VideoValidationError` with codes `invalid_video`, `unsupported_video_codec`, or `video_too_long`.

- [ ] **Step 1: Generate tiny deterministic fixtures**

Run these commands once and commit only the resulting small files:

```bash
mkdir -p worker/test/fixtures
ffmpeg -f lavfi -i color=c=blue:s=320x180:d=1 -f lavfi -i anullsrc=r=48000:cl=stereo \
  -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart \
  worker/test/fixtures/video-h264-aac.mp4
ffmpeg -f lavfi -i color=c=green:s=320x180:d=1 \
  -c:v libx264 -pix_fmt yuv420p -an -movflags +faststart \
  worker/test/fixtures/video-h264-silent.mp4
ffmpeg -f lavfi -i color=c=red:s=320x180:d=1 \
  -c:v libvpx-vp9 -an -movflags +faststart \
  worker/test/fixtures/video-vp9.mp4
```

Assert each fixture is below 100 KiB with `ls -lh worker/test/fixtures/video-*.mp4`.

- [ ] **Step 2: Pin MP4Box and write failing parser tests**

Run: `cd worker && npm install mp4box@2.4.1 --save-exact`

Tests must cover:

```ts
expect(await inspectFile("video-h264-aac.mp4")).toMatchObject({
  width: 320, height: 180, videoCodec: "h264", audioCodec: "aac",
});
expect(await inspectFile("video-h264-silent.mp4")).toMatchObject({ audioCodec: null });
await expect(inspectFile("video-vp9.mp4")).rejects.toMatchObject({ code: "unsupported_video_codec" });
await expect(inspectBytes(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "invalid_video" });
expect(sanitizeVideoFilename("../../QA demo.MP4")).toBe("QA-demo.mp4");
expect(sanitizeVideoFilename(undefined)).toBe("recording.mp4");
```

Construct small in-memory box-header cases to cover missing `ftyp`, missing `moov`, a box smaller than its header, a box extending beyond EOF, unsafe 64-bit sizes, an over-8-MiB `moov`, and a metadata duration one millisecond above the supplied limit. Use a spy `RangeReader` to prove no read exceeds 8 MiB plus the small box header and no `mdat` payload is read.

Run: `cd worker && npm test -- --run test/video.test.ts`

Expected: FAIL because `video.ts` does not exist.

- [ ] **Step 3: Implement the bounded inspector**

Define:

```ts
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
```

Scan top-level ISO BMFF box headers with 16-byte-or-smaller range reads. Validate box sizes with `Number.isSafeInteger`, skip `mdat` by advancing its declared size, require `ftyp` and `moov`, and reject a `moov` larger than 8 MiB. Feed only the `ftyp` and `moov` buffers into MP4Box with their correct `fileStart` offsets. Resolve from `onReady`, require exactly one playable video track whose codec begins with `avc1` or `avc3`, allow zero audio tracks, and require every present audio track codec to begin with `mp4a.40`. Derive milliseconds from `info.duration / info.timescale`, reject non-finite values and values above the supplied `maxDurationMs`, and return integer width/height. Reject a non-positive or non-finite `maxDurationMs` before reading.

Sanitize filenames by taking the basename, replacing characters outside `[A-Za-z0-9._-]` with `-`, collapsing repeated `-`, limiting the stem to 80 characters, and forcing a lowercase `.mp4` suffix.

- [ ] **Step 4: Verify parser behavior and bundle budget**

Run: `cd worker && npm test -- --run test/video.test.ts`

Expected: PASS.

Run: `cd worker && npx tsc --noEmit && npx wrangler deploy --dry-run --outdir /tmp/snapdoc-worker-dry-run`

Expected: typecheck PASS and the compressed Worker bundle reported by Wrangler remains below Cloudflare Workers' 3 MiB free-plan limit. If MP4Box makes the bundle exceed that limit, replace it with a focused ISO-BMFF metadata parser under the same `inspectMp4` interface and test contract before committing.

- [ ] **Step 5: Commit**

```bash
git add worker/package.json worker/package-lock.json worker/src/video.ts worker/test/video.test.ts worker/test/fixtures/video-*.mp4
git commit -m "feat: validate mp4 video metadata"
```

### Task 3: Add video persistence, posters, and lifecycle to Store

**Files:**
- Modify: `worker/src/store.ts`
- Modify: `worker/src/assets.ts`
- Modify: `worker/test/store.test.ts`
- Modify: `worker/test/scheduled.test.ts`

**Interfaces:**
- Consumes: `inspectMp4`, `sanitizeVideoFilename`, and `VideoMetadata` from Task 2.
- Produces: `createVideoArtifact`, `addVideoVersion`, `setVideoPoster`, `getVideoVersion`, `headVideoObject`, `getVideoObject`, and `getPosterObject` Store methods.

- [ ] **Step 1: Write failing Store tests**

Use an R2-backed fixture reader and assert:

- create stores a primary blob plus `artifacts.kind = video`, `versions`, and `video_versions` rows;
- add version increments version and resets expiry to three days;
- adding a version to an expired, non-deleted video reactivates it while already-purged historical versions remain unavailable;
- document/video updates throw `StoreError("kind_mismatch", ...)`;
- poster upload accepts sniffed JPEG/PNG, records its key, and safely replaces/deletes the previous poster;
- delete purges all MP4/poster keys;
- cleanup immediately purges an expired video while retaining a recently expired document blob;
- a body whose stored R2 size differs from or exceeds the declared limit is rejected and deleted;
- a parser or D1 failure leaves no video R2 object.

Run: `cd worker && npm test -- --run test/store.test.ts test/scheduled.test.ts`

Expected: FAIL because video Store methods do not exist.

- [ ] **Step 2: Add video Store inputs and outputs**

Add exact input shapes:

```ts
export interface CreateVideoInput {
  tokenId: string;
  title: string | null;
  ttlSeconds: number;
  filename: string;
  contentLength: number;
  maxDurationMs: number;
  body: ReadableStream;
  passcode?: string;
}

export interface AddVideoVersionInput {
  title?: string | null;
  ttlSeconds: number;
  filename: string;
  contentLength: number;
  maxDurationMs: number;
  body: ReadableStream;
}
```

Return `Artifact & { video: VideoVersionMetadata }`. Use the existing passcode hashing and ID/version conventions. Put the stream directly into `r2Key(id, version)`, then `head` it and reject/delete it unless the stored size is positive, equals `contentLength`, and is at most `100000000`. Inspect through an R2 `get({ offset, length })` reader using `maxDurationMs`, and perform the artifact/version/video/current-version D1 writes in one batch only after inspection succeeds. Delete the new object on every failure after `put`; record the publish event only after that batch succeeds.

- [ ] **Step 3: Add poster persistence and reads**

Reuse `detectImageType` but accept only `image/jpeg` and `image/png`. Implement:

```ts
async setVideoPoster(
  id: string,
  version: number,
  bytes: Uint8Array,
  contentType: "image/jpeg" | "image/png",
): Promise<VideoVersionMetadata>
```

Store at `artifacts/{id}/v{version}/poster`, update `video_versions`, and delete the prior key only after the D1 update succeeds. Add `getVideoVersion`, `headVideoObject`, `getVideoObject(id, version, range?)`, and `getPosterObject` methods. These methods keep every raw R2 operation inside `Store`; the serving layer receives typed R2 objects/metadata and never accesses `env.BLOBS` directly.

- [ ] **Step 4: Make purge kind-aware**

When cleanup sees an expired video, purge its version and poster keys immediately and set `blobs_purged_at`. Keep `EXPIRED_BLOB_RETENTION_SECONDS` unchanged for documents. Extend `purgeBlobs` to include poster keys from `video_versions` and make repeated purge idempotent.

Add `auditOrphanVideoBlobs(limit = 100)` to the scheduled cleanup. It examines at most 100 R2 keys per run, parses only primary-version/poster key shapes, and deletes an object older than one hour only when neither `versions.r2_key` nor `video_versions.poster_r2_key` references it. Tests must prove referenced document/video blobs survive and an unreferenced synthetic video key is removed. Persist the next R2 cursor in a single-row `cleanup_state` table added to the Task 1 migration/schema so successive hourly runs make progress rather than rescanning the first page.

- [ ] **Step 5: Run focused and full tests**

Run: `cd worker && npm test -- --run test/store.test.ts test/scheduled.test.ts`

Expected: PASS.

Run: `just test-worker`

Expected: all Worker tests PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/store.ts worker/src/assets.ts worker/test/store.test.ts worker/test/scheduled.test.ts
git commit -m "feat: persist video artifact versions"
```

### Task 4: Expose the publisher API and JSON contract

**Files:**
- Create: `worker/test/video-api.test.ts`
- Modify: `worker/src/types.ts`
- Modify: `worker/src/http.ts`
- Modify: `worker/src/api.ts`
- Modify: `worker/test/helpers.ts`
- Modify: `worker/test/env.d.ts`
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Consumes: Store video methods from Task 3.
- Produces: raw `video/mp4` create/version requests, poster endpoint, and additive artifact/version JSON URLs.

- [ ] **Step 1: Add configuration and failing contract tests**

Add bindings:

```ts
MAX_VIDEO_BYTES: string;
MAX_VIDEO_DURATION_SECONDS: string;
DEFAULT_VIDEO_TTL: string;
MAX_VIDEO_TTL: string;
MAX_POSTER_BYTES: string;
```

Set Wrangler/test values to `100000000`, `600`, `3d`, `7d`, and `5242880`. Add a helper that loads an MP4 fixture and sends it with explicit `Content-Length` and optional `filename`, `ttl`, `id`, and passcode.

Test 201 response URLs/metadata, three-day default, `1h`/`7d` acceptance, `8d` rejection, missing length, `comments=1`, oversize length, version kind mismatch, metadata listing, poster upload, and video content-read rejection.

Run: `cd worker && npm test -- --run test/video-api.test.ts`

Expected: FAIL with unsupported content type or missing routes.

- [ ] **Step 2: Add stable errors and JSON serializers**

Extend error unions/status mapping with:

```ts
"invalid_video" | "unsupported_video_codec" | "video_too_long" |
"kind_mismatch" | "range_not_satisfiable"
```

Map validation/store errors without leaking parser internals. Add current and version serializers that emit `kind`, `file_url`, `version_url`, `version_file_url`, `poster_url`, `version_poster_url`, duration, dimensions, and codec fields only for video artifacts.

- [ ] **Step 3: Dispatch video before document body parsing**

In both POST handlers, inspect the normalized request content type first. For `video/mp4`, validate query/title/TTL with video-specific bounds, reject comments, require a positive finite `Content-Length <= MAX_VIDEO_BYTES`, convert `MAX_VIDEO_DURATION_SECONDS` to milliseconds, and pass both `request.body` unchanged and the duration limit to Store. Do not call `readPublishInput` for video.

Add:

```ts
app.put("/artifacts/:id/versions/:version/poster", uploadVideoPoster);
```

Poster bodies may use `arrayBuffer()` because their approved limit is 5 MiB; verify both declared and actual size and sniff bytes.

- [ ] **Step 4: Verify API and document regressions**

Run: `cd worker && npm test -- --run test/video-api.test.ts test/api.test.ts test/content.test.ts`

Expected: PASS.

Run: `just test-worker`

Expected: all Worker tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/types.ts worker/src/http.ts worker/src/api.ts worker/test/helpers.ts worker/test/env.d.ts worker/test/video-api.test.ts worker/wrangler.toml
git commit -m "feat: publish video artifacts through api"
```

### Task 5: Serve watch pages, posters, and byte ranges

**Files:**
- Create: `worker/src/media-range.ts`
- Create: `worker/src/video-page.ts`
- Create: `worker/test/video-serve.test.ts`
- Modify: `worker/src/serve.ts`
- Modify: `worker/test/serve.test.ts`
- Modify: `worker/test/passcode.test.ts`

**Interfaces:**
- Consumes: Store video read methods and video JSON metadata.
- Produces: `parseSingleRange(header, size)`, `renderVideoPage(...)`, and all public video routes.

- [ ] **Step 1: Write failing range and route tests**

Cover no range, `bytes=0-9`, `bytes=10-`, `bytes=-10`, invalid/multiple/overflow ranges, and unsatisfiable ranges. Route tests must assert:

```ts
expect(head.status).toBe(200);
expect(head.headers.get("Accept-Ranges")).toBe("bytes");
expect(await head.arrayBuffer()).toHaveLength(0);
expect(partial.status).toBe(206);
expect(partial.headers.get("Content-Range")).toBe(`bytes 0-9/${size}`);
expect(bad.status).toBe(416);
expect(bad.headers.get("Content-Range")).toBe(`bytes */${size}`);
```

Also assert generated watch-page escaping/CSP, version pinning, media filename matching, poster type, passcode cookie enforcement, public CORS, and short expiry-aware caching.

Run: `cd worker && npm test -- --run test/video-serve.test.ts`

Expected: FAIL with 404s/missing modules.

- [ ] **Step 2: Implement the range parser**

Return a discriminated union:

```ts
export type ParsedRange =
  | { kind: "full" }
  | { kind: "partial"; offset: number; length: number; end: number }
  | { kind: "invalid" };
```

Accept exactly one `bytes=` range, use safe integers, clamp a final end beyond EOF, and reject zero-size/syntactically invalid/multiple/unsatisfiable requests. Keep header construction next to the parser so `GET` and `HEAD` cannot diverge.

- [ ] **Step 3: Implement the trusted watch page**

`renderVideoPage` must escape title/filename, use `<video controls preload="metadata">`, include optional poster and direct-download fallback, display duration/size/expiry, and return a CSP limited to `'self'` for media/images with `default-src 'none'`, `style-src 'unsafe-inline'`, `frame-ancestors 'none'`, `base-uri 'none'`, and `form-action 'none'`.

- [ ] **Step 4: Add kind-aware routing and R2 ranged reads**

Route media/poster patterns before the generic ID pattern. Reuse the existing status/passcode gate and require the presentation filename/extension in the URL to match the selected version metadata. Call `Store.headVideoObject`, `Store.getVideoObject(id, version, { offset, length })`, and `Store.getPosterObject`; do not access `env.BLOBS` from `serve.ts`. Return `Content-Type`, `Content-Disposition: inline`, `Accept-Ranges`, `ETag`, exact lengths, `206`/`416`, `X-Robots-Tag`, and `nosniff`. Public media gets `Access-Control-Allow-Origin: *`; protected media gets no CORS and `private, no-store`.

For public cache headers use `max-age = min(60, floor(expiresAt-now))`, never `immutable`.

- [ ] **Step 5: Run serving and full regressions**

Run: `cd worker && npm test -- --run test/video-serve.test.ts test/serve.test.ts test/passcode.test.ts`

Expected: PASS.

Run: `just test-worker`

Expected: all Worker tests PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/media-range.ts worker/src/video-page.ts worker/src/serve.ts worker/test/video-serve.test.ts worker/test/serve.test.ts worker/test/passcode.test.ts
git commit -m "feat: stream video artifacts with range support"
```

### Task 6: Add streaming video methods to the Go API client

**Files:**
- Modify: `cli/internal/api/client.go`
- Modify: `cli/internal/api/client_test.go`

**Interfaces:**
- Consumes: the Task 4 API contract.
- Produces: additive Go media fields, `PublishVideo`, `PublishVideoVersion`, and `UploadVideoPoster`.

- [ ] **Step 1: Write failing HTTP contract tests**

Use `httptest.Server` and a counting reader to assert method/path/query, `video/mp4`, exact `Content-Length`, passcode header, streamed body bytes, decoded media fields, version route, and poster route. The test must fail if the client buffers through the existing multipart/document path.

Run: `go test ./cli/internal/api -run 'TestPublishVideo|TestUploadVideoPoster' -v`

Expected: FAIL because the methods/types do not exist.

- [ ] **Step 2: Add additive media response types**

Extend `Artifact` and `Version` with `Kind`, watch/file/poster URLs, duration, dimensions, and codecs using `omitempty` where appropriate. Define:

```go
type VideoPublishOptions struct {
    Title, TTL, Passcode, Filename string
    Size int64
}
```

- [ ] **Step 3: Implement streaming request methods**

Add:

```go
func (c *Client) PublishVideo(body io.Reader, opts VideoPublishOptions) (*Artifact, error)
func (c *Client) PublishVideoVersion(id string, body io.Reader, opts VideoPublishOptions) (*Artifact, error)
func (c *Client) UploadVideoPoster(id string, version int, body io.Reader, contentType string, size int64) (*Version, error)
```

Create a request helper variant that sets `req.ContentLength = size` and passes the reader directly to `http.NewRequest`; do not copy into `bytes.Buffer`. Reuse authentication/error decoding.

- [ ] **Step 4: Verify API client regressions**

Run: `go test ./cli/internal/api -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/internal/api/client.go cli/internal/api/client_test.go
git commit -m "feat: add streaming video api client"
```

### Task 7: Add CLI preflight, publish flow, poster, and output

**Files:**
- Create: `cli/internal/video/inspect.go`
- Create: `cli/internal/video/inspect_test.go`
- Modify: `go.mod`
- Modify: `go.sum`
- Modify: `cli/internal/cli/publish.go`
- Modify: `cli/internal/cli/cli_test.go`
- Modify: `cli/internal/cli/llm.go`

**Interfaces:**
- Consumes: Task 6 client methods.
- Produces: `video.Inspect(path) (Metadata, error)` and `.mp4` branch in `PublishCmd`.

- [ ] **Step 1: Pin the Go MP4 parser and write failing preflight tests**

Run: `go get github.com/Eyevinn/mp4ff@v0.54.0`

Copy the three tiny Worker fixtures into testdata references or open them through a repository-relative test path; do not duplicate binary fixtures. Assert accepted H.264/AAC and silent H.264 metadata, rejected VP9, rejected duration over ten minutes through a constructed metadata case, and rejected size over `100000000`.

Run: `go test ./cli/internal/video -v`

Expected: FAIL because `Inspect` does not exist.

- [ ] **Step 2: Implement local preflight**

Define:

```go
type Metadata struct {
    Size int64
    Duration time.Duration
    Width, Height int
    VideoCodec string
    AudioCodec string
}

func Inspect(path string) (Metadata, error)
```

Use `os.Stat` before decoding, `os.Open` plus `mp4.DecodeFile`, and inspect movie/track sample entries. Require H.264, allow absent audio, require AAC when audio exists, and close every file. Return actionable errors naming the violated limit/codec.

- [ ] **Step 3: Write failing CLI flow tests**

Add tests that `.mp4` branches before `readInput`, streams the file, sends filename/TTL/title/passcode, defaults video TTL server-side when omitted, forwards valid TTLs and surfaces invalid-TTL server errors, uploads an optional `--poster`, permits a poster-only retry against the returned artifact/version, prints video fields, and includes artifact ID/version when poster upload fails. Assert document publish tests remain unchanged.

Run: `go test ./cli/internal/cli -run 'TestPublishVideo' -v`

Expected: FAIL because `--poster` and the video branch do not exist.

- [ ] **Step 4: Implement the early video branch**

Add `Poster string` to `PublishCmd`. At the start of `Run`, before `readInput`, detect a regular file whose lowercase extension is `.mp4` and call a dedicated `runVideo`. Video stdin is rejected with a clear error because exact length is required. `runVideo` performs preflight, opens the file, calls create/update, then optionally opens and uploads a sniffed JPEG/PNG poster no larger than 5 MiB.

Do not change the existing document `readInput` path. Human output includes watch URL, file URL, duration, size, and expiry; `--quiet` continues to print only the watch URL; `--json` prints the server object.

- [ ] **Step 5: Update agent help and verify all CLI tests**

Add exact video create/update examples, limits, public/passcode embed behavior, and poster partial-failure guidance to `llm.go`.

Run: `go test ./cli/...`

Expected: PASS.

Run: `go vet ./cli/...`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum cli/internal/video cli/internal/cli/publish.go cli/internal/cli/cli_test.go cli/internal/cli/llm.go
git commit -m "feat: publish video artifacts from cli"
```

### Task 8: Add video visibility to the admin dashboard

**Files:**
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/views/Artifacts.tsx`
- Modify: `dashboard/src/views/ArtifactDetail.tsx`
- Modify: `dashboard/src/theme.css`

**Interfaces:**
- Consumes: Task 4 additive admin JSON contract.
- Produces: kind badge, current player, media metadata, and video-version links.

- [ ] **Step 1: Extend dashboard types and build to expose missing UI**

Add `ArtifactKind`, media fields on `Artifact`, and optional media fields on `Version`. Run `cd dashboard && npm run build`; it should pass before UI changes, establishing the baseline.

- [ ] **Step 2: Implement kind-aware list and detail rendering**

Add a kind badge next to title/status. On video details render a responsive `<video controls preload="metadata">`, poster, duration/dimensions/codecs, file-copy button, and prominent expiry. Version rows link to `v.url`, `v.file_url`, and optional `v.poster_url`. Hide reader-comment enable/review controls and document image sections for videos; keep team comment, expire, and delete behavior.

- [ ] **Step 3: Add responsive styles and verify production build**

Add `.video-player`, `.kind-badge`, and `.expires-soon` rules with a `max-width: 100%` player and no fixed height.

Run: `cd dashboard && npm run build`

Expected: TypeScript and Vite build PASS.

Run: `just test-worker`

Expected: Worker/admin API regressions PASS.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/api.ts dashboard/src/views/Artifacts.tsx dashboard/src/views/ArtifactDetail.tsx dashboard/src/theme.css
git commit -m "feat: show video artifacts in dashboard"
```

### Task 9: Document, verify, and prepare the release boundary

**Files:**
- Modify: `API.md`
- Modify: `README.md`
- Modify: `docs/PRD.md`
- Modify: `worker/schema.sql`
- Modify: `worker/wrangler.toml`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: documented stable contract and locally verified release candidate.

- [ ] **Step 1: Update public documentation**

Document the exact request/response examples, video/poster limits, TTL rules, range behavior, passcode limitation, CLI examples, errors, dashboard behavior, and deferred document embedding. Update PRD scope so first-class video is in scope while general document video attachments remain deferred.

- [ ] **Step 2: Run the complete automated verification**

Run:

```bash
just test
just check
just dashboard-build
just review-build
```

Expected: every command exits 0.

- [ ] **Step 3: Run a local end-to-end smoke test**

Start `just dev`, mint/use a local token, then publish the tiny fixture with the locally built CLI. Verify:

```bash
curl -I "http://localhost:8787/<id>/media/video-h264-aac.mp4"
curl -i -H 'Range: bytes=0-99' "http://localhost:8787/<id>/media/video-h264-aac.mp4"
```

Expected: `HEAD 200` with `Accept-Ranges: bytes`; ranged `GET 206` with exactly 100 bytes and correct `Content-Range`. Open the watch page and seek. Repeat with passcode, expire, and delete. Do not use production.

- [ ] **Step 4: Inspect compatibility and repository state**

Run:

```bash
git diff origin/main...HEAD --stat
git status --short
```

Expected: only intentional source, test, fixture, dependency, schema, and documentation changes; no build output, recordings, tokens, or `.dev.vars`.

- [ ] **Step 5: Commit**

```bash
git add API.md README.md docs/PRD.md worker/schema.sql worker/wrangler.toml
git commit -m "docs: document first-class video artifacts"
```

Stop here and report release/deployment commands. Remote D1 migration, Worker deployment, CLI release/tag, push, and production smoke tests require separate explicit authorization.

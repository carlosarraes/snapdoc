# First-Class Video Artifacts

**Status:** Approved design

**Date:** 2026-07-21

**Owners:** Snapdoc and `qa-pr`

## Summary

Snapdoc will add videos as a first-class artifact kind alongside documents. The
initial use case is observable QA evidence: an agent records a clean acceptance
test replay, publishes the recording to Snapdoc, and posts forge-appropriate
evidence on a GitHub pull request, GitLab merge request, or Bitbucket pull
request.

Version 1 supports MP4 recordings containing H.264 video and optional AAC audio,
up to 100,000,000 bytes and ten minutes. Videos are unlisted-public by default so
GitHub and GitLab can render them inline. Passcode protection remains available,
but protected videos are shared as watch-page links rather than inline embeds.

Video retention is intentionally short: three days by default, one hour minimum,
and seven days maximum. Expired video blobs and posters are purged by the hourly
cleanup without the document artifact's seven-day blob grace period.

Embedding videos inside HTML or Markdown document artifacts is explicitly
deferred.

## Goals

- Make `video` a first-class, immutable artifact kind next to `document`.
- Preserve Snapdoc's existing artifact IDs, versioning, expiry, deletion,
  passcodes, publisher tokens, rate limits, dashboard, and API-first model.
- Stream uploads and playback without buffering complete videos in Worker memory.
- Return both a trusted Snapdoc watch page and a raw `.mp4` URL.
- Support browser seeking through correct `HEAD` and single-range responses.
- Give `qa-pr` observable frontend evidence that renders appropriately on
  GitHub, GitLab, and Bitbucket.
- Keep all existing document and image behavior backward compatible.

## Non-goals

- Video elements or local video attachments inside document artifacts.
- WebM, MOV, or other accepted input formats.
- Server-side transcoding, adaptive bitrate streaming, HLS, or DASH.
- Resumable or multipart uploads.
- Recordings larger than 100,000,000 bytes or longer than ten minutes.
- Captions, chapters, video annotations, or video-specific comments.
- Permanent video storage.

## Product model

An artifact has one immutable kind:

```text
Artifact
├── document
│   └── HTML version + content-addressed image assets
└── video
    ├── MP4 version
    ├── optional version-specific poster
    ├── generated watch page
    └── current and version-specific media URLs
```

A document cannot receive a video version, and a video cannot receive a document
version. The existing stable artifact URL always resolves the current version.
Version URLs resolve a specific version while that version and artifact remain
available.

## API contract

### Publish a video

The existing publisher endpoint accepts `video/mp4` as an additional raw body
type:

```http
POST /v1/artifacts?title=QA&ttl=3d&filename=checkout-flow.mp4
Authorization: Bearer <token>
Content-Type: video/mp4
Content-Length: 48219384

<streamed MP4 body>
```

Inputs:

- `title`: optional, subject to the existing 200-character limit.
- `ttl`: optional; defaults to `3d` and must be between `1h` and `7d` for videos.
- `filename`: optional; defaults to `recording.mp4`. Snapdoc stores a sanitized
  basename ending in `.mp4` and never treats it as an R2 key.
- `X-Snapdoc-Passcode`: optional and behaves like document passcodes.
- `comments=1`: rejected for videos because line-anchored reader comments apply
  only to documents.

`Content-Length` is required for video uploads so Snapdoc can reject a known
oversize request before streaming it. Snapdoc also verifies the actual R2 object
size after upload.

The response extends the existing artifact object additively:

```json
{
  "id": "x7Kp9qWm2AbCdE",
  "kind": "video",
  "url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE",
  "file_url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/media/checkout-flow.mp4",
  "version_url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/v/1",
  "version_file_url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/v/1/media/checkout-flow.mp4",
  "poster_url": null,
  "version_poster_url": null,
  "title": "QA",
  "status": "active",
  "current_version": 1,
  "content_type": "video/mp4",
  "size_bytes": 48219384,
  "duration_ms": 94000,
  "width": 1920,
  "height": 1080,
  "video_codec": "h264",
  "audio_codec": "aac",
  "created_at": "...",
  "expires_at": "...",
  "has_passcode": false,
  "comments_enabled": false
}
```

The server derives duration, dimensions, and codecs from the stored MP4. Client
metadata is never authoritative.

### Publish a video version

The existing version endpoint accepts the same video request:

```http
POST /v1/artifacts/{id}/versions?ttl=3d&filename=checkout-flow.mp4
Authorization: Bearer <token>
Content-Type: video/mp4
Content-Length: 50123981

<streamed MP4 body>
```

The artifact kind must already be `video`; otherwise Snapdoc returns
`kind_mismatch`. Every successful video version resets the artifact expiry from
the upload time. An omitted TTL uses three days. Document version expiry behavior
does not change.

### Upload a poster

Posters are uploaded after the video so the large recording never enters a
multipart form:

```http
PUT /v1/artifacts/{id}/versions/{version}/poster
Authorization: Bearer <token>
Content-Type: image/jpeg
Content-Length: 182310

<poster bytes>
```

Posters are optional, version-specific, at most 5 MiB, and limited to sniffed
JPEG or PNG. The endpoint returns the updated version metadata and current URLs
when the target is the current version. Replacing a poster removes the previous
poster blob after the metadata update succeeds.

### Read metadata

`GET /v1/artifacts/{id}` retains its existing shape and adds `kind` plus video
metadata and URLs. Each entry in `versions` includes its own watch, file, poster,
duration, dimensions, and codec fields when the artifact is a video.

`GET /v1/artifacts/{id}/content` remains document-only. A video returns a clear
`invalid_request` response directing the caller to the metadata's watch or file
URL. No binary body is returned through the agent-oriented content endpoint.

## Data model

Add the artifact discriminator with a backward-compatible default:

```sql
ALTER TABLE artifacts
ADD COLUMN kind TEXT NOT NULL DEFAULT 'document'
CHECK (kind IN ('document', 'video'));
```

Store video-only metadata in an extension table rather than adding many nullable
columns to generic versions:

```sql
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
```

The existing `versions` row remains authoritative for the primary R2 key,
content type, size, and creation timestamp.

R2 keys remain private implementation details:

```text
artifacts/{id}/v1
artifacts/{id}/v1/poster
artifacts/{id}/v2
artifacts/{id}/v2/poster
```

## Upload and validation flow

Video upload follows this sequence:

1. Authenticate the publisher and enforce the existing publish rate limit.
2. Validate title, video TTL, `Content-Type`, required `Content-Length`, maximum
   size, and sanitized filename.
3. Fetch and verify the target artifact for version uploads, including kind and
   deleted-state checks.
4. Generate the artifact ID/version and stream `request.body` directly to the
   final R2 version key with `video/mp4` HTTP metadata.
5. Verify the actual R2 object size.
6. Inspect bounded R2 ranges through a focused MP4 parser:
   - validate ISO BMFF `ftyp`;
   - scan top-level box headers to locate `moov` without reading `mdat`;
   - reject missing, malformed, or unreasonably large metadata boxes;
   - read `mvhd`/track metadata for duration and dimensions;
   - require an H.264 `avc1` or `avc3` video sample entry;
   - allow no audio, otherwise require AAC in an `mp4a` audio sample entry;
   - reject durations over 600,000 milliseconds.
7. Delete the R2 object immediately if inspection fails.
8. Commit artifact, generic version, video metadata, and artifact-current-version
   changes in one D1 batch.
9. If the D1 batch fails, delete the just-uploaded R2 object.
10. Record the publish event only after R2 and D1 both succeed.

The MP4 inspector belongs in `worker/src/video.ts`. It operates on a small range
reader abstraction and never materializes the whole video. Parser limits must be
explicit and tested so malicious metadata cannot exhaust Worker memory or CPU.

## Serving and playback

Routes:

- `GET|HEAD /{id}`: generated watch page for the current version.
- `GET|HEAD /{id}/v/{n}`: generated watch page for version `n`.
- `GET|HEAD /{id}/media/{filename}.mp4`: current raw video.
- `GET|HEAD /{id}/v/{n}/media/{filename}.mp4`: version-specific raw video.
- `GET|HEAD /{id}/poster.jpg|png`: current poster.
- `GET|HEAD /{id}/v/{n}/poster.jpg|png`: version-specific poster.

The filename segment is presentation only. Routing resolves the artifact and
version from D1 and requires the sanitized filename to match metadata; callers
cannot use it to choose arbitrary R2 keys.

Raw media responses:

- reuse the artifact status and passcode gate before reading R2;
- support `GET` and `HEAD`;
- honor one valid standard or suffix byte range using an R2 ranged read;
- return `206`, `Content-Range`, `Content-Length`, and `Accept-Ranges: bytes` for
  partial responses;
- return `416` with `Content-Range: bytes */{size}` when unsatisfiable;
- return `ETag`, `Content-Type: video/mp4`, and `Content-Disposition: inline`;
- allow `Access-Control-Allow-Origin: *` only for unprotected media;
- use `private, no-store` for passcode-protected media;
- use a short, expiry-aware public cache with revalidation for unprotected media.

Version video URLs are not cached for a year: the artifact's short TTL and manual
deletion must remain enforceable. Cache freshness must never exceed the remaining
artifact TTL.

The video watch page is trusted Snapdoc HTML, not uploaded HTML. It escapes all
metadata and renders a responsive player similar to:

```html
<video controls preload="metadata" poster="...">
  <source src="...mp4" type="video/mp4">
  <a href="...mp4">Download the recording</a>
</video>
```

It uses a video-specific CSP restricted to Snapdoc's own media/poster routes,
sets `noindex, nofollow`, shows title, duration, size, and expiry, and provides a
direct-download fallback. Passcode unlock reuses the existing cookie flow.

## Retention and deletion

- Video default TTL: three days.
- Video minimum TTL: one hour.
- Video maximum TTL: seven days.
- Each successful video version resets artifact expiry from that upload.
- Document TTLs and version behavior remain unchanged.
- Manual deletion removes every video version and poster immediately.
- The hourly cleanup marks due videos expired and purges every MP4 and poster in
  that same run; videos do not receive the document blob grace period.
- D1 metadata remains as an audit tombstone after purge.
- Uploading a new version to an expired, non-deleted video artifact reactivates
  the stable URL; already-purged historical blobs remain unavailable.
- Error paths remove incomplete/orphaned blobs, and scheduled cleanup includes a
  bounded orphan audit as defense in depth.

## CLI behavior

The existing `publish` command auto-detects `.mp4` input:

```bash
snapdoc publish recording.mp4 \
  --title "ABC-123 QA @ a1b2c3d" \
  --ttl 3d \
  --poster happy-path.jpg \
  --json
```

Updates continue to use `--update <id>`. The CLI:

- validates the local size before sending;
- performs local container/codec/duration preflight for fast feedback, while the
  server repeats authoritative validation;
- sets the exact `Content-Length` and streams the file from disk;
- uploads the optional poster after the video version succeeds;
- includes the artifact ID/version in a partial-failure error if poster upload
  fails, allowing a retry without republishing the video;
- prints watch URL, raw file URL, duration, size, and expiry in human output;
- exposes all additive media fields in JSON output;
- reports that `read` has no text body for video artifacts;
- documents video usage in command help and `snapdoc llm`.

Snapdoc does not generate forge-specific Markdown. Storage and URL semantics
belong to Snapdoc; forge presentation belongs to `qa-pr`.

## Dashboard behavior

- Show a `document` or `video` badge in artifact lists.
- Render the current video player on video detail pages.
- Show poster, duration, dimensions, codecs, size, expiry, and direct URL.
- Give each video version its watch, file, and poster links.
- Hide document-content and line-comment controls for videos.
- Keep token ownership, expire, delete, and team comment behavior unchanged where
  it still applies.
- Make the short video expiry visually prominent.

## `qa-pr` integration

`qa-pr` records a clean replay after QA has passed, never the exploratory or
bug-fixing process:

1. Run `qa-ticket`, fix valid failures, and establish the known-good state.
2. Reopen that state and start `agent-browser record`, which creates a fresh
   recording context while preserving cookies and storage.
3. Replay only meaningful frontend acceptance cases.
4. Stop to a scratch `.webm`.
5. Normalize with `ffmpeg` to H.264 MP4, `yuv420p`, at most 1080p/30fps, no audio
   unless intentional, `faststart`, at most ten minutes and 100,000,000 bytes.
6. Generate a JPEG poster or reuse the best acceptance-test screenshot.
7. At the existing outward-action checkpoint, show the proposed comment plus the
   local video path, duration, size, and poster.
8. After approval, publish a new Snapdoc video artifact with a three-day TTL.
9. Upsert the single sticky evidence comment.

`qa-pr` creates a new video artifact for each run rather than updating a previous
artifact. Every recording therefore remains independently tied to one commit and
gets its own retention window. The hidden comment metadata is informational only:

```markdown
<!-- qa-pr-evidence -->
<!-- qa-pr-video artifact="<id>" version="1" sha="<sha>" -->
```

Forge rendering:

GitHub:

```html
<video controls preload="metadata"
  poster="VERSION_POSTER_URL"
  src="VERSION_FILE_URL">
</video>

[▶ Open QA recording](VERSION_WATCH_URL) · expires <timestamp>
```

GitLab:

```markdown
![QA recording](VERSION_FILE_URL)

[▶ Open QA recording](VERSION_WATCH_URL) · expires <timestamp>
```

Bitbucket:

```markdown
[![QA recording](VERSION_POSTER_URL)](VERSION_WATCH_URL)

[▶ Open QA recording](VERSION_WATCH_URL) · expires <timestamp>
```

Passcode-protected evidence always uses a watch link without inline media. Forge
detection comes from the supplied PR/MR URL or repository remote. GitHub uses
`gh`, GitLab uses `glab` or the GitLab API, and Bitbucket uses `bt`; all three find
and update the same sticky marker instead of duplicating comments.

If recording, conversion, poster generation, or Snapdoc upload fails, `qa-pr`
falls back to its existing screenshots/GIFs and explicitly reports degraded
evidence without discarding the QA verdict.

Recordings must never include credentials, production data, password flows,
developer-console tokens, or unrelated desktop content.

## Errors

Add stable errors without changing existing meanings:

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | `invalid_video` | Missing or malformed MP4 structure |
| 400 | `unsupported_video_codec` | Video is not H.264 or present audio is not AAC |
| 400 | `video_too_long` | Duration exceeds ten minutes |
| 400 | `kind_mismatch` | Attempted document/video kind change |
| 413 | `too_large` | Video or poster exceeds its limit |
| 416 | `range_not_satisfiable` | Invalid or unsatisfiable media range |

Missing `Content-Length`, invalid filenames, invalid TTLs, and document-only
operations on videos use the existing `invalid_request`/`invalid_ttl` envelope.

## Security and privacy

- Publishing remains bearer-token authenticated.
- Artifact URLs remain high-entropy, unlisted, and unindexed.
- Unprotected videos are intentionally accessible to anyone possessing the URL.
- Passcode-protected videos reuse the existing unlock capability and are never
  embedded into forge comments.
- Server-side MP4 sniffing and parsing, `nosniff`, and fixed response MIME prevent
  uploaded bytes from becoming executable HTML.
- Titles and filenames are escaped in generated HTML and never interpolated into
  R2 paths or headers without sanitization.
- Range parsing rejects multiple ranges and integer overflow.
- Parser reads are bounded independently of the total file-size limit.
- Logs contain artifact IDs and sizes, not bearer tokens, passcodes, or signed
  secrets.

## Testing

Worker coverage must include:

- all existing document/image tests unchanged;
- valid H.264/AAC and silent H.264 fixtures;
- bad magic, missing/malformed/oversize `moov`, unsupported codecs, and excessive
  duration;
- declared and actual oversize bodies;
- kind mismatch and document-only operations on videos;
- poster upload, replacement, type and size validation;
- public and passcode-gated watch/media/poster routes;
- full `GET`, `HEAD`, standard range, suffix range, invalid range, and `416`;
- hostile titles/filenames;
- expiry, manual delete, cron purge, reactivation, D1 failure cleanup, and orphan
  cleanup.

CLI coverage must include:

- MP4 auto-detection and preflight;
- streaming request and exact `Content-Length`;
- default, valid, and invalid video TTLs;
- `--update` kind behavior;
- poster success, retry, and partial-failure reporting;
- human and JSON output contracts.

`qa-pr` coverage must include:

- GitHub, GitLab, and Bitbucket markup snapshots;
- forge detection and sticky-comment upsert;
- recording normalization limits;
- screenshot/GIF fallback;
- passcode mode never emitting an inline raw-media URL.

Only tiny synthetic media fixtures belong in Git. No real QA recordings are
committed.

## Rollout

1. Add and apply the D1 migration.
2. Deploy the backward-compatible Worker/API changes.
3. Run the existing CLI against the new Worker and confirm document/image
   publishing is unchanged.
4. Publish a tiny synthetic video and verify watch playback, seeking, `HEAD`,
   ranges, passcode behavior, expiry, and deletion.
5. Release the updated Snapdoc CLI.
6. Update `qa-pr` with recording, normalization, upload, forge rendering, and
   fallback behavior.
7. Run one controlled evidence post on GitHub, GitLab, and Bitbucket.
8. Update `API.md`, `README.md`, `docs/PRD.md`, CLI help, and `snapdoc llm`.
9. Monitor Worker upload/parser/range errors, upload latency, and R2 video storage
   during the first week.

## Acceptance criteria

- A valid local H.264 MP4 can be streamed through the CLI and returns a watch URL,
  raw `.mp4` URL, poster URL, canonical metadata, and three-day expiry.
- Playback starts and seeking works through standard browser range requests.
- Invalid, unsupported, oversize, and over-duration media is rejected and leaves
  no retained blob or active metadata.
- Existing document/image publish, version, serve, passcode, comment, expiry, and
  delete behavior remains green.
- Video expiry never exceeds seven days and expired video blobs/posters are
  purged on the hourly cleanup without grace.
- `qa-pr` posts inline video on GitHub and GitLab, a clickable poster on Bitbucket,
  and a watch-link fallback everywhere.
- Every `qa-pr` run gets a new artifact tied to its tested commit and the sticky
  evidence comment is updated rather than duplicated.
- Failures in video evidence creation degrade to screenshots/GIFs without losing
  the QA verdict.

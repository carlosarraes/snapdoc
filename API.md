# snapdoc API Contract (v1)

Base URL: `https://api.snapdoc.carraes.dev`
Artifact serving host: `https://snapdoc.carraes.dev`

This document is the single source of truth for the JSON API. The CLI, dashboard,
and any future client implement against this contract only. Business rules live
server-side.

## Conventions

- All API requests/responses are JSON unless noted (publish accepts raw HTML/Markdown bodies).
- Timestamps are ISO 8601 UTC strings, e.g. `2026-06-12T15:04:05Z`.
- Artifact IDs are server-generated, URL-safe, high-entropy, 14 chars: `[A-Za-z0-9_-]{14}`.
- Authentication: `Authorization: Bearer <token>` for `/v1/*` publisher routes.
  `/v1/admin/*` is authenticated by Cloudflare Access (JWT in `Cf-Access-Jwt-Assertion`);
  no Bearer token required there.

## Limits

| Limit | Value |
|---|---|
| Max artifact (document) size | 2 MB (2,097,152 bytes) |
| Max image size | 5 MB (5,242,880 bytes) |
| Max images per publish | 20 |
| Max bundle size (document + images) | 25 MB (26,214,400 bytes) |
| Allowed image types | png, jpeg, gif, webp, avif (SVG not supported) |
| Default TTL | 14 days |
| Min TTL | 1 hour |
| Max TTL | 90 days |
| Publish rate limit | 100 publishes/hour/token |
| Max video size | 100,000,000 bytes (Content-Length required, checked before any byte is streamed) |
| Max video duration | 600 seconds (10 minutes) |
| Allowed video format | MP4 container, H.264 video (`avc1`/`avc3`), optional AAC audio |
| Default video TTL | 3 days |
| Min video TTL | 1 hour |
| Max video TTL | 7 days |
| Max poster size | 5 MB (5,242,880 bytes), sniffed JPEG or PNG |

## Error envelope

Every non-2xx response body:

```json
{
  "error": {
    "code": "too_large",
    "message": "Artifact exceeds the 2 MB size limit."
  }
}
```

Stable error codes (clients must switch on `code`, never on `message`):

| HTTP | code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body/params |
| 400 | `invalid_ttl` | TTL outside 1h–90d bounds |
| 400 | `unsupported_content_type` | Document not `text/html`/`text/markdown`, or an image not an allowed raster type |
| 400 | `too_many_assets` | More than 20 images in one publish |
| 401 | `unauthorized` | Missing/invalid/revoked token or Access JWT |
| 401 | `passcode_required` | Content read of a passcode-protected artifact without `X-Snapdoc-Passcode` |
| 401 | `passcode_incorrect` | Wrong passcode for a protected artifact |
| 403 | `comments_disabled` | Reader comment on an artifact whose owner has not enabled comments |
| 400 | `kind_mismatch` | Posting a document version onto a video artifact (or vice versa), or a poster upload against a document artifact |
| 400 | `invalid_video` | Upload is not a well-formed MP4 (missing/malformed `ftyp`/`moov`, wrong track counts, etc.) |
| 400 | `unsupported_video_codec` | Video or audio codec is not H.264 (`avc1`/`avc3`) / AAC |
| 400 | `video_too_long` | Video duration exceeds the 600-second (10 minute) limit |
| 404 | `not_found` | Unknown artifact/version/token id |
| 409 | `not_active` | Update/expire on a deleted artifact |
| 410 | `gone` | Content read of an expired or deleted artifact |
| 413 | `too_large` | Document exceeds 2 MB, an image exceeds 5 MB, the bundle exceeds 25 MB, a video exceeds 100,000,000 bytes, or a poster exceeds 5 MB |
| 416 | `range_not_satisfiable` | Video `Range:` header does not describe a satisfiable byte range |
| 429 | `rate_limited` | Over 100 publishes/hr, or reader comments over the per-IP/per-artifact cap; honors `Retry-After` |
| 500 | `internal` | Unexpected server error |
| 503 | `misconfigured` | Admin auth misconfigured server-side (e.g. Access env vars missing in production); admin routes fail closed |

Video error messages are stable strings that never leak MP4 parser internals
(box names, codec strings, mp4box error text): `invalid_video` always reads
"The uploaded file is not a valid MP4 video.", `unsupported_video_codec` always
reads "The video must be H.264 with optional AAC audio.", and `video_too_long`
always reads "The video duration exceeds the maximum of 10 minutes."

## Artifact object

```json
{
  "id": "x7Kp9qWm2AbCdE",
  "kind": "document",
  "url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE",
  "title": "Q3 plan review",
  "status": "active",
  "current_version": 2,
  "content_type": "text/html",
  "size_bytes": 48213,
  "created_at": "2026-06-12T15:04:05Z",
  "expires_at": "2026-06-26T15:04:05Z",
  "has_passcode": false,
  "comments_enabled": false,
  "token_name": "carraes-laptop"
}
```

`status` ∈ `active | expired | deleted`. `kind` ∈ `document | video` (see
[Video artifacts](#video-artifacts) below). `has_passcode` is true when the
artifact is passcode-protected. `comments_enabled` is true when the owner has
opted the artifact into public reader comments (see the review page below); it
is mutually exclusive with `has_passcode` and never true for a video (reader
comments are document-only). `token_name` appears only in admin responses.

**Video artifacts** carry every field above plus additive fields — never a
different shape, so a client that only understands documents can ignore them:

```json
{
  "id": "x7Kp9qWm2AbCdE",
  "kind": "video",
  "url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE",
  "file_url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/media/checkout-flow.mp4",
  "version_url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/v/1",
  "version_file_url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/v/1/media/checkout-flow.mp4",
  "poster_url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/poster.jpg",
  "version_poster_url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/v/1/poster.jpg",
  "title": "QA clip",
  "status": "active",
  "current_version": 1,
  "content_type": "video/mp4",
  "size_bytes": 4213880,
  "duration_ms": 42300,
  "width": 1920,
  "height": 1080,
  "video_codec": "h264",
  "audio_codec": "aac",
  "created_at": "2026-06-12T15:04:05Z",
  "expires_at": "2026-06-15T15:04:05Z",
  "has_passcode": false,
  "comments_enabled": false
}
```

`file_url`/`poster_url` always point at the *current* version; `version_url`/
`version_file_url`/`version_poster_url` are pinned to `current_version` at
response time (the `versions[]` entries below carry their own version-pinned
counterparts). `poster_url`/`version_poster_url` are `null` until a poster is
uploaded. `audio_codec` is `null` for a video with no audio track.

## Publisher endpoints (Bearer token)

### GET /v1/whoami — identity / token check

- Verifies the bearer token and reports which token is calling — the quickest way
  to confirm a freshly minted token works. Read-only, no side effects.
- 200 →

```json
{ "token": { "id": "tok_…", "name": "ci-laptop", "created_at": "..." } }
```

- 401 `unauthorized` if the token is missing, invalid, or revoked.
- Omits `last_used_at` (authentication just refreshed it) and `revoked_at` (a
  revoked token never authenticates).

### POST /v1/artifacts — publish new artifact

- Body: raw artifact content.
- `Content-Type: text/html` (stored as-is) or `text/markdown` (rendered server-side
  to self-contained styled HTML before storage; stored artifact is HTML).
- Query params:
  - `title` (optional, ≤200 chars)
  - `ttl` (optional, duration string: `12h`, `7d`, `90d`; default `14d`)
  - `comments` (optional, `0` or `1`) — opt the artifact into public reader
    comments. `invalid_request` if combined with `X-Snapdoc-Passcode`.
- Headers:
  - `X-Snapdoc-Passcode` (optional) — protects the new artifact with a passcode.
    Sent as a header rather than a query param so it is not logged. Hashed with
    PBKDF2 server-side; never stored or returned in plaintext. Only honored on
    create (ignored on version updates).
- 201 → Artifact object (version 1).

**Markdown frontmatter.** A `text/markdown` body may begin with a `---` YAML-ish
frontmatter block; recognized keys: `title` (string) and `toc` (`true` to prepend
a table of contents). Heading anchors are always added. Title precedence:
explicit `?title=` > frontmatter `title` > default. The frontmatter title becomes
the stored artifact title when no `?title=` is given.

**Publishing with images (`multipart/form-data`).** To host images referenced by
the document, send `Content-Type: multipart/form-data` instead of a raw body:

- one `document` part — a file part whose own `Content-Type` is `text/html` or
  `text/markdown` (the document body);
- zero or more `image` parts — each a file part whose **filename is the exact
  reference string as it appears in the document** (e.g. `diagram.png`,
  `shots/a.png`).

The server stores each image as a content-addressed blob (deduplicated by SHA-256),
then rewrites the document's local `<img src>` references to their hosted URLs
(`https://snapdoc.carraes.dev/{id}/a/{sha256}`). Markdown `![](…)` becomes `<img>`
during rendering, so both Markdown and HTML documents are handled. Image bytes are
validated by content sniffing (raster types only; **SVG is rejected**), not by the
declared part type. Remote (`https://`), `data:`, and root-absolute references are
left untouched. A local reference with no matching `image` part is also left as-is
and reported back in `unresolved_refs`.

The `?title=`, `?ttl=`, and `X-Snapdoc-Passcode` inputs work exactly as for a raw
body. The 201 response is the Artifact object plus an additive `unresolved_refs`
array, e.g. `{ ...artifact, "unresolved_refs": ["logo.png"] }`. The raw-body form
(no images) is unchanged.

<a id="video-artifacts"></a>

**Publishing a video (`video/mp4`).** Send `Content-Type: video/mp4` instead of
a document body:

- `Content-Length` is **required** and checked against the 100,000,000-byte cap
  before a single byte streams — an oversize declared length is rejected
  (`too_large`) without ever touching R2. The body itself streams straight to
  storage; it is never buffered whole.
- The upload must be a well-formed MP4 with exactly one H.264 (`avc1`/`avc3`)
  video track and at most one AAC audio track, duration ≤600s (10 minutes).
  A malformed file is `invalid_video`; a disallowed codec is
  `unsupported_video_codec`; an overlong video is `video_too_long`. All three
  return stable, parser-detail-free messages (see the error table above).
- Query params:
  - `title` (optional, ≤200 chars)
  - `ttl` (optional, duration string `1h`–`7d`; default `3d` — the video TTL
    bounds and default differ from the document ones above)
  - `filename` (optional) — sanitized server-side (path stripped, unsafe
    characters replaced, `.mp4` extension forced, stem capped at 80 chars) and
    used to build `file_url`; omitted or empty falls back to `recording.mp4`.
  - `comments` — **rejected** (`invalid_request`) if `1`: reader comments
    anchor to text and are document-only. Video publishes never set
    `comments_enabled`.
- Headers: `X-Snapdoc-Passcode` (optional, create only) works exactly as for a
  document — see the passcode limitation for video media under
  [Serving behavior](#serving-behavior) below.
- 201 → Video artifact object (version 1), including `file_url`, `version_url`,
  `version_file_url`, `poster_url`/`version_poster_url` (`null` until a poster
  is uploaded), `duration_ms`, `width`, `height`, `video_codec`, `audio_codec`.

### POST /v1/artifacts/{id}/versions — publish new version (update)

- Same body/params as publish, including the `multipart/form-data` form for
  images (`ttl` if present re-extends expiry from now). Images are deduplicated
  against the artifact's existing assets, so re-publishing an unchanged image is
  cheap.
- Only the active artifact can be updated; token need not be the original creator (single-team trust model).
- 201 → Artifact object with incremented `current_version`.
- 404 `not_found`, 409 `not_active` if deleted. Updating an `expired` artifact reactivates it with the new version.
- **Video**: same `video/mp4` publish as above, applied as a new version of an
  existing video artifact. Expiry always resets from upload time (default `3d`
  unless `ttl` is given, same 1h–7d bounds); `X-Snapdoc-Passcode` is ignored on
  a version update, matching documents. Posting a video body onto a document
  artifact (or a document body onto a video artifact) is `kind_mismatch` (400)
  — an artifact's `kind` is fixed for its lifetime.

### PUT /v1/artifacts/{id}/versions/{version}/poster — upload/replace a poster

- Video-only: `kind_mismatch` (400) against a document artifact.
- Body: raw image bytes. `Content-Type: image/jpeg` or `image/png` (no other
  type accepted); `Content-Length` required and checked against the
  5,242,880-byte cap before the body is read. The declared length and the
  actual uploaded size must match (`invalid_request` otherwise).
- The bytes are content-sniffed server-side and must match the declared
  `Content-Type`, else `invalid_request` — a mismatched or corrupt image never
  gets a URL.
- Replacing an existing poster with a different format changes its extension
  (`poster.jpg` ↔ `poster.png`); the old poster object is replaced, not kept
  alongside.
- 404 `not_found` if the artifact or that version doesn't exist.
- 200 → the version entry (see `versions[]` under `GET /v1/artifacts/{id}`
  below) with its `version_poster_url` set. If `{version}` is the artifact's
  `current_version`, the response also includes the refreshed stable `url`,
  `file_url`, and `poster_url` (the non-versioned URLs move with whichever
  version is current).

### GET /v1/artifacts — list own artifacts

- Query params: `status` (optional filter), `limit` (default 50, max 200), `cursor` (opaque pagination cursor).
- 200 →

```json
{ "artifacts": [ ...Artifact ], "next_cursor": "opaque-or-null" }
```

- Lists only artifacts created by the calling token.

### GET /v1/artifacts/{id} — metadata + versions

- 200 →

```json
{
  "artifact": { ...Artifact },
  "versions": [
    { "version": 1, "size_bytes": 31022, "content_type": "text/html", "created_at": "..." },
    { "version": 2, "size_bytes": 48213, "content_type": "text/html", "created_at": "..." }
  ],
  "assets": [
    { "hash": "<sha256>", "content_type": "image/png", "size_bytes": 20480,
      "url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/a/<sha256>", "created_at": "..." }
  ]
}
```

`assets` lists every hosted image across the artifact's versions (content-addressed,
so shared across versions). It is `[]` when the artifact has no images.

**Video**: each `versions[]` entry additionally carries `kind: "video"`,
`version_url`, `version_file_url`, `version_poster_url` (`null` until that
version has a poster), `duration_ms`, `width`, `height`, `video_codec`,
`audio_codec` — the same per-version metadata the version was published with.
Document entries carry only the base fields shown above plus `kind: "document"`.
`assets` is always `[]` for a video artifact (video files are not asset-hosted
images).

### GET /v1/artifacts/{id}/comments — read comments (the agent loop)

- Token-gated (any valid team token). Returns non-deleted comments in
  **thread order**: each root is followed by its replies, oldest-first. Includes
  **both** channels: team comments (`author_kind: "access"`) and reader comments
  (`author_kind: "anon"`, posted via the public review page, carrying an `anchor`).
- Optional `?status=open|resolved|all` (default `all`). The filter is
  thread-level — `open` returns unresolved roots **and their replies**,
  `resolved` returns resolved roots and their replies. An agent wanting just the
  actionable feedback reads `?status=open`. A bad value is `invalid_request`.
- 200 →

```json
{
  "artifact_id": "x7Kp9qWm2AbCdE",
  "comments": [
    { "id": "cmt_root", "author": "jane@team.com", "author_kind": "access",
      "author_email": null, "anchor": null, "version": 2,
      "body": "Tighten the intro.", "created_at": "2026-06-17T15:04:05Z",
      "parent_id": null, "resolved": true,
      "resolved_at": "2026-06-17T16:10:00Z", "resolved_by": "lead@team.com" },
    { "id": "cmt_reader", "author": "Alex R.", "author_kind": "anon",
      "author_email": "alex@example.com", "version": 2,
      "anchor": { "exact": "37% conversion", "prefix": "reached ",
                  "suffix": " last quarter", "start": 812, "end": 826 },
      "body": "This metric is stale.", "created_at": "2026-06-17T16:20:00Z",
      "parent_id": null, "resolved": false, "resolved_at": null, "resolved_by": null }
  ]
}
```

- `version` is the artifact's `current_version` when each comment was posted
  (a reply captures its own). `parent_id` is `null` for a root, else the root it
  hangs off (threads are one level — replies always attach to a root).
  `resolved`/`resolved_at`/`resolved_by` are thread state carried on the root;
  replies are always `resolved: false`. `author_kind` is `access` (team, via
  Cloudflare Access) or `anon` (reader, via the review page); `anchor` is the
  quoted text span for reader roots (`null` for team comments and all replies);
  `author_email` is the reader's unverified email or `null`. A `"truncated": true`
  flag appears if the (500) cap is hit. 404 `not_found` if the artifact does not exist.

### POST /v1/artifacts/{id}/comment-settings — toggle reader comments

- Body `{ "enabled": true|false }`. Opts the artifact into (or out of) public
  reader comments. 200 → the Artifact object with the updated `comments_enabled`.
- `invalid_request` if enabling on a passcode-protected artifact (mutually
  exclusive). 404 `not_found`, 409 `not_active` if deleted.

### GET /v1/artifacts/{id}/content — read content (Markdown by default)

- Token-gated (any valid team token). Returns the artifact's body so an agent can
  read a shared doc directly instead of scraping the public HTML page.
- `?format=md|html` (default `md`). `md` reconstructs Markdown from the stored
  HTML — far fewer tokens than HTML and terminal-friendly; `html` returns the raw
  stored document. A bad value is `invalid_request`.
- `?version=` (default latest) must be a positive integer, else `invalid_request`.
- **Passcode-protected artifacts require the passcode** via the `X-Snapdoc-Passcode`
  header — a valid token is necessary but **not sufficient**. Missing →
  `passcode_required`; wrong → `passcode_incorrect`.
- 200 →

```json
{
  "id": "x7Kp9qWm2AbCdE",
  "version": 2,
  "format": "md",
  "content_type": "text/markdown",
  "content": "# Q3 plan review\n\n..."
}
```

- `format` echoes what was actually produced: if `md` conversion degenerates the
  server falls back to the raw HTML and reports `format: "html"`, so the downgrade
  is visible. Reconstructed Markdown is best-effort and not guaranteed identical to
  the author's original (only rendered HTML is stored). 404 `not_found` (unknown
  artifact/version); 410 `gone` (expired/deleted).
- **Video artifacts have no text content** — this endpoint is document-only.
  Calling it on a video artifact is `invalid_request`, pointing at the watch
  page or file URL from the artifact metadata instead.

### POST /v1/artifacts/{id}/expire — expire now

- Idempotent: expiring an already-expired artifact is a 200.
- 200 → Artifact object (`status: "expired"`). 409 `not_active` if deleted.

### DELETE /v1/artifacts/{id} — delete

- Idempotent: deleting a deleted artifact is a 200. Removes blobs; metadata tombstoned.
- 200 → `{ "id": "...", "status": "deleted" }`.

## Admin endpoints (Cloudflare Access)

`/v1/admin/artifacts[...]` mirrors all of the above across **all tokens** (list is not
scoped to a creator and includes `token_name`). Additionally:

### POST /v1/admin/tokens

- Body: `{ "name": "ci-bot" }` (name required, unique).
- 201 → `{ "id": "tok_...", "name": "ci-bot", "token": "sd_live_<secret>", "created_at": "..." }`
- `token` (the secret) is returned exactly once; only its hash is stored.

### GET /v1/admin/tokens

- 200 → `{ "tokens": [ { "id", "name", "created_at", "last_used_at", "revoked_at" } ] }`

### DELETE /v1/admin/tokens/{id}

- Revokes (idempotent). 200 → `{ "id": "...", "revoked_at": "..." }`.

### Comments (write + moderate)

Humans author comments through Cloudflare Access (the dashboard); agents read
them via the token endpoint above. Team writes (comment, reply, resolve, delete)
are Access-only — agents never write. `author`/`resolved_by` come from the Access
JWT `email` claim — never a client field. The admin read/moderate endpoints below
also see **reader** (`anon`) comments and can resolve/delete them; the resolve and
delete verbs operate on any comment id regardless of kind.

- `POST /v1/admin/artifacts/{id}/comments` — body `{ "body": "…", "parent_id"?: "cmt_…" }`
  (body ≤8 KB else `invalid_request`). Omit `parent_id` for a root; include it to
  reply. A reply re-roots onto the thread, so replying to a reply still attaches
  to the root. `parent_id` on another artifact (or missing) → `invalid_request`.
  201 → Comment object. 404 `not_found` / 409 `not_active` (deleted artifact).
- `GET /v1/admin/artifacts/{id}/comments` — same shape + `?status=` as the token read, for the dashboard.
- `PATCH /v1/admin/comments/{cid}` — body `{ "resolved": true|false }`. Resolution
  is a thread property, so this acts on the root (passing a reply id re-roots).
  Idempotent. 200 → the updated Comment object. 404 `not_found`.
- `DELETE /v1/admin/comments/{cid}` — soft-delete (idempotent). Deleting a root
  **cascades** to its replies; deleting a reply removes only that reply.
  200 → `{ "id", "deleted_at" }`.

### Bootstrap

`POST /v1/tokens` (publisher namespace, **not** behind Cloudflare Access) accepts
`Authorization: Bearer <ADMIN_BOOTSTRAP secret>` — and only that secret — so the
first token can be minted headlessly. This route exists because Cloudflare Access
intercepts `/v1/admin/*` at the edge, making headless bootstrap impossible there.
`POST /v1/admin/tokens` also still accepts the bootstrap bearer for completeness.

## Reader endpoints (public review page)

When an artifact has `comments_enabled`, anyone with the link can comment on
specific text via a trusted first-party **review page** — no account. These live
on the API host, are **unauthenticated**, and never expose team comments or
internal fields. Author identity is pseudonymous (a typed display name + optional
unverified email). Writes are gated by the owner's opt-in and rate-limited per-IP
and per-artifact.

- `GET /review/{id}` — the review page (HTML). Renders the artifact in a
  sandboxed, cross-origin iframe (`/{id}?annotate=1` on the artifact host) plus a
  comment rail. Public; its own CSP is looser than artifact content (it frames the
  doc and calls the reader API).
- `GET /v1/reader/artifacts/{id}` — public metadata:
  `{ "id", "title", "current_version", "comments_enabled", "versions": [ { "version", "created_at" } ] }`.
  404 `not_found`, 410 `gone`.
- `GET /v1/reader/artifacts/{id}/comments[?status=]` — **reader comments only**
  (`author_kind: "anon"`), thread-ordered, `author_email` omitted. Same shape as
  the token read otherwise, including `anchor`.
- `POST /v1/reader/artifacts/{id}/comments` — post a reader comment. Body:
  `{ "author_name", "author_email"?, "body", "anchor"?, "parent_id"? }`.
  A **root** requires `anchor` (`{ "exact", "prefix", "suffix", "start", "end" }`,
  `exact` ≤1000, context ≤64); a **reply** sets `parent_id` (an existing anon root
  on this artifact) and omits `anchor`. `author_name` 1–80, `body` ≤8 KB.
  201 → the reader comment (no `author_email`), setting an `sd_reviewer` cookie
  (HttpOnly, Secure, SameSite=Lax) — the self-delete capability. Errors:
  `comments_disabled` (403) when not opted in, `rate_limited` (429) with
  `Retry-After`, `gone` (410), `not_found` (404), `invalid_request` (400).
- `DELETE /v1/reader/comments/{cid}` — self-delete, gated by the `sd_reviewer`
  cookie (only the author's own comment; cascades to replies). A missing/mismatched
  cookie reads as 404 `not_found`.

<a id="serving-behavior"></a>

## Serving behavior (snapdoc.carraes.dev) — for reference

| Path | Behavior |
|---|---|
| `/` and non-ID paths | Static assets (landing) |
| `/{id}` | 200 latest version HTML (document) or the video watch page (`kind: "video"`); 404 missing; 410 expired/deleted (distinct friendly pages) |
| `/{id}/v/{n}` | Version-pinned; same state rules; renders that version's watch page for a video artifact |
| `/{id}?annotate=1` | Annotate variant (only when `comments_enabled`, document artifacts only): same HTML with the review annotator injected and the CSP relaxed to allow framing by, and script loading from, the API host. Served `private, no-store`. The bare `/{id}` is byte-for-byte unchanged. Framed by the review page; a direct hit is a no-op. |
| `/{id}/a/{sha256}` | Hosted image bytes; `Content-Type` from the stored type, `Cache-Control: public, max-age=31536000, immutable`, `nosniff`. Same status/passcode gate as the page (404 missing, 410 expired/deleted, 401 if locked). `/{id}/v/{n}/a/{sha256}` also accepted. |
| `/{id}/media/{filename}.mp4` | Video byte-range streaming (see below). `/{id}/v/{n}/media/{filename}.mp4` also accepted. |
| `/{id}/poster.{jpg\|png}` | Video poster image (whichever extension matches the sniffed upload). `/{id}/v/{n}/poster.{jpg\|png}` also accepted. |
| `POST /{id}/unlock` | Passcode entry: form field `passcode`; 303 + viewer cookie on success, 401 unlock page on failure |

Headers on artifact responses: `X-Robots-Tag: noindex, nofollow`,
`Content-Security-Policy` allowing self-contained inline CSS/JS but no privileged reach,
`Cache-Control: public, max-age=60` for active artifacts only.

**Passcode gate.** When an artifact is passcode-protected, `GET /{id}` returns a
200 unlock page (its own CSP relaxes `form-action` to `'self'`) unless the request
carries a valid `sd_unlock_{id}` cookie. The cookie is an HMAC of the stored hash,
set by `POST /{id}/unlock` (HttpOnly, Secure, SameSite=Lax, Path=`/{id}`, 12h).
Protected content is served `Cache-Control: private, no-store` so shared caches
never hold it.

**Video media/poster serving.** `/{id}/media/{filename}.mp4` streams the raw
MP4 bytes: `GET`/`HEAD` only (405 otherwise), `Accept-Ranges: bytes`, and a
single `Range:` request honored per RFC 7233 subset — standard (`bytes=0-99`),
open-ended (`bytes=100-`), and suffix (`bytes=-100`) forms all work. A
satisfiable range answers `206` with `Content-Range: bytes {start}-{end}/{size}`
and a body of exactly that length; no range answers `200` with the full body
and `Content-Length`; an unsatisfiable range (out of bounds, reversed, or more
than one range) answers `416` with `Content-Range: bytes */{size}` and no body.
`HEAD` returns the same headers as the equivalent `GET` with an empty body.
`{filename}` in the URL is presentation-only — it must match the stored
version's filename exactly or the route 404s; it never selects storage
directly. Posters (`/{id}/poster.{jpg|png}`) are served whole (no ranges) with
their sniffed `Content-Type`. Cache-Control on unprotected video media/posters
is `public, max-age={min(60, seconds until expiry)}` — bounded and never
`immutable`, since the same URL keeps serving after a new version replaces it.

**Passcode limitation for video.** Unlike a document (where only the HTML page
is passcode-gated and content reads require the passcode header), a
passcode-protected video's **media and poster routes** are also gated by the
same `sd_unlock_{id}` cookie: a locked request gets a bare `401` (no page, no
body) rather than the document's friendly unlock page, and once unlocked, media
is served `Cache-Control: private, no-store` with **no**
`Access-Control-Allow-Origin` header (unprotected video media/posters send
`Access-Control-Allow-Origin: *` so GitHub/GitLab-style embedding works). This
means a passcode-protected video's watch page requires unlocking in-browser
first — the file/media URL is not intended for cross-origin `<video>`/`<img>`
embedding in a forge (issue/PR) the way an unprotected video's is; share the
watch page link instead.

## Versioning of this contract

Breaking changes require a `/v2` prefix. Additive fields are non-breaking; clients
must ignore unknown fields.

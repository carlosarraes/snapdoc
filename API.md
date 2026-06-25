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
| 404 | `not_found` | Unknown artifact/version/token id |
| 409 | `not_active` | Update/expire on a deleted artifact |
| 410 | `gone` | Content read of an expired or deleted artifact |
| 413 | `too_large` | Document exceeds 2 MB, an image exceeds 5 MB, or the bundle exceeds 25 MB |
| 429 | `rate_limited` | Over 100 publishes/hr; honors `Retry-After` header (seconds) |
| 500 | `internal` | Unexpected server error |
| 503 | `misconfigured` | Admin auth misconfigured server-side (e.g. Access env vars missing in production); admin routes fail closed |

## Artifact object

```json
{
  "id": "x7Kp9qWm2AbCdE",
  "url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE",
  "title": "Q3 plan review",
  "status": "active",
  "current_version": 2,
  "content_type": "text/html",
  "size_bytes": 48213,
  "created_at": "2026-06-12T15:04:05Z",
  "expires_at": "2026-06-26T15:04:05Z",
  "has_passcode": false,
  "token_name": "carraes-laptop"
}
```

`status` ∈ `active | expired | deleted`. `has_passcode` is true when the artifact
is passcode-protected. `token_name` appears only in admin responses.

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

### POST /v1/artifacts/{id}/versions — publish new version (update)

- Same body/params as publish, including the `multipart/form-data` form for
  images (`ttl` if present re-extends expiry from now). Images are deduplicated
  against the artifact's existing assets, so re-publishing an unchanged image is
  cheap.
- Only the active artifact can be updated; token need not be the original creator (single-team trust model).
- 201 → Artifact object with incremented `current_version`.
- 404 `not_found`, 409 `not_active` if deleted. Updating an `expired` artifact reactivates it with the new version.

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

### GET /v1/artifacts/{id}/comments — read comments (the agent loop)

- Token-gated (any valid team token). Returns non-deleted comments in
  **thread order**: each root is followed by its replies, oldest-first.
- Optional `?status=open|resolved|all` (default `all`). The filter is
  thread-level — `open` returns unresolved roots **and their replies**,
  `resolved` returns resolved roots and their replies. An agent wanting just the
  actionable feedback reads `?status=open`. A bad value is `invalid_request`.
- 200 →

```json
{
  "artifact_id": "x7Kp9qWm2AbCdE",
  "comments": [
    { "id": "cmt_root", "author": "jane@team.com", "version": 2,
      "body": "Tighten the intro.", "created_at": "2026-06-17T15:04:05Z",
      "parent_id": null, "resolved": true,
      "resolved_at": "2026-06-17T16:10:00Z", "resolved_by": "lead@team.com" },
    { "id": "cmt_reply", "author": "lead@team.com", "version": 3,
      "body": "Done in v3.", "created_at": "2026-06-17T16:09:00Z",
      "parent_id": "cmt_root", "resolved": false,
      "resolved_at": null, "resolved_by": null }
  ]
}
```

- `version` is the artifact's `current_version` when each comment was posted
  (a reply captures its own). `parent_id` is `null` for a root, else the root it
  hangs off (threads are one level — replies always attach to a root).
  `resolved`/`resolved_at`/`resolved_by` are thread state carried on the root;
  replies are always `resolved: false`. A `"truncated": true` flag appears if the
  (500) cap is hit. 404 `not_found` if the artifact does not exist.

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
them via the token endpoint above. All writes (comment, reply, resolve, delete)
are Access-only — agents never write. `author`/`resolved_by` come from the Access
JWT `email` claim — never a client field.

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

## Serving behavior (snapdoc.carraes.dev) — for reference

| Path | Behavior |
|---|---|
| `/` and non-ID paths | Static assets (landing) |
| `/{id}` | 200 latest version HTML; 404 missing; 410 expired/deleted (distinct friendly pages) |
| `/{id}/v/{n}` | Version-pinned; same state rules |
| `/{id}/a/{sha256}` | Hosted image bytes; `Content-Type` from the stored type, `Cache-Control: public, max-age=31536000, immutable`, `nosniff`. Same status/passcode gate as the page (404 missing, 410 expired/deleted, 401 if locked). `/{id}/v/{n}/a/{sha256}` also accepted. |
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

## Versioning of this contract

Breaking changes require a `/v2` prefix. Additive fields are non-breaking; clients
must ignore unknown fields.

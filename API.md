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
| Max artifact size | 2 MB (2,097,152 bytes) |
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
| 400 | `unsupported_content_type` | Not `text/html` or `text/markdown` |
| 401 | `unauthorized` | Missing/invalid/revoked token or Access JWT |
| 404 | `not_found` | Unknown artifact/version/token id |
| 409 | `not_active` | Update/expire on a deleted artifact |
| 413 | `too_large` | Body exceeds 2 MB |
| 429 | `rate_limited` | Over 100 publishes/hr; honors `Retry-After` header (seconds) |
| 500 | `internal` | Unexpected server error |

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
  "token_name": "carraes-laptop"
}
```

`status` ∈ `active | expired | deleted`. `token_name` appears only in admin responses.

## Publisher endpoints (Bearer token)

### POST /v1/artifacts — publish new artifact

- Body: raw artifact content.
- `Content-Type: text/html` (stored as-is) or `text/markdown` (rendered server-side
  to self-contained styled HTML before storage; stored artifact is HTML).
- Query params:
  - `title` (optional, ≤200 chars)
  - `ttl` (optional, duration string: `12h`, `7d`, `90d`; default `14d`)
- 201 → Artifact object (version 1).

### POST /v1/artifacts/{id}/versions — publish new version (update)

- Same body/params as publish (`ttl` if present re-extends expiry from now).
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
  ]
}
```

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

### Bootstrap

`POST /v1/admin/tokens` also accepts `Authorization: Bearer <ADMIN_BOOTSTRAP secret>`
in place of Cloudflare Access, so the first token can be minted headlessly.

## Serving behavior (snapdoc.carraes.dev) — for reference

| Path | Behavior |
|---|---|
| `/` and non-ID paths | Static assets (landing) |
| `/{id}` | 200 latest version HTML; 404 missing; 410 expired/deleted (distinct friendly pages) |
| `/{id}/v/{n}` | Version-pinned; same state rules |

Headers on artifact responses: `X-Robots-Tag: noindex, nofollow`,
`Content-Security-Policy` allowing self-contained inline CSS/JS but no privileged reach,
`Cache-Control: public, max-age=60` for active artifacts only.

## Versioning of this contract

Breaking changes require a `/v2` prefix. Additive fields are non-breaking; clients
must ignore unknown fields.

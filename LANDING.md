# snapdoc UI Surfaces — Landing Page & Dashboard

Spec for building the two static UI surfaces in a separate session. The Worker and
CLI are built independently; the only contract between the UIs and the backend is
`API.md`.

## How serving works

Both surfaces are **plain static files** served by the Worker's static assets
binding — no build step required (one is fine if you want, output just has to land
in these folders):

```
worker/public/
├── index.html        # landing page → https://snapdoc.carraes.dev/
├── *.css / *.svg     # any supporting assets
└── admin/
    └── index.html    # dashboard SPA → https://api.snapdoc.carraes.dev/admin
```

Routing rules (already handled by the Worker — you don't write any):
- On `snapdoc.carraes.dev`: paths matching an artifact ID (`[A-Za-z0-9_-]{14}`) serve
  artifacts; everything else falls through to static assets. Keep landing asset
  paths human-looking (`/style.css`, `/logo.svg`) and they'll never collide.
- On `api.snapdoc.carraes.dev`: `/admin/*` serves the dashboard assets **behind
  Cloudflare Access** (you'll already be logged in via browser redirect — the SPA
  does zero auth work); `/v1/*` is the JSON API.

Preview locally: `cd worker && npm run dev` (wrangler dev), then open the printed
localhost URL. Locally there is no Cloudflare Access; the Worker stubs admin auth
in dev mode.

## 1. Landing page (snapdoc.carraes.dev) — REALLY minimal

One page, no JS required. Content:

- Name (`snapdoc`) + one-line pitch: *"Publish an HTML artifact from your terminal,
  get back a shareable URL."*
- A terminal-style snippet showing the core flow:

  ```
  $ snapdoc publish report.html --title "Q3 review"
  https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE
  ```

- One short line of supporting copy (agents-first, 14-day default expiry, unlisted URLs).
- Footer link to the GitHub repo (when public). That's it — no signup, no docs site,
  no nav.

There is intentionally nothing interactive: this origin must stay cookie-free and
auth-free (uploaded artifacts share it).

## 2. Dashboard SPA (api.snapdoc.carraes.dev/admin)

Single-page static app (vanilla JS or anything that compiles to static files) that
calls the `/v1/admin/*` JSON API with `fetch` + `credentials: 'same-origin'`. No
login UI — Cloudflare Access gates the whole path before the page loads.

Views (keep it minimal, function over form):

1. **Artifacts list** (default view)
   - `GET /v1/admin/artifacts?status=&limit=&cursor=` — table: title, id, status,
     current_version, size, created_at, expires_at, token_name.
   - Client-side filter box (title/id/token) + status filter param.
   - Row actions: **copy URL**, **expire** (`POST .../expire`), **delete**
     (`DELETE ...`, confirm first). Idempotent — safe to retry.
   - Pagination via `next_cursor`.
2. **Artifact detail** (click a row)
   - `GET /v1/admin/artifacts/{id}` — metadata + versions table with per-version
     links (`https://snapdoc.carraes.dev/{id}/v/{n}`).
3. **Tokens**
   - `GET /v1/admin/tokens` — table: name, created_at, last_used_at, revoked_at.
   - Create form (`POST /v1/admin/tokens` with `{"name": "..."}`) — show the
     returned `token` secret ONCE with a copy button and a "you won't see this
     again" notice.
   - Revoke button (`DELETE /v1/admin/tokens/{id}`).

Error handling: every non-2xx response has `{ "error": { "code", "message" } }` —
show `message`, switch on `code` only if you need special handling (`rate_limited`
has a `Retry-After` header).

## Out of scope for the UI session

- Any publishing UI (CLI/API only by design).
- Auth code of any kind.
- Worker/route changes — if a route behaves unexpectedly, fix the Worker session-side, not here.

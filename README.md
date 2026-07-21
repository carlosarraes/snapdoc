# snapdoc

Publish an HTML artifact from your terminal, get back a stable shareable URL.

snapdoc is a CLI-first host for the rich HTML artifacts agents and developers
generate — plans, code reviews, QA reports, dashboards, diagrams. Publish a
self-contained HTML (or Markdown) file and share the link; teammates and other
agents open it in a browser, no setup required. It runs on Cloudflare Workers +
R2 + D1, and is **API-first**: the CLI, dashboard, and any future client are
thin wrappers over one JSON contract ([`API.md`](API.md)).

## Install

```bash
# Quick install (Linux / macOS)
curl -sSf https://raw.githubusercontent.com/carlosarraes/snapdoc/main/install.sh | sh

# Or with Go
go install github.com/carlosarraes/snapdoc/cli@latest
```

The installer verifies the binary against the release checksums. Pin a version
with `curl -sSf …/install.sh | VERSION=v0.0.1 sh`, or grab a prebuilt binary
from the [releases page](https://github.com/carlosarraes/snapdoc/releases).
Check your install with `snapdoc --version`.

## Quickstart

```bash
# Save your API URL and token (ask an admin for a token)
snapdoc login --api-url https://api.snapdoc.carraes.dev --token sd_live_...

# Publish a file — prints the URL
snapdoc publish report.html --title "Q3 review"

# Pipe from stdin, quiet mode prints only the URL (ideal for scripts/agents)
cat plan.md | snapdoc publish - --markdown --quiet

# Read a shared doc's content straight to the terminal — Markdown by default
# (fewer tokens than HTML, ideal for agents); --raw for the original HTML
snapdoc read <id> > doc.md

# Publish an MP4 recording (e.g. QA evidence) — prints a watch URL
snapdoc publish recording.mp4 --title "ABC-123 QA @ a1b2c3d" --poster happy-path.jpg

# Add a new version to the same watch URL
snapdoc publish recording.mp4 --update <id>
```

## Commands

| Command | Description |
|---------|-------------|
| `publish [file]` | Publish HTML/Markdown from a file or stdin, or an `.mp4` video (auto-detected). Flags: `--title`, `--ttl`, `--update <id>`, `--markdown`, `--passcode`, `--no-assets`, `--assets-base <dir>`, `--poster <img>` (video only), `--quiet/-q` |
| `list` | List your artifacts. Flags: `--status`, `--all` |
| `get <id>` | Show artifact metadata and version history |
| `comments <id>` | Read feedback left on an artifact |
| `read <id>` | Print an artifact's content as Markdown (`--raw` for HTML, `--rev` for a version, `--passcode`/`SNAPDOC_PASSCODE` for protected docs) |
| `open <id>` | Open an artifact in the browser |
| `expire <id>` | Expire an artifact now (URL stops serving) |
| `delete <id>` | Delete an artifact and its content |
| `token create <name>` | Mint an API token (admin). `--bootstrap` uses `SNAPDOC_BOOTSTRAP` |
| `token list` / `token revoke <id>` | Manage tokens (admin) |
| `login` | Save API URL and token to the config file |
| `whoami` | Show which token you're authenticated as (verifies the token works) |
| `llm` | Print a compact, agent-oriented guide to the whole CLI |

`--json` (global) prints raw JSON instead of human text — handy for scripts and agents.
`--passcode` protects a new artifact; viewers get a browser unlock page. Markdown
bodies may carry `---` frontmatter (`title`, `toc: true`); headings get anchor links.

**Feedback loop:** teammates comment on an artifact (via the Access-gated dashboard),
and an agent reads that feedback back with `snapdoc comments <id>` to inform the next
version — closing the publish → review → iterate loop.

`--update <id>` publishes a new version while keeping the same stable URL;
every other publish mints a new immutable artifact.

**Images:** reference them with normal relative paths
(`![](diagram.png)`, `<img src="shots/a.png">`) and `publish` uploads the local
files next to your document, hosts them, and rewrites the references to hosted
URLs — remote `https://` and `data:` refs are left untouched. Use `--assets-base
<dir>` when images live in another folder, or `--no-assets` to disable. Limits:
≤5 MB/image, ≤20 images, ≤25 MB total; png/jpeg/gif/webp/avif (SVG unsupported).
Run `snapdoc llm` for a compact, copy-pasteable guide aimed at agents.

**Mermaid diagrams:** fenced `mermaid` blocks in Markdown render natively in
shared documents and review mode. Snapdoc pins and self-hosts Mermaid 11.15.0,
runs it with strict security settings, and keeps the escaped diagram source as a
readable fallback when rendering is unavailable or fails. Add Mermaid
`accTitle` and `accDescr` directives when a diagram needs a richer accessible
description. The Markdown source remains available through `snapdoc read`, so
Git can stay the permanent source of truth while Snapdoc hosts each review
version and its comments.

**Videos:** an `.mp4` file argument is auto-detected — `snapdoc publish
recording.mp4` streams it with an exact `Content-Length` (never from stdin) and
prints a watch page URL alongside the raw file URL. Limits: MP4 container,
H.264 video with optional AAC audio, ≤100,000,000 bytes, ≤10 minutes; TTL
1h–7d (default 3d, resets on each new version). `--poster <img>` attaches a
JPEG/PNG (≤5 MiB) to the version just published, and can also be retried alone
against an existing video (`--update <id> --poster <img>`, no file argument)
without re-uploading the video. `--comments` is document-only and is rejected
for a video. Videos are unlisted-public by default like documents, so
forges (GitHub/GitLab) can render them inline from the file URL; a
`--passcode`-protected video's media is not embeddable cross-origin, so share
its watch page link instead. See [`API.md`](API.md) for the full contract.

## Configuration

Resolved with precedence **flag > env > config file > default**.

| | |
|---|---|
| Config file | `~/.config/snapdoc/config.json` (mode `0600`) |
| Env vars | `SNAPDOC_API_URL`, `SNAPDOC_TOKEN`, `SNAPDOC_BOOTSTRAP`, `SNAPDOC_PASSCODE` |
| Default API | `https://api.snapdoc.carraes.dev` |

Limits: 2 MB max document (plus ≤5 MB/image, ≤20 images, ≤25 MB bundle), 14-day
default TTL (max 90 days), 100 publishes/hour per token. Video: ≤100,000,000
bytes, ≤10 minutes, H.264 + optional AAC, 3-day default TTL (1h–7d), ≤5 MiB
poster. Artifacts are served from a cookie-free origin with `noindex, nofollow`
and unguessable 14-character IDs.

## Architecture

One Worker serves two origins: artifacts + landing on `snapdoc.carraes.dev`
(unprivileged, safe for arbitrary uploaded HTML/JS), and the JSON API + admin
dashboard on `api.snapdoc.carraes.dev` (admin behind Cloudflare Access). R2
stores blobs, D1 stores metadata and versions, an hourly cron expires and
purges. See [`API.md`](API.md) for the contract and [`docs/PRD.md`](docs/PRD.md)
for the full product spec.

## Self-hosting

The Worker lives in [`worker/`](worker/). Deploy with
[`just deploy`](justfile) (wraps `wrangler deploy`); see `worker/wrangler.toml`
for the D1/R2 bindings and required secrets (`ADMIN_BOOTSTRAP`,
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`). The dashboard SPA spec is in
[`LANDING.md`](LANDING.md).

## Releasing

`VERSION` is the single source of truth, injected into the binary at build time.
`just release 0.0.2` bumps it, commits, tags `v0.0.2`, and pushes — the GitHub
Actions workflow then builds the binaries and publishes the release.

## License

MIT — see [LICENSE](LICENSE).

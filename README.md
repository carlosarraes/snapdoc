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
```

## Commands

| Command | Description |
|---------|-------------|
| `publish [file]` | Publish HTML/Markdown from a file or stdin. Flags: `--title`, `--ttl`, `--update <id>`, `--markdown`, `--quiet/-q` |
| `list` | List your artifacts. Flags: `--status`, `--all` |
| `get <id>` | Show artifact metadata and version history |
| `expire <id>` | Expire an artifact now (URL stops serving) |
| `delete <id>` | Delete an artifact and its content |
| `token create <name>` | Mint an API token (admin). `--bootstrap` uses `SNAPDOC_BOOTSTRAP` |
| `token list` / `token revoke <id>` | Manage tokens (admin) |
| `login` | Save API URL and token to the config file |

`--update <id>` publishes a new version while keeping the same stable URL;
every other publish mints a new immutable artifact.

## Configuration

Resolved with precedence **flag > env > config file > default**.

| | |
|---|---|
| Config file | `~/.config/snapdoc/config.json` (mode `0600`) |
| Env vars | `SNAPDOC_API_URL`, `SNAPDOC_TOKEN`, `SNAPDOC_BOOTSTRAP` |
| Default API | `https://api.snapdoc.carraes.dev` |

Limits: 2 MB max artifact, 14-day default TTL (max 90 days), 100 publishes/hour
per token. Artifacts are served from a cookie-free origin with
`noindex, nofollow` and unguessable 14-character IDs.

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

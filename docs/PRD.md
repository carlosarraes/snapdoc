# snapdoc — PRD: CLI-First HTML Artifact Hoster

Triage label: `ready-for-agent`

## Locked v1 Decisions (refinement session 2026-06-12)

- **Name**: snapdoc.
- **API-first**: every capability ships as a JSON API endpoint first; the CLI, dashboard, and any future MCP server or integration are thin clients of the same contract (`API.md`).
- **Domains**: `snapdoc.carraes.dev` serves the landing page and artifacts (`/<artifact_id>`) — a cookie-free, auth-free origin so arbitrary uploaded HTML/JS holds no privilege. `api.snapdoc.carraes.dev` hosts the JSON API and the admin dashboard.
- **CLI**: Go single binary `snapdoc` (Kong for command parsing).
- **URLs**: high-entropy ~14-char random IDs only, no slugs. Version-pinned access at `/<id>/v/<n>`.
- **Limits**: 2 MB max artifact size, 14-day default TTL, 90-day max TTL, 100 publishes/hour/token. All versions retained until artifact expiry.
- **Admin auth**: Cloudflare Access gates `/admin/*` and `/v1/admin/*`; the Worker trusts the Access JWT. No custom login code.
- **Token bootstrap**: an `ADMIN_BOOTSTRAP` wrangler secret mints the first API token.
- **UI surfaces**: landing page and dashboard SPA are static assets in `worker/public/`, built separately (see `LANDING.md`); the dashboard talks only to the `/v1/admin/*` JSON API.
- **Deferred to v2**: passcode-protected artifacts (stories 14, 26, 44 below) plus everything in Out of Scope.

## Problem Statement

AI agents increasingly produce rich HTML artifacts: plans, code reviews, QA reports, architecture diagrams, dashboards, and visual explanations. These artifacts are more readable and actionable than Markdown, but they are hard to share with teammates and with other agents.

Today, the user has to choose between awkward or overpowered options: paste Markdown into chat, screenshot an interactive artifact, upload an HTML file that teammates may open as raw markup, push to a repo, configure a static host, or deploy to a full application platform. These workflows are too slow and too human-centric for agent-driven work.

The team needs a CLI-first, agent-neutral way to publish an HTML artifact and get back a stable shareable URL. The product should be useful to agents first, but still comfortable for humans reviewing, copying, expiring, and deleting artifacts.

## Solution

Build a CLI-first HTML artifact hosting service for internal/dev-team usage.

The core workflow is:

1. An agent or developer generates an HTML artifact.
2. The CLI publishes the artifact from a file or stdin.
3. The service stores the artifact, metadata, and version history.
4. The CLI prints a shareable URL, with a quiet mode that prints only the URL for agent consumption.
5. Teammates and other agents can open or fetch the URL to understand the plan/report/review.
6. The author can optionally update the same URL with a new version, expire it, delete it, or manage it through a minimal dashboard.

The initial product is not Pi-specific. It should work from any terminal, any agent harness, any script, and any HTTP client. Pi integration can be a later consumer of the generic CLI/API.

The default deployment platform is Cloudflare Workers + R2 + D1 because the product is edge-friendly, storage-light, and well-suited to Cloudflare’s free tier. AWS is a viable alternative but is not the target v1 implementation.

## User Stories

1. As an AI agent, I want to publish an HTML artifact from a command line, so that I can return a shareable URL to the user.
2. As an AI agent, I want to publish HTML via stdin, so that I can pipe generated output without writing temporary files manually.
3. As an AI agent, I want a quiet CLI mode that prints only the final URL, so that downstream tools can parse the result reliably.
4. As an AI agent, I want a stable HTTP API behind the CLI, so that I can publish artifacts even if I am not using the official CLI.
5. As an AI agent, I want to publish with a title, so that humans can identify the artifact when viewing or managing it.
6. As an AI agent, I want to set an artifact TTL, so that temporary planning context disappears automatically.
7. As an AI agent, I want to update a previous artifact URL, so that I can iterate on the same shared plan without creating a new link every time.
8. As an AI agent, I want immutable publish behavior by default, so that each independent output gets its own durable reference.
9. As an AI agent, I want to publish Markdown as a convenience, so that I can use the same publishing workflow for simpler artifacts.
10. As an AI agent, I want Markdown to render into readable HTML, so that teammates still receive a browser-native artifact.
11. As an AI agent, I want publishing errors to be machine-readable, so that I can recover or explain failures clearly.
12. As an AI agent, I want rate-limit errors to be explicit, so that I know whether to retry, reduce artifact size, or ask for a different token.
13. As an AI agent, I want artifact URLs to be readable by other agents, so that I can pass a URL to a reviewer or implementer agent as context.
14. As an AI agent, I want passcode-protected artifacts to communicate their access requirements clearly, so that I can ask the user for the passcode when needed.
15. As a developer, I want to publish an HTML file with one command, so that I can share an agent-generated report without configuring hosting.
16. As a developer, I want the CLI to accept a local file path, so that I can publish artifacts produced by any local tool.
17. As a developer, I want the CLI to accept stdin, so that I can compose it with shell pipelines and agent scripts.
18. As a developer, I want the CLI to store my API token locally, so that I do not have to pass credentials on every command.
19. As a developer, I want to authenticate with an admin-created API token, so that publishing works in headless and automated environments.
20. As a developer, I want to create new artifact URLs by default, so that unrelated outputs do not overwrite each other.
21. As a developer, I want to update an existing artifact by slug, so that I can keep a Slack/issue link stable while refining the content.
22. As a developer, I want to see the artifact URL immediately after publishing, so that I can paste it into chat, an issue, or another agent prompt.
23. As a developer, I want a `--quiet` option, so that scripts and agents can consume the publish result without parsing human-friendly logs.
24. As a developer, I want a human-readable default CLI output, so that manual publishing shows useful context like title, version, expiry, and URL.
25. As a developer, I want to set an artifact title, so that the dashboard and browser page make sense later.
26. As a developer, I want to set a passcode on sensitive artifacts, so that unlisted URLs are not the only access control.
27. As a developer, I want artifacts to be noindexed by default, so that internal planning documents do not appear in search engines.
28. As a developer, I want a default 14-day retention period, so that temporary artifacts do not pile up forever.
29. As a developer, I want to override TTL when publishing, so that short-lived and longer-lived artifacts can coexist.
30. As a developer, I want to delete an artifact, so that mistakes and sensitive uploads can be removed.
31. As a developer, I want to expire an artifact, so that its URL stops serving content without needing to delete historical metadata immediately.
32. As a developer, I want to view prior versions of an artifact, so that I can understand how a plan or review changed over time.
33. As a developer, I want a stable latest URL for versioned artifacts, so that shared links continue to show the current version.
34. As a developer, I want version-specific URLs, so that I can reference exactly what was reviewed at a point in time.
35. As a developer, I want clear file size limits, so that I know when to simplify or compress generated artifacts.
36. As a developer, I want clear unsupported-asset behavior, so that I know v1 expects self-contained HTML rather than a folder of files.
37. As a developer, I want generated pages to preserve CSS and JavaScript, so that interactive reports and diagrams still work.
38. As a developer, I want uploaded artifacts isolated from the application domain, so that arbitrary HTML cannot access app cookies or privileged state.
39. As a developer, I want sensible security headers, so that artifact rendering does not accidentally compromise the management application.
40. As a developer, I want the service to be CLI-first rather than dashboard-first, so that agents remain first-class users.
41. As a team member, I want to open a shared artifact URL in a browser, so that I can review an agent-generated plan or report without local setup.
42. As a team member, I want to open artifact URLs on my phone, so that I can review plans away from my workstation.
43. As a team member, I want artifact pages to render as HTML rather than raw source, so that I can read the artifact naturally.
44. As a team member, I want passcode-protected artifacts to show a simple access screen, so that sensitive links can still be shared safely.
45. As a team member, I want expired artifacts to show a clear expired state, so that I understand why a link no longer works.
46. As a team member, I want deleted artifacts to stop serving content, so that accidental uploads can be remediated.
47. As a team member, I want pages to load quickly, so that reviewing agent output feels lightweight.
48. As a team member, I want URLs to be high-entropy and unguessable, so that unlisted artifacts are not easy to enumerate.
49. As a team member, I want the artifact header to show the title and draft/hosted status, so that I know what I am reviewing.
50. As a team member, I want no account requirement for simply viewing unprotected links, so that sharing remains low-friction.
51. As an admin, I want to create API tokens, so that agents and developers can publish without shared personal credentials.
52. As an admin, I want to revoke API tokens, so that lost or compromised credentials can be disabled.
53. As an admin, I want tokens to have clear names, so that I know which agent, developer, or automation owns each token.
54. As an admin, I want token usage metadata, so that I can identify stale or abusive credentials.
55. As an admin, I want a minimal dashboard, so that I can manage artifacts and tokens without using raw database tools.
56. As an admin, I want to list artifacts, so that I can find what has been published.
57. As an admin, I want to search or filter artifacts by title, slug, creator token, status, and expiry, so that management remains practical as usage grows.
58. As an admin, I want to copy artifact URLs from the dashboard, so that I can reshare links easily.
59. As an admin, I want to view artifact metadata and version history, so that I can audit what was published and when.
60. As an admin, I want to delete or expire artifacts from the dashboard, so that I can clean up sensitive or obsolete content.
61. As an admin, I want to create and revoke tokens from the dashboard, so that onboarding and offboarding are easy.
62. As an admin, I want the dashboard to require authentication, so that artifact management is not public.
63. As an admin, I want storage and request usage to be visible at a coarse level, so that I can avoid surprise platform limits.
64. As an operator, I want expired artifacts to be cleaned up automatically, so that storage costs and clutter stay bounded.
65. As an operator, I want artifact serving to be cache-friendly where safe, so that read traffic is cheap and fast.
66. As an operator, I want artifact metadata to remain separate from blob content, so that listing and serving can be implemented efficiently.
67. As an operator, I want uploads to enforce size limits, so that a single artifact cannot exhaust storage or CPU limits.
68. As an operator, I want publish requests to enforce rate limits, so that tokens cannot abuse the service accidentally or maliciously.
69. As an operator, I want delete and expiry operations to be idempotent, so that retries are safe.
70. As an operator, I want serving behavior to distinguish missing, expired, deleted, and passcode-required artifacts, so that debugging is clear.
71. As a future paying customer, I want permanent retention as an upgrade path, so that important artifacts can become durable team knowledge.
72. As a future paying customer, I want custom domains eventually, so that artifacts can live under a company-controlled URL.
73. As a future paying customer, I want company auth eventually, so that sensitive artifacts can be restricted to my organization.
74. As a future paying customer, I want comments eventually, so that artifact review can become a feedback loop.
75. As a future paying customer, I want agent-readable comments eventually, so that agents can incorporate teammate feedback without manual copy/paste.

## Implementation Decisions

- The product is CLI-first and agent-neutral. It must not depend on Pi-specific primitives. Pi, Claude Code, Codex, Cursor, shell scripts, and arbitrary HTTP clients should all be able to use it.
- The target v1 user is an internal/dev-team user publishing agent-generated artifacts for teammates and other agents.
- The v1 access model is unlisted high-entropy URLs by default and `noindex,nofollow` by default. Passcode protection per artifact is deferred to v2. Company SSO is intentionally deferred.
- Uploaded artifacts may contain arbitrary self-contained HTML, CSS, and JavaScript. To make this safe enough for v1, artifacts must be served from an isolated artifact origin that does not share cookies or privileged state with the management/API origin.
- The default platform is Cloudflare Workers + R2 + D1.
- R2 stores artifact blobs.
- D1 stores artifact metadata, version records, token records, status, expiry information, and management data.
- Workers expose the publish API, artifact-serving routes, dashboard routes, and scheduled cleanup.
- The primary CLI command publishes from a file or stdin and supports title, TTL, update target, and quiet output.
- The CLI must support deterministic headless authentication using admin-created API tokens stored locally by the CLI.
- API tokens are the v1 publisher auth mechanism. Anonymous auto-registration and OAuth/device-code auth are deferred.
- Every publish creates a new immutable artifact by default.
- The product also supports updating an existing artifact slug. An update creates a new version while keeping the stable latest URL available.
- Version-specific access should be supported so a previous reviewed version can still be referenced if retained.
- Default retention is 14 days.
- The CLI/API can override retention with bounded TTL values. Permanent retention may exist as a configured/admin-only option but is primarily a future monetization lever.
- v1 accepts HTML as the core artifact contract.
- v1 accepts Markdown as a convenience input and converts it into styled HTML before storage/serving.
- v1 does not support multi-file directory deployments or separate asset uploads. Artifacts should be self-contained, including embedded assets when necessary.
- The service must enforce artifact size limits. The limit is 2 MB for v1, configurable server-side.
- The dashboard is included in v1 but remains minimal. It supports artifact list/detail management, copying URLs, viewing metadata and versions, deleting/expiring artifacts, and creating/revoking API tokens.
- The dashboard is a management surface, not the primary publishing surface.
- The dashboard must require authentication. v1 uses Cloudflare Access in front of `/admin/*` and `/v1/admin/*`; the Worker verifies the Access JWT.
- Comments, inline annotations, and agent-readable feedback loops are deferred to v2.
- Public search indexing is opt-out by default via noindex. Any future public-discoverable mode must be explicit.
- The artifact-serving layer should clearly handle active, expired, deleted, and missing states (passcode states arrive in v2).
- (v2) Passcodes should not be stored in plaintext. Store a secure hash and use a short-lived viewer session/cookie scoped only to the artifact origin when access is granted.
- A cleanup job should remove or tombstone expired artifacts according to retention policy.
- The storage layer should be a deep module with a narrow interface for storing, retrieving, versioning, expiring, and deleting artifacts. This keeps Cloudflare-specific details isolated from API/CLI behavior.
- The metadata/versioning layer should be a deep module that owns artifact lifecycle rules and exposes stable operations rather than leaking raw database queries across the application.
- The Markdown renderer should be a replaceable module. Its contract is to convert trusted input text into a self-contained HTML artifact with predictable styling.
- The CLI should be a thin but polished client of the public API. Business rules should live server-side wherever possible so other agents and HTTP clients behave consistently.
- API responses should be suitable for both humans and machines. Errors should have stable codes/messages for agent recovery.
- The product should reserve clear future expansion points for custom domains, company SSO, comments, analytics, billing, and MCP integrations.

## Image Hosting (post-v1)

Refines the v1 "self-contained, no separate asset uploads" stance for the common case of a report that references local images. Full multi-file site hosting and a general media library remain out of scope.

- A publish may bundle the document plus the images it references in one atomic `multipart/form-data` request; the JSON/raw-body publish is unchanged. The capability is API-first: the CLI auto-detects and attaches local image refs, but the server owns upload and reference rewriting so every client behaves identically.
- Images are stored as separate, content-addressed (SHA-256) R2 blobs under the artifact, deduplicated across versions, and served from the artifact origin at `/{id}/a/{sha256}` with the same status/passcode gate as the page.
- The server rewrites the document's local `<img src>` references to hosted URLs; remote, `data:`, and absolute refs pass through untouched, and unmatched local refs are reported in `unresolved_refs`.
- Each version carries the images it references (atomic bundle); changing an image is a new version. There is no standalone asset CRUD.
- Raster formats only (png/jpeg/gif/webp/avif); SVG is rejected to avoid script-in-SVG XSS via direct navigation to an asset URL. Limits: ≤5 MB/image, ≤20 images, ≤25 MB bundle; the document stays ≤2 MB.
- Agent discoverability: `publish --help` documents the behavior, and a `snapdoc llm` command prints a compact, agent-oriented guide to the whole CLI.

## Video Artifacts (first-class, delivered)

snapdoc hosts MP4 recordings (QA evidence, walkthroughs, bug repros) as their
own first-class artifact `kind`, alongside — not embedded inside — HTML/Markdown
documents. This is a separate publish path with its own limits, TTL, and
serving behavior, not a document feature.

- A video artifact is created by `POST /v1/artifacts` (or versioned by
  `POST /v1/artifacts/{id}/versions`) with `Content-Type: video/mp4`; an
  artifact's `kind` (`document` or `video`) is fixed for its lifetime —
  publishing the wrong kind onto an existing artifact is rejected
  (`kind_mismatch`).
- Accepted format: MP4 container, H.264 video (`avc1`/`avc3`), optional AAC
  audio. Limits: ≤100,000,000 bytes (`Content-Length` required, checked before
  any byte streams), ≤600 seconds (10 minutes). TTL defaults to 3 days (bounds
  1h–7d, narrower than a document's 14-day default/90-day max), reset on every
  new version. Metadata (duration, dimensions, codecs) is derived server-side
  by bounded MP4 inspection — never a full-file parse — and returned as
  additive JSON fields (`duration_ms`, `width`, `height`, `video_codec`,
  `audio_codec`) alongside a stable `file_url`/`poster_url`.
- Serving supports HTTP byte-range requests (`206`/`416`, `HEAD`) so browsers
  can seek without downloading the whole file, a server-rendered watch page
  (`/{id}`, `/{id}/v/{n}`) with a native `<video>` player, and an optional
  poster image (`PUT .../poster`, sniffed JPEG/PNG, ≤5 MiB). Video blobs are
  purged immediately on expiry (no grace period, unlike a document's), because
  they are much larger; an hourly cron audits for orphaned video blobs.
  Passcode protection extends to the media/poster routes themselves (not just
  the watch page), at the cost of cross-origin embedding — the file/media URL
  of a protected video is not fetchable by a forge (GitHub/GitLab) the way an
  unprotected one is.
- The CLI auto-detects an `.mp4` file argument, runs a local preflight before
  uploading, and supports a poster-only retry (`--update <id> --poster <img>`
  with no file argument) so a failed poster upload never requires
  re-publishing the video. `snapdoc llm` documents the whole flow for agents.
- Reader comments (line/text-anchored feedback) remain document-only; a video
  publish rejects `comments=1`.
- **Explicitly deferred**: embedding a video *inside* an HTML/Markdown
  document (e.g. an uploaded `<video>` referenced like a hosted image) is out
  of scope. Video is its own artifact kind with its own URL, not an asset type
  a document can reference the way it can reference images today.

## Testing Decisions

- Good tests should verify externally observable behavior rather than implementation details. For example, tests should assert that publishing returns a URL, creates metadata, stores content, and serves the artifact with correct access behavior; they should not assert private helper calls or database query shapes.
- The CLI publisher should be tested through command behavior: file input, stdin input, title/TTL/passcode flags, update flags, quiet output, success output, and error output.
- The publish API should be tested through HTTP contracts: successful HTML publish, Markdown publish, unauthorized publish, invalid token, oversize artifact, invalid TTL, and update publish.
- Token auth should be tested through external outcomes: valid tokens publish successfully, revoked tokens fail, missing tokens fail, and token metadata updates when used.
- Artifact storage should be tested through its public interface: store, retrieve, missing object, delete/tombstone, and version lookup behavior.
- Metadata/versioning should be tested through lifecycle behavior: new publish creates v1, update creates v2 at the same stable slug, immutable publish creates a new slug, version-specific reads return the intended version, expiry changes serving behavior, and deletion stops content serving.
- Artifact serving should be tested through HTTP behavior: active artifacts render, expired artifacts show an expired response, deleted artifacts do not render, missing artifacts show a not-found response, and security/noindex headers are present.
- TTL cleanup should be tested through scheduled-job behavior: expired artifacts are cleaned or tombstoned, non-expired artifacts remain, and repeated cleanup is idempotent.
- Markdown rendering should be tested through representative input/output behavior, ensuring it produces readable self-contained HTML without testing the internals of the Markdown library.
- Dashboard behavior should be tested from a user perspective: authenticated admins can list artifacts, view details, copy/find URLs, delete/expire artifacts, create tokens, revoke tokens, and unauthenticated users cannot access management views.
- Security behavior should be tested around origin/cookie isolation assumptions, artifact response headers, and dashboard auth boundaries.
- There is no existing codebase test prior art in the current repository because the repository is effectively empty. The implementer should establish the project’s first testing conventions as part of this work.

## Out of Scope

- Passcode-protected artifacts (deferred to v2).
- Pi-specific integration, Pi tools, or Pi-only workflows.
- MCP integration for v1.
- Browser extensions.
- Multi-file site hosting or directory deploys.
- Standalone asset upload / general media library (referenced-image bundling exists — see Image Hosting).
- Video embedded *inside* an HTML/Markdown document (deferred — see Video Artifacts; first-class standalone video artifacts are delivered).
- Visual HTML editing.
- ~~Inline comments.~~ Delivered: reader comments anchor to a text selection via a public review page (owner opt-in per artifact).
- ~~Agent-readable comment resolution.~~ Delivered: `snapdoc comments <id>` surfaces reader feedback with its quoted context for the next iteration.
- Company SSO or Google/Microsoft Workspace authentication for artifact viewing.
- Public discovery, sitemap publishing, or SEO-oriented hosting.
- Billing implementation.
- Custom domains.
- Team member/role management beyond minimal dashboard/admin/token access.
- Full analytics, audit logs, or compliance reporting.
- Abuse-detection systems beyond basic size limits, rate limits, noindex defaults, and token-based publishing.
- AWS implementation in v1.
- Native desktop app.

## Further Notes

- The idea was inspired by a video demonstrating “Postplan,” a hosted HTML draft service used to share agent-generated plans and reviews with a team.
- Market research shows this category already exists or is emerging. Relevant products include ShipPage, htmlbin.dev, Pubby, Shareframe.dev, and htmlhost.co.
- The strongest differentiation is not generic public HTML hosting. The sharper wedge is private/internal agent artifact sharing: CLI-first publishing, stable URLs, versioning, safe defaults, dashboard management, and later team-oriented features like company auth and comments.
- Cloudflare is preferred because it has a strong free-tier fit for this workload: Workers for API/serving, R2 for blob storage with free egress, and D1 for metadata/versioning.
- The likely monetization path is retention, custom domains, team auth, comments, audit/history, and higher limits, not basic public URL generation.
- The issue tracker was not configured in the current workspace, so this PRD is published locally and marked with the intended `ready-for-agent` triage label.

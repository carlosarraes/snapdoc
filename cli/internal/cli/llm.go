package cli

import "fmt"

// LLMCmd prints a compact, token-efficient guide to driving snapdoc as an agent.
type LLMCmd struct{}

func (l *LLMCmd) Run(g *Globals, streams *IO) error {
	fmt.Fprint(streams.Stdout, llmGuide)
	return nil
}

const llmGuide = `snapdoc — publish self-contained HTML/Markdown artifacts and get a shareable URL.
Built for AI agents: publish a report, share the link, iterate on feedback.

AUTH
  snapdoc login --api-url <url> --token <sd_live_...>   # or set SNAPDOC_API_URL + SNAPDOC_TOKEN
  snapdoc whoami                                        # verify the token

PUBLISH
  snapdoc publish report.md --title "Q3 review" --ttl 7d
  cat report.md | snapdoc publish - --markdown
  snapdoc publish report.html --quiet                  # print only the URL
  Add --json to any command for machine-readable output.
  Fenced Mermaid blocks in Markdown render natively with a readable source
  fallback; add accTitle and accDescr directives for accessible diagrams.
  Schema tooltips: types defined in fenced python/ts code blocks (Python
  class; TS interface/class/enum/type) turn every exact-name mention in
  other code blocks and inline code into a hoverable reference showing the
  definition. Define schemas once in one fenced block, then reference them
  by exact name; names not defined in the document stay plain, so readers
  can tell at a glance what the document defines versus imports.

PUBLISH WITH IMAGES
  Reference images with normal relative paths:
    Markdown  ![diagram](diagram.png)      HTML  <img src="shots/a.png">
  On publish, snapdoc uploads the local files next to your document, hosts them,
  and rewrites the references to hosted URLs. Remote https:// and data: refs are
  left untouched. Use --assets-base DIR if images live elsewhere, or --no-assets
  to disable. The response's unresolved_refs lists local refs no file matched.
  Limits: <=5 MB/image, <=20 images, <=25 MB total. Formats: png, jpeg, gif,
  webp, avif (SVG is not supported).

UPDATE (new version, same URL)
  snapdoc publish report.md --update <id>

PUBLISH A VIDEO (MP4 recording, e.g. QA evidence)
  snapdoc publish recording.mp4 --title "ABC-123 QA @ a1b2c3d" --ttl 3d --poster happy-path.jpg
  snapdoc publish recording.mp4 --update <id>              # new version, same URL
  A .mp4 file argument is auto-detected: it is streamed with an exact
  Content-Length (never from stdin — pipe a video and you'll get a clear
  rejection), after local preflight rejects obviously invalid files before
  anything uploads. Limits: MP4 container, H.264 video, optional AAC audio,
  <=100,000,000 bytes, <=10 minutes. TTL 1h-7d (default 3d if omitted — let the
  server default it rather than passing one). --poster attaches a JPEG or PNG
  (<=5 MiB, sniffed locally and again server-side) to the version just
  published; --passcode applies only when creating (not on --update); --comments
  is document-only and is rejected outright for a video.
  Human output prints the watch URL, raw file URL, duration, size, and expiry;
  --json prints every additive media field (kind, file_url, poster_url,
  duration_ms, width, height, video_codec, audio_codec, and their
  version-specific counterparts).
  Videos are unlisted-public by default (like documents) so GitHub/GitLab can
  render them inline from the file URL; add --passcode to protect one, but a
  protected video's watch page requires unlocking first, so share it as a link
  rather than an inline embed.

RETRY A FAILED POSTER (no video re-upload)
  snapdoc publish --update <id> --poster fixed.jpg   # no file argument
  Poster upload is a separate request after the video succeeds, so a bad image
  never blocks the video itself — but if it fails, the failure names the exact
  command above (with the real artifact ID and version) to retry. That form
  (--update <id> plus --poster, no file argument) fetches the artifact, checks
  it's actually a video, and re-uploads only the poster against its current
  version — it never re-publishes the video or creates a new version.
  --poster only makes sense in two shapes: with a video file (create or
  --update), or alone with --update and no file (the retry above); pairing it
  with a document file, or with neither a file nor --update, is rejected.

READ (token-cheap; Markdown by default)
  snapdoc read <id>            # Markdown (fewer tokens than HTML)
  snapdoc read <id> --raw      # original HTML
  snapdoc read <id> --rev 2    # a specific version
  Add --passcode <code> (or set SNAPDOC_PASSCODE) for protected artifacts.

INSPECT
  snapdoc list --status active        # your artifacts (--all to fetch every page)
  snapdoc get <id>                    # metadata, versions, and hosted images
  snapdoc comments <id> -s open       # read reviewer feedback before iterating

COLLECT FEEDBACK (anyone with the link, no account)
  snapdoc publish report.md --comments   # opt in at publish, or later:
  snapdoc comments enable <id>           # prints a /review/<id> link to share
  snapdoc comments disable <id>
  Reviewers highlight text on the review page and comment on the exact span.
  Read it back with the quoted context to drive the next version — reader lines
  show "(reader)" and the quote. Reader comments and --passcode are exclusive.

LIFECYCLE
  snapdoc expire <id>     # make it unavailable now
  snapdoc delete <id>     # remove it and its hosted images

LIMITS
  Document <=2 MB. TTL 1h-90d (default 14d). 100 publishes/hour/token.
  Video <=100,000,000 bytes, <=10 min, H.264 (+ optional AAC). TTL 1h-7d
  (default 3d). Poster <=5 MiB, JPEG or PNG.
`

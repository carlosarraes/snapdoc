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

READ (token-cheap; Markdown by default)
  snapdoc read <id>            # Markdown (fewer tokens than HTML)
  snapdoc read <id> --raw      # original HTML
  snapdoc read <id> --rev 2    # a specific version
  Add --passcode <code> (or set SNAPDOC_PASSCODE) for protected artifacts.

INSPECT
  snapdoc list --status active        # your artifacts (--all to fetch every page)
  snapdoc get <id>                    # metadata, versions, and hosted images
  snapdoc comments <id> -s open       # read reviewer feedback before iterating

LIFECYCLE
  snapdoc expire <id>     # make it unavailable now
  snapdoc delete <id>     # remove it and its hosted images

LIMITS
  Document <=2 MB. TTL 1h-90d (default 14d). 100 publishes/hour/token.
`

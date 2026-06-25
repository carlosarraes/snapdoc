package cli

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/carlosarraes/snapdoc/cli/internal/api"
)

var (
	imgTagRe = regexp.MustCompile(`(?i)<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	mdImgRe  = regexp.MustCompile(`!\[[^\]]*\]\(\s*<?([^)\s>]+)>?`)
	schemeRe = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.\-]*:`)
)

// extractImageRefs returns the document's local image references in order of
// first appearance. It is a best-effort attach-list: the server performs the
// authoritative rewrite, so over- or under-matching here only affects which
// files get uploaded, never correctness of the served page.
func extractImageRefs(content string, isMarkdown bool) []string {
	seen := map[string]bool{}
	var refs []string
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] || !isLocalRef(s) {
			return
		}
		seen[s] = true
		refs = append(refs, s)
	}
	for _, m := range imgTagRe.FindAllStringSubmatch(content, -1) {
		add(firstNonEmpty(m[1], m[2], m[3]))
	}
	if isMarkdown {
		for _, m := range mdImgRe.FindAllStringSubmatch(content, -1) {
			add(m[1])
		}
	}
	return refs
}

// isLocalRef reports whether src is a bare relative path that could name a
// bundled file — not a URL, protocol-relative, root-absolute, or fragment.
func isLocalRef(src string) bool {
	if src == "" {
		return false
	}
	if schemeRe.MatchString(src) || strings.HasPrefix(src, "//") || strings.HasPrefix(src, "/") || strings.HasPrefix(src, "#") {
		return false
	}
	return true
}

// resolveAssets maps refs to local files under base. Missing files are skipped
// (the server leaves the ref as-is) with a warning unless quiet; refs that
// escape base via "../" are ignored.
func resolveAssets(refs []string, base string, warn io.Writer, quiet bool) []api.AssetFile {
	var out []api.AssetFile
	for _, ref := range refs {
		clean := ref
		if i := strings.IndexAny(clean, "?#"); i >= 0 {
			clean = clean[:i]
		}
		if dec, err := url.PathUnescape(clean); err == nil {
			clean = dec
		}
		p := filepath.Join(base, filepath.FromSlash(clean))
		rel, err := filepath.Rel(base, p)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		info, statErr := os.Stat(p)
		if statErr != nil || info.IsDir() {
			if !quiet {
				fmt.Fprintf(warn, "snapdoc: skipping image %q (not found under %s)\n", ref, base)
			}
			continue
		}
		out = append(out, api.AssetFile{Ref: ref, Path: p})
	}
	return out
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

package cli

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/carlosarraes/snapdoc/cli/internal/api"
	"github.com/carlosarraes/snapdoc/cli/internal/video"
)

type PublishCmd struct {
	File       string `arg:"" optional:"" help:"File to publish; '-' or omitted reads stdin."`
	Title      string `help:"Artifact title."`
	TTL        string `help:"Time to live, e.g. 12h, 7d (server-validated)."`
	Update     string `help:"Artifact ID to update with a new version." placeholder:"ID"`
	Markdown   bool   `help:"Treat input as Markdown (auto-detected for .md/.markdown files)."`
	Passcode   string `help:"Protect a new artifact with a passcode (applies only when creating)."`
	Comments   bool   `help:"Allow anyone with the link to post line-anchored comments via the review page (cannot combine with --passcode)."`
	NoAssets   bool   `help:"Don't auto-upload local images; publish references as-is."`
	AssetsBase string `help:"Directory to resolve relative image paths against (default: the document's folder, or CWD for stdin)." placeholder:"DIR"`
	Poster     string `help:"Poster image (JPEG or PNG, <=5 MiB) to attach to a video artifact." placeholder:"FILE"`
	Quiet      bool   `short:"q" help:"Print only the artifact URL."`
}

func (p *PublishCmd) Run(g *Globals, streams *IO) error {
	// A poster-only retry: --update <id> --poster <img> with no file argument
	// at all. This is the only way to fix a failed poster upload without
	// republishing the video (which would mint a whole new version).
	if p.Poster != "" && p.Update != "" && p.File == "" {
		return p.runPosterOnly(g, streams)
	}

	// Video is detected before readInput ever runs: it needs the file's exact
	// size up front (for Content-Length) and never goes through the
	// document/markdown/multipart path below.
	if isVideoFile(p.File) {
		return p.runVideo(g, streams)
	}

	// Any other --poster combination is invalid: a poster only makes sense
	// alongside a video file, or alone against an existing video via --update.
	if p.Poster != "" {
		return posterFlagError(p)
	}

	stdin := streams.Stdin
	if (p.File == "" || p.File == "-") && !stdinIsTerminal(stdin) {
		// A named .mp4 file is caught above; piped video can only be caught
		// by sniffing its magic bytes, since stdin carries no filename. Video
		// uploads require an exact Content-Length, which stdin cannot supply,
		// so this is a hard rejection rather than a fallback.
		wrapped, err := rejectVideoOnStdin(stdin)
		if err != nil {
			return err
		}
		stdin = wrapped
	}

	content, err := p.readInput(stdin)
	if err != nil {
		return err
	}
	contentType := "text/html"
	if p.Markdown || isMarkdownFile(p.File) {
		contentType = "text/markdown"
	}

	client, err := g.client()
	if err != nil {
		return err
	}
	opts := api.PublishOptions{Title: p.Title, TTL: p.TTL, Comments: p.Comments}

	var assets []api.AssetFile
	if !p.NoAssets {
		refs := extractImageRefs(string(content), contentType == "text/markdown")
		assets = resolveAssets(refs, p.assetsBaseDir(), streams.Stderr, p.Quiet)
	}

	var artifact *api.Artifact
	if p.Update != "" {
		if len(assets) > 0 {
			artifact, err = client.PublishVersionMultipart(p.Update, bytes.NewReader(content), contentType, assets, opts)
		} else {
			artifact, err = client.PublishVersion(p.Update, bytes.NewReader(content), contentType, opts)
		}
	} else {
		opts.Passcode = p.Passcode // passcode is set only when creating an artifact
		if len(assets) > 0 {
			artifact, err = client.PublishMultipart(bytes.NewReader(content), contentType, assets, opts)
		} else {
			artifact, err = client.Publish(bytes.NewReader(content), contentType, opts)
		}
	}
	if err != nil {
		return err
	}

	if g.JSON {
		return writeJSON(streams.Stdout, artifact)
	}
	if p.Quiet {
		fmt.Fprintln(streams.Stdout, artifact.URL)
		return nil
	}
	verb := "Published"
	if p.Update != "" {
		verb = "Updated"
	}
	fmt.Fprintf(streams.Stdout, "%s %s (version %d)\n", verb, artifact.ID, artifact.CurrentVersion)
	if artifact.Title != "" {
		fmt.Fprintf(streams.Stdout, "  Title:   %s\n", artifact.Title)
	}
	fmt.Fprintf(streams.Stdout, "  Expires: %s\n", artifact.ExpiresAt)
	fmt.Fprintf(streams.Stdout, "  URL:     %s\n", artifact.URL)
	return nil
}

// assetsBaseDir is where relative image refs are resolved: an explicit
// --assets-base wins, else the document's own folder, else CWD (for stdin).
func (p *PublishCmd) assetsBaseDir() string {
	if p.AssetsBase != "" {
		return p.AssetsBase
	}
	if p.File != "" && p.File != "-" {
		return filepath.Dir(p.File)
	}
	return "."
}

func (p *PublishCmd) readInput(stdin io.Reader) ([]byte, error) {
	if p.File != "" && p.File != "-" {
		return os.ReadFile(p.File)
	}
	if p.File == "" && stdinIsTerminal(stdin) {
		return nil, errors.New("no input: pass a file argument or pipe content to stdin")
	}
	return io.ReadAll(stdin)
}

func stdinIsTerminal(stdin io.Reader) bool {
	f, ok := stdin.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func isMarkdownFile(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown")
}

// maxPosterBytes mirrors the worker's MAX_POSTER_BYTES binding (5 MiB).
const maxPosterBytes = 5 * 1024 * 1024

// isVideoFile reports whether name names a regular, on-disk file with a
// lowercase .mp4 extension — the sole signal that routes Run into runVideo,
// checked before any input is read.
func isVideoFile(name string) bool {
	if name == "" || name == "-" {
		return false
	}
	if !strings.HasSuffix(strings.ToLower(name), ".mp4") {
		return false
	}
	info, err := os.Stat(name)
	return err == nil && info.Mode().IsRegular()
}

// rejectVideoOnStdin peeks stdin for an MP4 "ftyp" box without consuming it
// (the returned reader still yields every byte, peeked or not) and, if found,
// returns a rejection: video uploads always declare an exact Content-Length,
// which a stdin pipe cannot provide, so there is no streaming fallback.
func rejectVideoOnStdin(stdin io.Reader) (io.Reader, error) {
	br := bufio.NewReader(stdin)
	peek, _ := br.Peek(8)
	if len(peek) >= 8 && string(peek[4:8]) == "ftyp" {
		return br, errors.New("video input detected on stdin: video uploads require an exact Content-Length and cannot be streamed from stdin; pass the file path instead, e.g. `snapdoc publish recording.mp4`")
	}
	return br, nil
}

// runVideo is the whole video publish path: local preflight, then a
// streamed create/update of the raw MP4, then an optional poster upload.
// It never touches readInput's document/markdown/multipart machinery.
func (p *PublishCmd) runVideo(g *Globals, streams *IO) error {
	if p.Comments {
		return errors.New("--comments is document-only; video artifacts do not support reader comments")
	}

	meta, err := video.Inspect(p.File)
	if err != nil {
		return err
	}

	f, err := os.Open(p.File)
	if err != nil {
		return err
	}
	defer f.Close()

	client, err := g.client()
	if err != nil {
		return err
	}

	opts := api.VideoPublishOptions{
		Title:    p.Title,
		TTL:      p.TTL,
		Filename: filepath.Base(p.File),
		Size:     meta.Size,
	}

	var artifact *api.Artifact
	if p.Update != "" {
		artifact, err = client.PublishVideoVersion(p.Update, f, opts)
	} else {
		opts.Passcode = p.Passcode // passcode is set only when creating an artifact
		artifact, err = client.PublishVideo(f, opts)
	}
	if err != nil {
		return err
	}

	if p.Poster != "" {
		if _, perr := p.uploadPoster(client, artifact.ID, artifact.CurrentVersion); perr != nil {
			// The video itself published fine; only the poster failed. Name
			// the artifact, version, and the exact retry command so the
			// poster alone can be retried without re-uploading the video.
			return fmt.Errorf(
				"video published as artifact %s (version %d), but poster upload failed: %v — the video was not affected; retry with: snapdoc publish --update %s --poster %s",
				artifact.ID, artifact.CurrentVersion, perr, artifact.ID, p.Poster,
			)
		}
	}

	return p.printVideoResult(g, streams, artifact)
}

// runPosterOnly retries a poster upload against an existing video artifact's
// current version without touching the video itself: no file argument is
// read, no new version is created. This is the only way to fix a poster that
// failed on a previous publish/update without republishing the video.
func (p *PublishCmd) runPosterOnly(g *Globals, streams *IO) error {
	if err := p.posterOnlyFlagError(); err != nil {
		return err
	}

	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.Get(p.Update)
	if err != nil {
		return err
	}
	if res.Artifact.Kind != "video" {
		return fmt.Errorf("artifact %s is not a video artifact (kind=%q); posters only apply to video artifacts", p.Update, res.Artifact.Kind)
	}
	version := res.Artifact.CurrentVersion

	v, err := p.uploadPoster(client, p.Update, version)
	if err != nil {
		return fmt.Errorf(
			"poster upload failed for artifact %s (version %d): %v — retry with: snapdoc publish --update %s --poster %s",
			p.Update, version, err, p.Update, p.Poster,
		)
	}
	return p.printPosterOnlyResult(g, streams, v)
}

// posterOnlyFlagError rejects any document-publish flag alongside a
// poster-only retry: that mode only ever PUTs the poster against the
// artifact's existing current version, so --title/--ttl/--markdown would
// silently do nothing and --comments is video-incompatible anyway (mirroring
// runVideo's hard-error stance on --comments rather than ignoring it).
func (p *PublishCmd) posterOnlyFlagError() error {
	var ignored []string
	if p.Comments {
		ignored = append(ignored, "--comments")
	}
	if p.Title != "" {
		ignored = append(ignored, "--title")
	}
	if p.TTL != "" {
		ignored = append(ignored, "--ttl")
	}
	if p.Markdown {
		ignored = append(ignored, "--markdown")
	}
	if len(ignored) == 0 {
		return nil
	}
	return fmt.Errorf(
		"%s has no effect in poster-only mode (--update <id> --poster <file> with no file argument retries only the poster upload against the existing version)",
		strings.Join(ignored, ", "),
	)
}

// posterFlagError explains why --poster was rejected: either it was paired
// with a non-video (document) file, or with neither a video file nor
// --update (with no file) to target an existing video.
func posterFlagError(p *PublishCmd) error {
	if p.File != "" && p.File != "-" {
		return fmt.Errorf("--poster only applies to video artifacts; %s is not an .mp4 video file", p.File)
	}
	return errors.New(
		"--poster requires either a video file to publish (snapdoc publish recording.mp4 --poster img.jpg) " +
			"or --update <id> with no file argument to retry a poster against an existing video version " +
			"(snapdoc publish --update <id> --poster img.jpg)",
	)
}

// uploadPoster sniffs path as a JPEG or PNG (no larger than maxPosterBytes)
// and streams it to the given artifact/version's poster endpoint.
func (p *PublishCmd) uploadPoster(client *api.Client, id string, version int) (*api.Version, error) {
	contentType, size, err := sniffPosterFile(p.Poster)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p.Poster)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return client.UploadVideoPoster(id, version, f, contentType, size)
}

// sniffPosterFile validates a poster file locally before it ever leaves the
// machine: it must be a non-empty, <=5 MiB regular file whose magic bytes are
// a real JPEG or PNG (the server enforces the same sniff independently).
func sniffPosterFile(path string) (contentType string, size int64, err error) {
	fi, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	if fi.IsDir() {
		return "", 0, fmt.Errorf("%s is a directory, not a poster image", path)
	}
	if fi.Size() <= 0 {
		return "", 0, fmt.Errorf("%s is empty", path)
	}
	if fi.Size() > maxPosterBytes {
		return "", 0, fmt.Errorf("poster exceeds the %d-byte size limit (got %d bytes)", maxPosterBytes, fi.Size())
	}

	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	var magic [8]byte
	n, err := io.ReadFull(f, magic[:])
	if err != nil && err != io.ErrUnexpectedEOF {
		return "", 0, fmt.Errorf("reading poster %s: %w", path, err)
	}
	switch {
	case n >= 3 && magic[0] == 0xFF && magic[1] == 0xD8 && magic[2] == 0xFF:
		contentType = "image/jpeg"
	case n >= 8 && bytes.Equal(magic[:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		contentType = "image/png"
	default:
		return "", 0, fmt.Errorf("%s is not a JPEG or PNG image (poster must be a sniffed JPEG or PNG)", path)
	}
	return contentType, fi.Size(), nil
}

// printVideoResult renders a video artifact: --json prints the raw server
// object, --quiet prints only the watch URL, and human output adds the file
// URL, duration, size, and expiry to the same watch URL.
func (p *PublishCmd) printVideoResult(g *Globals, streams *IO, a *api.Artifact) error {
	if g.JSON {
		return writeJSON(streams.Stdout, a)
	}
	if p.Quiet {
		fmt.Fprintln(streams.Stdout, a.URL)
		return nil
	}
	verb := "Published"
	if p.Update != "" {
		verb = "Updated"
	}
	fmt.Fprintf(streams.Stdout, "%s %s (version %d)\n", verb, a.ID, a.CurrentVersion)
	if a.Title != "" {
		fmt.Fprintf(streams.Stdout, "  Title:    %s\n", a.Title)
	}
	fmt.Fprintf(streams.Stdout, "  Watch:    %s\n", a.URL)
	fmt.Fprintf(streams.Stdout, "  File:     %s\n", a.FileURL)
	fmt.Fprintf(streams.Stdout, "  Duration: %s\n", (time.Duration(a.DurationMs) * time.Millisecond).String())
	fmt.Fprintf(streams.Stdout, "  Size:     %d bytes\n", a.SizeBytes)
	fmt.Fprintf(streams.Stdout, "  Expires:  %s\n", a.ExpiresAt)
	return nil
}

// printPosterOnlyResult renders a poster-only retry's result: --json prints
// the raw server object (the updated version), --quiet prints only the watch
// URL, and human output confirms the update plus the poster and watch URLs.
func (p *PublishCmd) printPosterOnlyResult(g *Globals, streams *IO, v *api.Version) error {
	if g.JSON {
		return writeJSON(streams.Stdout, v)
	}
	if p.Quiet {
		fmt.Fprintln(streams.Stdout, v.VersionURL)
		return nil
	}
	fmt.Fprintf(streams.Stdout, "Poster updated for artifact %s (version %d)\n", p.Update, v.Version)
	if v.VersionPosterURL != nil {
		fmt.Fprintf(streams.Stdout, "  Poster: %s\n", *v.VersionPosterURL)
	}
	fmt.Fprintf(streams.Stdout, "  Watch:  %s\n", v.VersionURL)
	return nil
}

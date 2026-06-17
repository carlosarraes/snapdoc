package cli

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/carlosarraes/snapdoc/cli/internal/api"
)

type PublishCmd struct {
	File     string `arg:"" optional:"" help:"File to publish; '-' or omitted reads stdin."`
	Title    string `help:"Artifact title."`
	TTL      string `help:"Time to live, e.g. 12h, 7d (server-validated)."`
	Update   string `help:"Artifact ID to update with a new version." placeholder:"ID"`
	Markdown bool   `help:"Treat input as Markdown (auto-detected for .md/.markdown files)."`
	Passcode string `help:"Protect a new artifact with a passcode (applies only when creating)."`
	Quiet    bool   `short:"q" help:"Print only the artifact URL."`
}

func (p *PublishCmd) Run(g *Globals, streams *IO) error {
	content, err := p.readInput(streams.Stdin)
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
	opts := api.PublishOptions{Title: p.Title, TTL: p.TTL}
	var artifact *api.Artifact
	if p.Update != "" {
		artifact, err = client.PublishVersion(p.Update, bytes.NewReader(content), contentType, opts)
	} else {
		opts.Passcode = p.Passcode // passcode is set only when creating an artifact
		artifact, err = client.Publish(bytes.NewReader(content), contentType, opts)
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

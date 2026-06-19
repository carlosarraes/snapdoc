package cli

import (
	"bufio"
	"errors"
	"fmt"
	"strings"

	"github.com/carlosarraes/snapdoc/cli/internal/api"
)

type ReadCmd struct {
	ID  string `arg:"" help:"Artifact ID."`
	Raw bool   `help:"Output the original HTML instead of Markdown."`
	// Flag is --rev, not --version: the root VersionFlag already owns --version.
	Version  int    `name:"rev" help:"Read a specific version (default: latest)."`
	Passcode string `help:"Passcode for a protected artifact (or set SNAPDOC_PASSCODE)." env:"SNAPDOC_PASSCODE"`
}

func (c *ReadCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	format := "md"
	if c.Raw {
		format = "html"
	}

	passcode := c.Passcode
	res, err := client.ReadContent(c.ID, format, c.Version, passcode)
	// Protected doc, no passcode given, attached to a terminal: prompt once and
	// retry. Agents (non-TTY) get the error directly so they can pass
	// --passcode / SNAPDOC_PASSCODE without a hanging prompt.
	if isPasscodeRequired(err) && passcode == "" && stdinIsTerminal(streams.Stdin) {
		fmt.Fprint(streams.Stderr, "Passcode: ")
		line, rerr := readLine(bufio.NewReader(streams.Stdin))
		if rerr != nil {
			return rerr
		}
		passcode = line
		res, err = client.ReadContent(c.ID, format, c.Version, passcode)
	}
	if err != nil {
		return err
	}

	if g.JSON {
		return writeJSON(streams.Stdout, res)
	}
	// Print only the content so `snapdoc read <id> > doc.md` yields a clean file.
	content := res.Content
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	fmt.Fprint(streams.Stdout, content)
	return nil
}

func isPasscodeRequired(err error) bool {
	var apiErr *api.Error
	return errors.As(err, &apiErr) && apiErr.Code == "passcode_required"
}

// Package cli wires the snapdoc commands. It is a thin client of the API
// contract: no business rules live here, errors are rendered from the
// server's stable error codes.
package cli

import (
	"errors"
	"fmt"
	"io"

	"github.com/alecthomas/kong"
	"github.com/carraes/snapdoc/cli/internal/api"
	"github.com/carraes/snapdoc/cli/internal/config"
)

// IO carries the injected streams so commands are testable end-to-end.
type IO struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

type Globals struct {
	APIURL string `name:"api-url" help:"API base URL (overrides config and SNAPDOC_API_URL)." env:"SNAPDOC_API_URL"`
	Token  string `help:"API token (overrides config and SNAPDOC_TOKEN)." env:"SNAPDOC_TOKEN"`
}

// client resolves configuration with precedence flag > env > file > default.
// Kong fills Globals from flags or env; config.Load covers env and file.
func (g *Globals) client() (*api.Client, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if g.APIURL != "" {
		cfg.APIURL = g.APIURL
	}
	if g.Token != "" {
		cfg.Token = g.Token
	}
	return &api.Client{BaseURL: cfg.APIURL, Token: cfg.Token}, nil
}

type CLI struct {
	Globals

	Publish PublishCmd `cmd:"" help:"Publish an HTML or Markdown artifact from a file or stdin."`
	List    ListCmd    `cmd:"" help:"List your artifacts."`
	Get     GetCmd     `cmd:"" help:"Show artifact metadata and versions."`
	Delete  DeleteCmd  `cmd:"" help:"Delete an artifact."`
	Expire  ExpireCmd  `cmd:"" help:"Expire an artifact now."`
	Token   TokenCmd   `cmd:"" help:"Manage API tokens (admin)."`
	Login   LoginCmd   `cmd:"" help:"Save API URL and token to the config file."`
}

// Run parses args and executes the selected command, returning the process
// exit code.
func Run(args []string, streams *IO) int {
	cli := &CLI{}
	exited := false
	parser, err := kong.New(cli,
		kong.Name("snapdoc"),
		kong.Description("CLI-first HTML artifact hoster."),
		kong.UsageOnError(),
		kong.Writers(streams.Stdout, streams.Stderr),
		kong.Exit(func(int) { exited = true }),
	)
	if err != nil {
		fmt.Fprintf(streams.Stderr, "snapdoc: %v\n", err)
		return 1
	}
	ctx, err := parser.Parse(args)
	if exited {
		return 0 // --help and friends
	}
	if err != nil {
		fmt.Fprintf(streams.Stderr, "snapdoc: error: %v\n", err)
		return 2
	}
	if err := ctx.Run(&cli.Globals, streams); err != nil {
		renderError(streams.Stderr, err)
		return 1
	}
	return 0
}

func renderError(w io.Writer, err error) {
	var apiErr *api.Error
	if errors.As(err, &apiErr) {
		fmt.Fprintf(w, "snapdoc: error (%s): %s\n", apiErr.Code, apiErr.Message)
		if apiErr.RetryAfter != "" {
			fmt.Fprintf(w, "Retry after %s seconds.\n", apiErr.RetryAfter)
		}
		return
	}
	fmt.Fprintf(w, "snapdoc: error: %v\n", err)
}

package cli

import (
	"fmt"
	"os/exec"
	"runtime"
)

// openURL launches the default browser for a URL. It is a package var so tests
// can override it without spawning a real browser.
var openURL = func(rawURL string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", rawURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	default:
		cmd = exec.Command("xdg-open", rawURL)
	}
	return cmd.Start()
}

type OpenCmd struct {
	ID string `arg:"" help:"Artifact id to open in the browser."`
}

func (o *OpenCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.Get(o.ID)
	if err != nil {
		return err
	}
	fmt.Fprintf(streams.Stdout, "Opening %s\n", res.Artifact.URL)
	return openURL(res.Artifact.URL)
}

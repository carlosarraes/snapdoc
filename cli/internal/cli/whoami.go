package cli

import "fmt"

// WhoamiCmd verifies the configured token by calling GET /v1/whoami and reports
// the token's identity. A clean exit means the token works; an invalid token is
// rendered from the server's "unauthorized" error code by renderError.
type WhoamiCmd struct{}

func (c *WhoamiCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.Whoami()
	if err != nil {
		return err
	}
	if g.JSON {
		return writeJSON(streams.Stdout, res)
	}
	fmt.Fprintf(streams.Stdout, "Token:   %s\n", res.Token.Name)
	fmt.Fprintf(streams.Stdout, "ID:      %s\n", res.Token.ID)
	fmt.Fprintf(streams.Stdout, "Created: %s\n", res.Token.CreatedAt)
	return nil
}

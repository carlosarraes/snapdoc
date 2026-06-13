package cli

import (
	"errors"
	"fmt"
	"os"
	"text/tabwriter"
)

type TokenCmd struct {
	Create TokenCreateCmd `cmd:"" help:"Create an API token (admin)."`
	List   TokenListCmd   `cmd:"" help:"List API tokens (admin)."`
	Revoke TokenRevokeCmd `cmd:"" help:"Revoke an API token (admin)."`
}

type TokenCreateCmd struct {
	Name      string `arg:"" help:"Token name (unique)."`
	Bootstrap bool   `help:"Authenticate with the bootstrap secret from SNAPDOC_BOOTSTRAP."`
}

func (c *TokenCreateCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	if c.Bootstrap {
		secret := os.Getenv("SNAPDOC_BOOTSTRAP")
		if secret == "" {
			return errors.New("--bootstrap requires the SNAPDOC_BOOTSTRAP environment variable")
		}
		client.Token = secret
	}
	tok, err := client.CreateToken(c.Name, c.Bootstrap)
	if err != nil {
		return err
	}
	fmt.Fprintf(streams.Stdout, "Token created: %s (%s)\n", tok.Name, tok.ID)
	fmt.Fprintf(streams.Stdout, "Secret (shown only once, save it now):\n%s\n", tok.Token)
	return nil
}

type TokenListCmd struct{}

func (c *TokenListCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	tokens, err := client.ListTokens()
	if err != nil {
		return err
	}
	w := tabwriter.NewWriter(streams.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tNAME\tCREATED\tLAST USED\tREVOKED")
	for _, tok := range tokens {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			tok.ID, tok.Name, tok.CreatedAt, orDash(tok.LastUsedAt), orDash(tok.RevokedAt))
	}
	return w.Flush()
}

type TokenRevokeCmd struct {
	ID string `arg:"" help:"Token ID to revoke."`
}

func (c *TokenRevokeCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.RevokeToken(c.ID)
	if err != nil {
		return err
	}
	fmt.Fprintf(streams.Stdout, "Revoked %s at %s\n", res.ID, res.RevokedAt)
	return nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

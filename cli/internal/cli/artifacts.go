package cli

import (
	"fmt"
	"text/tabwriter"

	"github.com/carlosarraes/snapdoc/cli/internal/api"
)

type ListCmd struct {
	Status string `help:"Filter by status (active|expired|deleted)."`
	All    bool   `help:"Follow pagination cursors and fetch every page."`
}

func (l *ListCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}

	var artifacts []api.Artifact
	cursor := ""
	nextCursor := ""
	moreAvailable := false
	for {
		res, err := client.List(api.ListOptions{Status: l.Status, Cursor: cursor})
		if err != nil {
			return err
		}
		artifacts = append(artifacts, res.Artifacts...)
		if res.NextCursor == "" {
			break
		}
		if !l.All {
			nextCursor = res.NextCursor
			moreAvailable = true
			break
		}
		cursor = res.NextCursor
	}

	if g.JSON {
		return writeJSON(streams.Stdout, api.ListResult{Artifacts: artifacts, NextCursor: nextCursor})
	}

	w := tabwriter.NewWriter(streams.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tTITLE\tSTATUS\tVERSION\tEXPIRES")
	for _, a := range artifacts {
		fmt.Fprintf(w, "%s\t%s\t%s\t%d\t%s\n", a.ID, a.Title, a.Status, a.CurrentVersion, a.ExpiresAt)
	}
	if err := w.Flush(); err != nil {
		return err
	}
	if moreAvailable {
		fmt.Fprintln(streams.Stderr, "More results available; rerun with --all to fetch every page.")
	}
	return nil
}

type GetCmd struct {
	ID string `arg:"" help:"Artifact ID."`
}

func (c *GetCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.Get(c.ID)
	if err != nil {
		return err
	}
	if g.JSON {
		return writeJSON(streams.Stdout, res)
	}
	a := res.Artifact
	fmt.Fprintf(streams.Stdout, "ID:       %s\n", a.ID)
	fmt.Fprintf(streams.Stdout, "Title:    %s\n", a.Title)
	fmt.Fprintf(streams.Stdout, "Status:   %s\n", a.Status)
	fmt.Fprintf(streams.Stdout, "Version:  %d\n", a.CurrentVersion)
	fmt.Fprintf(streams.Stdout, "Type:     %s\n", a.ContentType)
	fmt.Fprintf(streams.Stdout, "Size:     %d bytes\n", a.SizeBytes)
	fmt.Fprintf(streams.Stdout, "Created:  %s\n", a.CreatedAt)
	fmt.Fprintf(streams.Stdout, "Expires:  %s\n", a.ExpiresAt)
	fmt.Fprintf(streams.Stdout, "URL:      %s\n", a.URL)
	fmt.Fprintln(streams.Stdout)

	w := tabwriter.NewWriter(streams.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "VERSION\tSIZE\tTYPE\tCREATED")
	for _, v := range res.Versions {
		fmt.Fprintf(w, "%d\t%d\t%s\t%s\n", v.Version, v.SizeBytes, v.ContentType, v.CreatedAt)
	}
	return w.Flush()
}

type DeleteCmd struct {
	ID string `arg:"" help:"Artifact ID."`
}

func (c *DeleteCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.Delete(c.ID)
	if err != nil {
		return err
	}
	fmt.Fprintf(streams.Stdout, "Deleted %s (status: %s)\n", res.ID, res.Status)
	return nil
}

type ExpireCmd struct {
	ID string `arg:"" help:"Artifact ID."`
}

func (c *ExpireCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	a, err := client.Expire(c.ID)
	if err != nil {
		return err
	}
	fmt.Fprintf(streams.Stdout, "Expired %s (status: %s)\n", a.ID, a.Status)
	return nil
}

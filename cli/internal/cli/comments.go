package cli

import "fmt"

type CommentsCmd struct {
	ID string `arg:"" help:"Artifact id."`
}

func (c *CommentsCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.ListComments(c.ID)
	if err != nil {
		return err
	}
	if g.JSON {
		return writeJSON(streams.Stdout, res)
	}
	if len(res.Comments) == 0 {
		fmt.Fprintln(streams.Stdout, "No comments yet.")
		return nil
	}
	for _, cm := range res.Comments {
		fmt.Fprintf(streams.Stdout, "%s · v%d · %s\n%s\n\n", cm.Author, cm.Version, cm.CreatedAt, cm.Body)
	}
	if res.Truncated {
		fmt.Fprintln(streams.Stderr, "Comment list truncated; showing the most recent page.")
	}
	return nil
}

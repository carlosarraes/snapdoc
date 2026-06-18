package cli

import "fmt"

type CommentsCmd struct {
	ID     string `arg:"" help:"Artifact id."`
	Status string `short:"s" help:"Filter threads by status: open or resolved (default shows all)."`
}

func (c *CommentsCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.ListComments(c.ID, c.Status)
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
	// The server returns thread-contiguous order (each root then its replies),
	// so a flat pass renders threads correctly: roots at the margin, replies indented.
	for _, cm := range res.Comments {
		if cm.ParentID == nil {
			marker := ""
			if cm.Resolved {
				marker = " [resolved"
				if cm.ResolvedBy != nil {
					marker += " by " + *cm.ResolvedBy
				}
				marker += "]"
			}
			fmt.Fprintf(streams.Stdout, "%s · v%d · %s%s\n%s\n\n", cm.Author, cm.Version, cm.CreatedAt, marker, cm.Body)
		} else {
			fmt.Fprintf(streams.Stdout, "  ↳ %s · v%d · %s\n  %s\n\n", cm.Author, cm.Version, cm.CreatedAt, cm.Body)
		}
	}
	if res.Truncated {
		fmt.Fprintln(streams.Stderr, "Comment list truncated; showing the most recent page.")
	}
	return nil
}

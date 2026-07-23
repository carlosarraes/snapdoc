package cli

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/carlosarraes/snapdoc/cli/internal/api"
)

// CommentsCmd groups the comment subcommands. The default (no subcommand) reads
// comments, so `snapdoc comments <id>` keeps working; enable/disable toggle the
// anonymous reader-comment opt-in.
type CommentsCmd struct {
	Read    CommentsReadCmd    `cmd:"" default:"withargs" help:"Show comments on an artifact (default)."`
	Enable  CommentsEnableCmd  `cmd:"" help:"Allow anyone with the link to comment via the review page."`
	Disable CommentsDisableCmd `cmd:"" help:"Stop allowing reader comments."`
}

type CommentsReadCmd struct {
	ID              string `arg:"" help:"Artifact id."`
	Status          string `short:"s" help:"Filter threads by status: open or resolved (default shows all)."`
	IncludeOrphaned bool   `short:"o" help:"Include threads whose quoted text no longer appears in the current version."`
}

func (c *CommentsReadCmd) Run(g *Globals, streams *IO) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	res, err := client.ListComments(c.ID, c.Status)
	if err != nil {
		return err
	}
	if !c.IncludeOrphaned {
		res.Comments = dropOrphanedThreads(res.Comments)
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
			if cm.Orphaned != nil && *cm.Orphaned {
				marker += " [orphaned]"
			}
			fmt.Fprintf(streams.Stdout, "%s%s · v%d · %s%s\n", cm.Author, provenance(cm), cm.Version, cm.CreatedAt, marker)
			if cm.Anchor != nil {
				fmt.Fprintf(streams.Stdout, "  “%s”\n", quoteOneLine(cm.Anchor.Exact))
			}
			fmt.Fprintf(streams.Stdout, "%s\n\n", cm.Body)
		} else {
			fmt.Fprintf(streams.Stdout, "  ↳ %s%s · v%d · %s\n  %s\n\n", cm.Author, provenance(cm), cm.Version, cm.CreatedAt, cm.Body)
		}
	}
	if res.Truncated {
		fmt.Fprintln(streams.Stderr, "Comment list truncated; showing the most recent page.")
	}
	return nil
}

// provenance marks reader (anonymous) comments so an agent can weigh verified
// team feedback differently from anyone-with-the-link input.
func provenance(cm api.Comment) string {
	if cm.AuthorKind == "anon" {
		return " (reader)"
	}
	return ""
}

func quoteOneLine(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len([]rune(s)) > 120 {
		return string([]rune(s)[:117]) + "..."
	}
	return s
}

type CommentsEnableCmd struct {
	ID string `arg:"" help:"Artifact id."`
}

func (c *CommentsEnableCmd) Run(g *Globals, streams *IO) error {
	return setComments(g, streams, c.ID, true)
}

type CommentsDisableCmd struct {
	ID string `arg:"" help:"Artifact id."`
}

func (c *CommentsDisableCmd) Run(g *Globals, streams *IO) error {
	return setComments(g, streams, c.ID, false)
}

// dropOrphanedThreads removes threads whose anchor no longer matches the
// current version (root and replies). Stale feedback is noise for agents
// iterating on the latest version; --include-orphaned brings it back.
func dropOrphanedThreads(comments []api.Comment) []api.Comment {
	orphanedRoots := make(map[string]bool)
	for _, cm := range comments {
		if cm.ParentID == nil && cm.Orphaned != nil && *cm.Orphaned {
			orphanedRoots[cm.ID] = true
		}
	}
	if len(orphanedRoots) == 0 {
		return comments
	}
	kept := comments[:0]
	for _, cm := range comments {
		if orphanedRoots[cm.ID] || (cm.ParentID != nil && orphanedRoots[*cm.ParentID]) {
			continue
		}
		kept = append(kept, cm)
	}
	return kept
}

func setComments(g *Globals, streams *IO, id string, enabled bool) error {
	client, err := g.client()
	if err != nil {
		return err
	}
	a, err := client.SetCommentsEnabled(id, enabled)
	if err != nil {
		return err
	}
	if g.JSON {
		return writeJSON(streams.Stdout, a)
	}
	if enabled {
		fmt.Fprintf(streams.Stdout, "Reader comments enabled for %s.\n  Review: %s\n", a.ID, reviewURL(a.URL, client.BaseURL, a.ID))
	} else {
		fmt.Fprintf(streams.Stdout, "Reader comments disabled for %s.\n", a.ID)
	}
	return nil
}

// reviewURL is the public review page for an artifact. It lives on the same
// origin as the artifact itself, so derive it from the artifact URL and fall
// back to the API host only when the response carries no usable URL.
func reviewURL(artifactURL, baseURL, id string) string {
	if u, err := url.Parse(artifactURL); err == nil && u.Scheme != "" && u.Host != "" {
		return u.Scheme + "://" + u.Host + "/review/" + url.PathEscape(id)
	}
	return strings.TrimRight(baseURL, "/") + "/review/" + url.PathEscape(id)
}

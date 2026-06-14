package cli

import (
	"bufio"
	"errors"
	"fmt"
	"strings"

	"github.com/carlosarraes/snapdoc/cli/internal/config"
)

type LoginCmd struct{}

// Run saves api_url/token to the config file, prompting for any value not
// supplied via the global --api-url/--token flags (or their env vars).
func (l *LoginCmd) Run(g *Globals, streams *IO) error {
	reader := bufio.NewReader(streams.Stdin)
	apiURL := g.APIURL
	if apiURL == "" {
		fmt.Fprintf(streams.Stdout, "API URL [%s]: ", config.DefaultAPIURL)
		line, err := readLine(reader)
		if err != nil {
			return err
		}
		apiURL = line
		if apiURL == "" {
			apiURL = config.DefaultAPIURL
		}
	}
	token := g.Token
	if token == "" {
		fmt.Fprint(streams.Stdout, "Token: ")
		line, err := readLine(reader)
		if err != nil {
			return err
		}
		token = line
	}
	if token == "" {
		return errors.New("a token is required")
	}
	if err := config.Save(config.Config{APIURL: apiURL, Token: token}); err != nil {
		return err
	}
	path, err := config.Path()
	if err != nil {
		return err
	}
	fmt.Fprintf(streams.Stdout, "Config written to %s\n", path)
	return nil
}

// readLine tolerates EOF on the final unterminated line.
func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil && line == "" && !strings.Contains(err.Error(), "EOF") {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

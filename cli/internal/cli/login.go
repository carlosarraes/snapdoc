package cli

import (
	"bufio"
	"errors"
	"fmt"
	"strings"

	"github.com/carlosarraes/snapdoc/cli/internal/config"
)

type LoginCmd struct {
	Passcode string `help:"Default passcode for protected artifacts, reused by publish/read/comments reply."`
}

// Run saves api_url/token to the config file, prompting for any value not
// supplied via the global --api-url/--token flags (or their env vars). Other
// saved settings (the default passcode) are preserved unless overridden.
func (l *LoginCmd) Run(g *Globals, streams *IO) error {
	// Read the file directly: config.Load would fold in environment values,
	// which must not be written into the config file as a side effect.
	saved, err := config.LoadFile()
	if err != nil {
		return err
	}
	reader := bufio.NewReader(streams.Stdin)
	// Empty input keeps whatever is already saved, so re-running login to
	// change one setting never demands the token be pasted again.
	apiURL := g.APIURL
	if apiURL == "" {
		fallback := saved.APIURL
		if fallback == "" {
			fallback = config.DefaultAPIURL
		}
		fmt.Fprintf(streams.Stdout, "API URL [%s]: ", fallback)
		line, err := readLine(reader)
		if err != nil {
			return err
		}
		apiURL = line
		if apiURL == "" {
			apiURL = fallback
		}
	}
	token := g.Token
	if token == "" {
		if saved.Token != "" {
			fmt.Fprint(streams.Stdout, "Token [keep saved]: ")
		} else {
			fmt.Fprint(streams.Stdout, "Token: ")
		}
		line, err := readLine(reader)
		if err != nil {
			return err
		}
		token = line
		if token == "" {
			token = saved.Token
		}
	}
	if token == "" {
		return errors.New("a token is required")
	}
	passcode := saved.Passcode
	if l.Passcode != "" {
		passcode = l.Passcode
	}
	if err := config.Save(config.Config{APIURL: apiURL, Token: token, Passcode: passcode}); err != nil {
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

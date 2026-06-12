// Package config loads and saves the snapdoc CLI configuration.
// Precedence: environment variables override the config file; the
// default API URL applies when nothing else is set.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

const DefaultAPIURL = "https://api.snapdoc.carraes.dev"

type Config struct {
	APIURL string `json:"api_url"`
	Token  string `json:"token"`
}

// Path returns the config file location (~/.config/snapdoc/config.json,
// honoring XDG_CONFIG_HOME).
func Path() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "snapdoc", "config.json"), nil
}

// Load reads the config file (if present) and applies SNAPDOC_API_URL and
// SNAPDOC_TOKEN environment overrides, falling back to DefaultAPIURL.
func Load() (Config, error) {
	var cfg Config
	p, err := Path()
	if err != nil {
		return cfg, err
	}
	data, err := os.ReadFile(p)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		// no file: start from zero config
	case err != nil:
		return cfg, err
	default:
		if err := json.Unmarshal(data, &cfg); err != nil {
			return cfg, fmt.Errorf("parse %s: %w", p, err)
		}
		warnLoosePermissions(p)
	}
	if v := os.Getenv("SNAPDOC_API_URL"); v != "" {
		cfg.APIURL = v
	}
	if v := os.Getenv("SNAPDOC_TOKEN"); v != "" {
		cfg.Token = v
	}
	if cfg.APIURL == "" {
		cfg.APIURL = DefaultAPIURL
	}
	return cfg, nil
}

// warnLoosePermissions prints a stderr warning when the config file is
// readable by group/other; the token is a credential.
func warnLoosePermissions(p string) {
	info, err := os.Stat(p)
	if err != nil {
		return
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		fmt.Fprintf(os.Stderr, "snapdoc: warning: %s has permissions %04o; tighten with: chmod 600 %s\n", p, perm, p)
	}
}

// Save writes the config file atomically (temp file + rename) with 0600
// permissions, tightening a pre-existing directory to 0700.
func Save(cfg Config) error {
	p, err := Path()
	if err != nil {
		return err
	}
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// MkdirAll is a no-op on an existing directory; enforce the mode anyway.
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "config-*.json.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name()) // no-op after successful rename
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), p)
}

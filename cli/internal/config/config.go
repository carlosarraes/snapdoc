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

// Save writes the config file with 0600 permissions, creating the directory
// as needed.
func Save(cfg Config) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, append(data, '\n'), 0o600)
}

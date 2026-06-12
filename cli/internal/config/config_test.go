package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad(t *testing.T) {
	writeFile := func(t *testing.T, dir, content string) {
		t.Helper()
		p := filepath.Join(dir, "snapdoc")
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "config.json"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	tests := []struct {
		name       string
		file       string
		envAPIURL  string
		envToken   string
		wantAPIURL string
		wantToken  string
	}{
		{
			name:       "no file no env uses default api url",
			wantAPIURL: DefaultAPIURL,
			wantToken:  "",
		},
		{
			name:       "file values",
			file:       `{"api_url":"https://file.example","token":"tok-file"}`,
			wantAPIURL: "https://file.example",
			wantToken:  "tok-file",
		},
		{
			name:       "env overrides file",
			file:       `{"api_url":"https://file.example","token":"tok-file"}`,
			envAPIURL:  "https://env.example",
			envToken:   "tok-env",
			wantAPIURL: "https://env.example",
			wantToken:  "tok-env",
		},
		{
			name:       "env token only keeps file api url",
			file:       `{"api_url":"https://file.example","token":"tok-file"}`,
			envToken:   "tok-env",
			wantAPIURL: "https://file.example",
			wantToken:  "tok-env",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("XDG_CONFIG_HOME", dir)
			t.Setenv("SNAPDOC_API_URL", tt.envAPIURL)
			t.Setenv("SNAPDOC_TOKEN", tt.envToken)
			if tt.file != "" {
				writeFile(t, dir, tt.file)
			}
			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.APIURL != tt.wantAPIURL {
				t.Errorf("APIURL = %q, want %q", cfg.APIURL, tt.wantAPIURL)
			}
			if cfg.Token != tt.wantToken {
				t.Errorf("Token = %q, want %q", cfg.Token, tt.wantToken)
			}
		})
	}
}

func TestLoadInvalidJSON(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("SNAPDOC_API_URL", "")
	t.Setenv("SNAPDOC_TOKEN", "")
	p := filepath.Join(dir, "snapdoc")
	if err := os.MkdirAll(p, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, "config.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil {
		t.Fatal("Load() with invalid JSON: want error, got nil")
	}
}

func TestSaveRoundTripAndPermissions(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("SNAPDOC_API_URL", "")
	t.Setenv("SNAPDOC_TOKEN", "")

	want := Config{APIURL: "https://saved.example", Token: "tok-saved"}
	if err := Save(want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	p, err := Path()
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("config file perm = %o, want 600", perm)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if got != want {
		t.Errorf("round trip = %+v, want %+v", got, want)
	}
}

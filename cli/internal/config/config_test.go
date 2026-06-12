package config

import (
	"io"
	"os"
	"path/filepath"
	"strings"
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

func TestSaveTightensExistingLoosePermissions(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("SNAPDOC_API_URL", "")
	t.Setenv("SNAPDOC_TOKEN", "")

	// Pre-create dir and file with loose modes; Save must tighten both.
	cfgDir := filepath.Join(dir, "snapdoc")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(cfgDir, "config.json")
	if err := os.WriteFile(p, []byte(`{"api_url":"old","token":"old"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	want := Config{APIURL: "https://new.example", Token: "tok-new"}
	if err := Save(want); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	dirInfo, err := os.Stat(cfgDir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Errorf("dir perm = %o, want 700", perm)
	}
	fileInfo, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fileInfo.Mode().Perm(); perm != 0o600 {
		t.Errorf("file perm = %o, want 600", perm)
	}
	got, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("Load() = %+v, want %+v", got, want)
	}
}

func TestSaveLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)

	if err := Save(Config{APIURL: "https://a.example", Token: "t"}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "snapdoc"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "config.json" {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("config dir entries = %v, want only config.json", names)
	}
}

func TestLoadWarnsOnLoosePermissions(t *testing.T) {
	captureStderr := func(t *testing.T, fn func()) string {
		t.Helper()
		old := os.Stderr
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		os.Stderr = w
		defer func() { os.Stderr = old }()
		fn()
		w.Close()
		out, err := io.ReadAll(r)
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}

	setup := func(t *testing.T, perm os.FileMode) {
		t.Helper()
		dir := t.TempDir()
		t.Setenv("XDG_CONFIG_HOME", dir)
		t.Setenv("SNAPDOC_API_URL", "")
		t.Setenv("SNAPDOC_TOKEN", "")
		cfgDir := filepath.Join(dir, "snapdoc")
		if err := os.MkdirAll(cfgDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cfgDir, "config.json"), []byte(`{"api_url":"https://a.example","token":"t"}`), perm); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("loose file warns", func(t *testing.T) {
		setup(t, 0o644)
		var cfg Config
		var err error
		stderr := captureStderr(t, func() { cfg, err = Load() })
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.Token != "t" {
			t.Errorf("Load() should still succeed, got %+v", cfg)
		}
		if !strings.Contains(stderr, "warning") || !strings.Contains(stderr, "config.json") {
			t.Errorf("stderr = %q, want permission warning mentioning config.json", stderr)
		}
	})

	t.Run("tight file does not warn", func(t *testing.T) {
		setup(t, 0o600)
		stderr := captureStderr(t, func() { Load() })
		if stderr != "" {
			t.Errorf("stderr = %q, want empty", stderr)
		}
	})
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

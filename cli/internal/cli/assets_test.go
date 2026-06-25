package cli

import (
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestExtractImageRefs(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		markdown bool
		want     []string
	}{
		{"html double quotes", `<img src="a.png">`, false, []string{"a.png"}},
		{"html single quotes", `<img src='a.png'>`, false, []string{"a.png"}},
		{"html unquoted", `<img src=a.png>`, false, []string{"a.png"}},
		{"html other attrs first", `<img class="x" src="a.png" alt="y">`, false, []string{"a.png"}},
		{"subdirectory", `<img src="shots/a.png">`, false, []string{"shots/a.png"}},
		{"skips remote and data and root", `<img src="https://x/y.png"><img src="data:image/png;base64,A"><img src="/abs.png">`, false, nil},
		{"markdown image", `![alt](pic.png)`, true, []string{"pic.png"}},
		{"markdown not parsed when html", `![alt](pic.png)`, false, nil},
		{"markdown remote skipped", `![a](https://x/y.png)`, true, nil},
		{"markdown percent-encoded kept verbatim", `![a](my%20img.png)`, true, []string{"my%20img.png"}},
		{"dedup", `<img src="a.png"><img src="a.png">`, false, []string{"a.png"}},
		{"markdown plus raw html", "![a](one.png)\n<img src=\"two.png\">", true, []string{"two.png", "one.png"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractImageRefs(tt.content, tt.markdown)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("extractImageRefs() = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestResolveAssets(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "a.png"))
	mustWrite(t, filepath.Join(dir, "shots", "b.png"))
	mustWrite(t, filepath.Join(dir, "my img.png"))

	refs := []string{"a.png", "shots/b.png", "my%20img.png", "missing.png", "../escape.png"}
	got := resolveAssets(refs, dir, io.Discard, true)

	want := []struct{ ref, base string }{
		{"a.png", "a.png"},
		{"shots/b.png", filepath.Join("shots", "b.png")},
		{"my%20img.png", "my img.png"},
	}
	if len(got) != len(want) {
		t.Fatalf("resolveAssets() returned %d assets, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Ref != w.ref {
			t.Errorf("asset[%d].Ref = %q, want %q", i, got[i].Ref, w.ref)
		}
		if got[i].Path != filepath.Join(dir, w.base) {
			t.Errorf("asset[%d].Path = %q, want %q", i, got[i].Path, filepath.Join(dir, w.base))
		}
	}
}

func mustWrite(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte{0x89, 0x50, 0x4e, 0x47}, 0o644); err != nil {
		t.Fatal(err)
	}
}

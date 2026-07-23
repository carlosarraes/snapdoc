package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const artifactJSON = `{
	"id": "x7Kp9qWm2AbCdE",
	"url": "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE",
	"title": "Q3 plan review",
	"status": "active",
	"current_version": 1,
	"content_type": "text/html",
	"size_bytes": 48213,
	"created_at": "2026-06-12T15:04:05Z",
	"expires_at": "2026-06-26T15:04:05Z"
}`

type recordedReq struct {
	method        string
	path          string
	query         map[string]string
	auth          string
	ctype         string
	passcode      string
	body          string
	contentLength int64
}

type fakeServer struct {
	*httptest.Server
	reqs []recordedReq
}

// newFakeServer records every request and replies via handler.
func newFakeServer(t *testing.T, handler func(r recordedReq, w http.ResponseWriter)) *fakeServer {
	t.Helper()
	fs := &fakeServer{}
	fs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		q := map[string]string{}
		for k, v := range r.URL.Query() {
			q[k] = v[0]
		}
		req := recordedReq{
			method:        r.Method,
			path:          r.URL.Path,
			query:         q,
			auth:          r.Header.Get("Authorization"),
			ctype:         r.Header.Get("Content-Type"),
			passcode:      r.Header.Get("X-Snapdoc-Passcode"),
			body:          string(b),
			contentLength: r.ContentLength,
		}
		fs.reqs = append(fs.reqs, req)
		w.Header().Set("Content-Type", "application/json")
		handler(req, w)
	}))
	t.Cleanup(fs.Close)
	return fs
}

func okServer(t *testing.T, status int, body string) *fakeServer {
	return newFakeServer(t, func(_ recordedReq, w http.ResponseWriter) {
		w.WriteHeader(status)
		io.WriteString(w, body)
	})
}

func errServer(t *testing.T, status int, code, message string, header map[string]string) *fakeServer {
	return newFakeServer(t, func(_ recordedReq, w http.ResponseWriter) {
		for k, v := range header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(status)
		io.WriteString(w, `{"error":{"code":"`+code+`","message":"`+message+`"}}`)
	})
}

// respSpec is a canned status/body pair for routedServer.
type respSpec struct {
	status int
	body   string
}

// routedServer replies per "METHOD /path" so a test can script a multi-step
// exchange (e.g. video create, then a separate poster upload).
func routedServer(t *testing.T, routes map[string]respSpec) *fakeServer {
	return newFakeServer(t, func(r recordedReq, w http.ResponseWriter) {
		spec, ok := routes[r.method+" "+r.path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, `{"error":{"code":"not_found","message":"no route for `+r.method+" "+r.path+`"}}`)
			return
		}
		w.WriteHeader(spec.status)
		io.WriteString(w, spec.body)
	})
}

// setupEnv isolates config dir and clears snapdoc env vars; returns config dir.
func setupEnv(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("SNAPDOC_API_URL", "")
	t.Setenv("SNAPDOC_TOKEN", "")
	t.Setenv("SNAPDOC_BOOTSTRAP", "")
	t.Setenv("SNAPDOC_PASSCODE", "")
	return dir
}

func writeConfig(t *testing.T, dir, apiURL, token string) {
	t.Helper()
	p := filepath.Join(dir, "snapdoc")
	if err := os.MkdirAll(p, 0o700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]string{"api_url": apiURL, "token": token})
	if err := os.WriteFile(filepath.Join(p, "config.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func runCLI(args []string, stdin string) (stdout, stderr string, code int) {
	var out, errOut bytes.Buffer
	code = Run(args, &IO{Stdin: strings.NewReader(stdin), Stdout: &out, Stderr: &errOut})
	return out.String(), errOut.String(), code
}

func writeTempFile(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func writeTempBinaryFile(t *testing.T, name string, content []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, content, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// createFileOfSize makes a sparse file of exactly size bytes without writing
// its content, for cheaply exercising a size-limit rejection.
func createFileOfSize(t *testing.T, name string, size int64) (string, error) {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	f, err := os.Create(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err := f.Truncate(size); err != nil {
		return "", err
	}
	return p, nil
}

// Fixtures live in the worker's test suite (not duplicated here); this is a
// real, tiny H.264+AAC MP4 usable for the CLI's video publish path.
const fixtureVideoH264AAC = "../../../worker/test/fixtures/video-h264-aac.mp4"

// Minimal magic-byte-only images: enough for the CLI's local poster sniff,
// which only inspects the leading signature bytes.
var (
	jpegMagicBytes = []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F'}
	pngMagicBytes  = []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00}
)

const videoArtifactJSON = `{
	"id": "vAbc123XyZ",
	"url": "https://snapdoc.carraes.dev/vAbc123XyZ",
	"file_url": "https://snapdoc.carraes.dev/vAbc123XyZ/media/video-h264-aac.mp4",
	"version_url": "https://snapdoc.carraes.dev/vAbc123XyZ/v/1",
	"version_file_url": "https://snapdoc.carraes.dev/vAbc123XyZ/v/1/media/video-h264-aac.mp4",
	"title": "",
	"status": "active",
	"current_version": 1,
	"content_type": "video/mp4",
	"size_bytes": 3600,
	"created_at": "2026-06-12T15:04:05Z",
	"expires_at": "2026-06-15T15:04:05Z",
	"kind": "video",
	"duration_ms": 1234,
	"width": 640,
	"height": 360,
	"video_codec": "h264",
	"audio_codec": "aac"
}`

const videoVersionJSON = `{
	"version": 1,
	"size_bytes": 3600,
	"content_type": "video/mp4",
	"created_at": "2026-06-12T15:04:05Z",
	"kind": "video",
	"version_url": "https://snapdoc.carraes.dev/vAbc123XyZ/v/1",
	"version_file_url": "https://snapdoc.carraes.dev/vAbc123XyZ/v/1/media/video-h264-aac.mp4",
	"version_poster_url": "https://snapdoc.carraes.dev/vAbc123XyZ/v/1/poster.jpg",
	"duration_ms": 1234,
	"width": 640,
	"height": 360,
	"video_codec": "h264",
	"audio_codec": "aac"
}`

// --- publish ---

func TestPublishInputsAndContentTypes(t *testing.T) {
	tests := []struct {
		name      string
		fileName  string // empty means stdin
		dashArg   bool
		flags     []string
		stdin     string
		content   string
		wantCType string
	}{
		{name: "html file", fileName: "report.html", content: "<h1>r</h1>", wantCType: "text/html"},
		{name: "md extension auto-detect", fileName: "plan.md", content: "# plan", wantCType: "text/markdown"},
		{name: "markdown extension auto-detect", fileName: "plan.markdown", content: "# plan", wantCType: "text/markdown"},
		{name: "markdown flag on html file", fileName: "weird.txt", flags: []string{"--markdown"}, content: "# md", wantCType: "text/markdown"},
		{name: "stdin via dash", dashArg: true, stdin: "<p>pipe</p>", content: "<p>pipe</p>", wantCType: "text/html"},
		{name: "stdin absent arg", stdin: "<p>pipe2</p>", content: "<p>pipe2</p>", wantCType: "text/html"},
		{name: "stdin markdown flag", stdin: "# md pipe", flags: []string{"--markdown"}, content: "# md pipe", wantCType: "text/markdown"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := setupEnv(t)
			srv := okServer(t, 201, artifactJSON)
			writeConfig(t, dir, srv.URL, "tok-1")

			args := []string{"publish"}
			if tt.fileName != "" {
				args = append(args, writeTempFile(t, tt.fileName, tt.content))
			} else if tt.dashArg {
				args = append(args, "-")
			}
			args = append(args, tt.flags...)

			_, stderr, code := runCLI(args, tt.stdin)
			if code != 0 {
				t.Fatalf("exit = %d, stderr = %q", code, stderr)
			}
			req := srv.reqs[0]
			if req.method != "POST" || req.path != "/v1/artifacts" {
				t.Errorf("request = %s %s, want POST /v1/artifacts", req.method, req.path)
			}
			if req.ctype != tt.wantCType {
				t.Errorf("Content-Type = %q, want %q", req.ctype, tt.wantCType)
			}
			if req.body != tt.content {
				t.Errorf("body = %q, want %q", req.body, tt.content)
			}
			if req.auth != "Bearer tok-1" {
				t.Errorf("auth = %q", req.auth)
			}
		})
	}
}

func TestPublishTitleAndTTLPassedVerbatim(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	writeConfig(t, dir, srv.URL, "tok-1")

	f := writeTempFile(t, "a.html", "<p>x</p>")
	_, stderr, code := runCLI([]string{"publish", f, "--title", "Q3 plan review", "--ttl", "7d"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	req := srv.reqs[0]
	if req.query["title"] != "Q3 plan review" {
		t.Errorf("title = %q", req.query["title"])
	}
	if req.query["ttl"] != "7d" {
		t.Errorf("ttl = %q, want 7d", req.query["ttl"])
	}
}

func TestPublishUpdatePostsToVersions(t *testing.T) {
	dir := setupEnv(t)
	updated := strings.Replace(artifactJSON, `"current_version": 1`, `"current_version": 2`, 1)
	srv := okServer(t, 201, updated)
	writeConfig(t, dir, srv.URL, "tok-1")

	f := writeTempFile(t, "a.html", "<p>v2</p>")
	stdout, stderr, code := runCLI([]string{"publish", f, "--update", "x7Kp9qWm2AbCdE", "--ttl", "12h"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	req := srv.reqs[0]
	if req.method != "POST" || req.path != "/v1/artifacts/x7Kp9qWm2AbCdE/versions" {
		t.Errorf("request = %s %s, want POST /v1/artifacts/x7Kp9qWm2AbCdE/versions", req.method, req.path)
	}
	if req.query["ttl"] != "12h" {
		t.Errorf("ttl = %q", req.query["ttl"])
	}
	if !strings.Contains(stdout, "2") {
		t.Errorf("stdout %q should mention version 2", stdout)
	}
}

func TestPublishQuietPrintsOnlyURL(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	writeConfig(t, dir, srv.URL, "tok-1")

	for _, flag := range []string{"--quiet", "-q"} {
		f := writeTempFile(t, "a.html", "<p>x</p>")
		stdout, stderr, code := runCLI([]string{"publish", f, flag}, "")
		if code != 0 {
			t.Fatalf("exit = %d, stderr = %q", code, stderr)
		}
		if stdout != "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE\n" {
			t.Errorf("%s stdout = %q, want exactly URL+newline", flag, stdout)
		}
		if stderr != "" {
			t.Errorf("%s stderr = %q, want empty", flag, stderr)
		}
	}
}

func TestPublishHumanOutput(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	writeConfig(t, dir, srv.URL, "tok-1")

	f := writeTempFile(t, "a.html", "<p>x</p>")
	stdout, _, code := runCLI([]string{"publish", f}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	for _, want := range []string{
		"Q3 plan review",
		"x7Kp9qWm2AbCdE",
		"1",
		"2026-06-26T15:04:05Z",
		"https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout %q missing %q", stdout, want)
		}
	}
}

func TestPublishMissingFile(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"publish", "/nonexistent/nope.html"}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "nope.html") {
		t.Errorf("stderr = %q", stderr)
	}
	if len(srv.reqs) != 0 {
		t.Errorf("no request should be sent, got %d", len(srv.reqs))
	}
}

func TestErrorCodeRendering(t *testing.T) {
	tests := []struct {
		code    string
		status  int
		message string
		header  map[string]string
		extra   []string
	}{
		{code: "invalid_request", status: 400, message: "Malformed body."},
		{code: "invalid_ttl", status: 400, message: "TTL outside 1h-90d bounds."},
		{code: "unsupported_content_type", status: 400, message: "Unsupported content type."},
		{code: "unauthorized", status: 401, message: "Missing or invalid token."},
		{code: "passcode_required", status: 401, message: "Passcode required."},
		{code: "passcode_incorrect", status: 401, message: "Passcode is incorrect."},
		{code: "not_found", status: 404, message: "Unknown artifact."},
		{code: "gone", status: 410, message: "Artifact is no longer available."},
		{code: "not_active", status: 409, message: "Artifact is deleted."},
		{code: "too_large", status: 413, message: "Artifact exceeds the 2 MB size limit."},
		{code: "rate_limited", status: 429, message: "Over 100 publishes/hr.", header: map[string]string{"Retry-After": "120"}, extra: []string{"120"}},
		{code: "internal", status: 500, message: "Unexpected server error."},
	}
	for _, tt := range tests {
		t.Run(tt.code, func(t *testing.T) {
			dir := setupEnv(t)
			srv := errServer(t, tt.status, tt.code, tt.message, tt.header)
			writeConfig(t, dir, srv.URL, "tok-1")

			f := writeTempFile(t, "a.html", "<p>x</p>")
			stdout, stderr, code := runCLI([]string{"publish", f, "--quiet"}, "")
			if code == 0 {
				t.Fatal("want non-zero exit")
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want empty even in quiet mode", stdout)
			}
			for _, want := range append([]string{tt.code, tt.message}, tt.extra...) {
				if !strings.Contains(stderr, want) {
					t.Errorf("stderr %q missing %q", stderr, want)
				}
			}
		})
	}
}

// --- config precedence ---

func TestConfigPrecedence(t *testing.T) {
	t.Run("file only", func(t *testing.T) {
		dir := setupEnv(t)
		srv := okServer(t, 201, artifactJSON)
		writeConfig(t, dir, srv.URL, "tok-file")
		f := writeTempFile(t, "a.html", "x")
		if _, stderr, code := runCLI([]string{"publish", f, "-q"}, ""); code != 0 {
			t.Fatalf("exit = %d, stderr = %q", code, stderr)
		}
		if srv.reqs[0].auth != "Bearer tok-file" {
			t.Errorf("auth = %q, want Bearer tok-file", srv.reqs[0].auth)
		}
	})
	t.Run("env overrides file", func(t *testing.T) {
		dir := setupEnv(t)
		srv := okServer(t, 201, artifactJSON)
		writeConfig(t, dir, "http://127.0.0.1:1/unreachable", "tok-file")
		t.Setenv("SNAPDOC_API_URL", srv.URL)
		t.Setenv("SNAPDOC_TOKEN", "tok-env")
		f := writeTempFile(t, "a.html", "x")
		if _, stderr, code := runCLI([]string{"publish", f, "-q"}, ""); code != 0 {
			t.Fatalf("exit = %d, stderr = %q", code, stderr)
		}
		if srv.reqs[0].auth != "Bearer tok-env" {
			t.Errorf("auth = %q, want Bearer tok-env", srv.reqs[0].auth)
		}
	})
	t.Run("flag overrides env and file", func(t *testing.T) {
		dir := setupEnv(t)
		srv := okServer(t, 201, artifactJSON)
		writeConfig(t, dir, "http://127.0.0.1:1/unreachable", "tok-file")
		t.Setenv("SNAPDOC_API_URL", "http://127.0.0.1:1/unreachable-env")
		t.Setenv("SNAPDOC_TOKEN", "tok-env")
		f := writeTempFile(t, "a.html", "x")
		if _, stderr, code := runCLI([]string{"publish", f, "-q", "--api-url", srv.URL, "--token", "tok-flag"}, ""); code != 0 {
			t.Fatalf("exit = %d, stderr = %q", code, stderr)
		}
		if srv.reqs[0].auth != "Bearer tok-flag" {
			t.Errorf("auth = %q, want Bearer tok-flag", srv.reqs[0].auth)
		}
	})
}

// --- list ---

func TestListTable(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"artifacts":[`+artifactJSON+`],"next_cursor":null}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"list"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	req := srv.reqs[0]
	if req.method != "GET" || req.path != "/v1/artifacts" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	for _, want := range []string{"x7Kp9qWm2AbCdE", "Q3 plan review", "active", "2026-06-26T15:04:05Z"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout %q missing %q", stdout, want)
		}
	}
}

func TestListStatusFilter(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"artifacts":[],"next_cursor":null}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	if _, stderr, code := runCLI([]string{"list", "--status", "expired"}, ""); code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if srv.reqs[0].query["status"] != "expired" {
		t.Errorf("status = %q, want expired", srv.reqs[0].query["status"])
	}
}

func TestListPagination(t *testing.T) {
	page2 := strings.Replace(artifactJSON, "x7Kp9qWm2AbCdE", "SecondPageArti", -1)
	handler := func(r recordedReq, w http.ResponseWriter) {
		w.WriteHeader(200)
		if r.query["cursor"] == "c1" {
			io.WriteString(w, `{"artifacts":[`+page2+`],"next_cursor":null}`)
		} else {
			io.WriteString(w, `{"artifacts":[`+artifactJSON+`],"next_cursor":"c1"}`)
		}
	}

	t.Run("without --all notes more results", func(t *testing.T) {
		dir := setupEnv(t)
		srv := newFakeServer(t, handler)
		writeConfig(t, dir, srv.URL, "tok-1")
		stdout, stderr, code := runCLI([]string{"list"}, "")
		if code != 0 {
			t.Fatalf("exit = %d, stderr = %q", code, stderr)
		}
		if len(srv.reqs) != 1 {
			t.Errorf("requests = %d, want 1", len(srv.reqs))
		}
		if strings.Contains(stdout, "SecondPageArti") {
			t.Error("second page should not be fetched without --all")
		}
		if !strings.Contains(stderr, "--all") {
			t.Errorf("stderr %q should hint at --all", stderr)
		}
	})

	t.Run("--all follows cursors", func(t *testing.T) {
		dir := setupEnv(t)
		srv := newFakeServer(t, handler)
		writeConfig(t, dir, srv.URL, "tok-1")
		stdout, stderr, code := runCLI([]string{"list", "--all"}, "")
		if code != 0 {
			t.Fatalf("exit = %d, stderr = %q", code, stderr)
		}
		if len(srv.reqs) != 2 {
			t.Fatalf("requests = %d, want 2", len(srv.reqs))
		}
		if srv.reqs[1].query["cursor"] != "c1" {
			t.Errorf("second request cursor = %q, want c1", srv.reqs[1].query["cursor"])
		}
		if !strings.Contains(stdout, "x7Kp9qWm2AbCdE") || !strings.Contains(stdout, "SecondPageArti") {
			t.Errorf("stdout %q should include both pages", stdout)
		}
	})
}

// --- get ---

func TestGet(t *testing.T) {
	dir := setupEnv(t)
	body := `{"artifact":` + artifactJSON + `,"versions":[
		{"version":1,"size_bytes":31022,"content_type":"text/html","created_at":"2026-06-10T10:00:00Z"},
		{"version":2,"size_bytes":48213,"content_type":"text/html","created_at":"2026-06-12T15:04:05Z"}
	]}`
	srv := okServer(t, 200, body)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"get", "x7Kp9qWm2AbCdE"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if srv.reqs[0].method != "GET" || srv.reqs[0].path != "/v1/artifacts/x7Kp9qWm2AbCdE" {
		t.Errorf("request = %s %s", srv.reqs[0].method, srv.reqs[0].path)
	}
	for _, want := range []string{"x7Kp9qWm2AbCdE", "Q3 plan review", "active", "31022", "48213", "2026-06-10T10:00:00Z"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout %q missing %q", stdout, want)
		}
	}
}

// --- delete / expire ---

func TestDeleteIdempotent(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"id":"x7Kp9qWm2AbCdE","status":"deleted"}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	for i := 0; i < 2; i++ { // second run simulates retry; server stays 200 per contract
		stdout, stderr, code := runCLI([]string{"delete", "x7Kp9qWm2AbCdE"}, "")
		if code != 0 {
			t.Fatalf("run %d exit = %d, stderr = %q", i, code, stderr)
		}
		if !strings.Contains(stdout, "x7Kp9qWm2AbCdE") || !strings.Contains(strings.ToLower(stdout), "deleted") {
			t.Errorf("stdout = %q", stdout)
		}
	}
	if srv.reqs[0].method != "DELETE" || srv.reqs[0].path != "/v1/artifacts/x7Kp9qWm2AbCdE" {
		t.Errorf("request = %s %s", srv.reqs[0].method, srv.reqs[0].path)
	}
}

func TestExpireIdempotent(t *testing.T) {
	dir := setupEnv(t)
	expired := strings.Replace(artifactJSON, `"active"`, `"expired"`, 1)
	srv := okServer(t, 200, expired)
	writeConfig(t, dir, srv.URL, "tok-1")

	for i := 0; i < 2; i++ {
		stdout, stderr, code := runCLI([]string{"expire", "x7Kp9qWm2AbCdE"}, "")
		if code != 0 {
			t.Fatalf("run %d exit = %d, stderr = %q", i, code, stderr)
		}
		if !strings.Contains(stdout, "x7Kp9qWm2AbCdE") || !strings.Contains(strings.ToLower(stdout), "expired") {
			t.Errorf("stdout = %q", stdout)
		}
	}
	if srv.reqs[0].method != "POST" || srv.reqs[0].path != "/v1/artifacts/x7Kp9qWm2AbCdE/expire" {
		t.Errorf("request = %s %s", srv.reqs[0].method, srv.reqs[0].path)
	}
}

// --- token ---

func TestTokenCreateShowsSecretOnce(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, `{"id":"tok_1","name":"ci-bot","token":"sd_live_supersecret","created_at":"2026-06-12T15:04:05Z"}`)
	writeConfig(t, dir, srv.URL, "tok-admin")

	stdout, stderr, code := runCLI([]string{"token", "create", "ci-bot"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	req := srv.reqs[0]
	if req.method != "POST" || req.path != "/v1/admin/tokens" {
		t.Errorf("request = %s %s", req.method, req.path)
	}
	var sent map[string]string
	if err := json.Unmarshal([]byte(req.body), &sent); err != nil || sent["name"] != "ci-bot" {
		t.Errorf("body = %q", req.body)
	}
	if !strings.Contains(stdout, "sd_live_supersecret") {
		t.Errorf("stdout %q missing secret", stdout)
	}
	if !strings.Contains(strings.ToLower(stdout), "once") {
		t.Errorf("stdout %q should warn the secret is shown only once", stdout)
	}
}

func TestTokenCreateBootstrap(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, `{"id":"tok_1","name":"first","token":"sd_live_s","created_at":"2026-06-12T15:04:05Z"}`)
	writeConfig(t, dir, srv.URL, "tok-ignored")
	t.Setenv("SNAPDOC_BOOTSTRAP", "bootstrap-secret")

	_, stderr, code := runCLI([]string{"token", "create", "first", "--bootstrap"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if srv.reqs[0].auth != "Bearer bootstrap-secret" {
		t.Errorf("auth = %q, want Bearer bootstrap-secret", srv.reqs[0].auth)
	}
}

func TestTokenCreateBootstrapMissingEnv(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, `{}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	_, stderr, code := runCLI([]string{"token", "create", "first", "--bootstrap"}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if !strings.Contains(stderr, "SNAPDOC_BOOTSTRAP") {
		t.Errorf("stderr = %q", stderr)
	}
	if len(srv.reqs) != 0 {
		t.Errorf("no request should be sent, got %d", len(srv.reqs))
	}
}

func TestTokenList(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"tokens":[
		{"id":"tok_1","name":"ci-bot","created_at":"2026-06-12T15:04:05Z","last_used_at":"2026-06-12T16:00:00Z","revoked_at":null},
		{"id":"tok_2","name":"laptop","created_at":"2026-06-11T15:04:05Z","last_used_at":null,"revoked_at":"2026-06-12T00:00:00Z"}
	]}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"token", "list"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if srv.reqs[0].method != "GET" || srv.reqs[0].path != "/v1/admin/tokens" {
		t.Errorf("request = %s %s", srv.reqs[0].method, srv.reqs[0].path)
	}
	for _, want := range []string{"tok_1", "ci-bot", "tok_2", "laptop", "2026-06-12T00:00:00Z"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout %q missing %q", stdout, want)
		}
	}
}

func TestTokenRevoke(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"id":"tok_1","revoked_at":"2026-06-12T16:00:00Z"}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"token", "revoke", "tok_1"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if srv.reqs[0].method != "DELETE" || srv.reqs[0].path != "/v1/admin/tokens/tok_1" {
		t.Errorf("request = %s %s", srv.reqs[0].method, srv.reqs[0].path)
	}
	if !strings.Contains(stdout, "tok_1") {
		t.Errorf("stdout = %q", stdout)
	}
}

func TestTokenCreateJSON(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, `{"id":"tok_1","name":"ci-bot","token":"sd_live_supersecret","created_at":"2026-06-12T15:04:05Z"}`)
	writeConfig(t, dir, srv.URL, "tok-admin")

	stdout, stderr, code := runCLI([]string{"token", "create", "ci-bot", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if strings.Contains(stdout, "Token created:") || strings.Contains(stdout, "once") {
		t.Errorf("--json output should be pure JSON, got:\n%s", stdout)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout not JSON: %v\n%s", err, stdout)
	}
	for _, k := range []string{"id", "name", "token", "created_at"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %q key", k)
		}
	}
	if m["token"] != "sd_live_supersecret" {
		t.Errorf("token = %v", m["token"])
	}
}

func TestTokenListJSON(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"tokens":[{"id":"tok_1","name":"ci-bot","created_at":"c","last_used_at":"u","revoked_at":null}]}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, _, code := runCLI([]string{"token", "list", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var arr []map[string]any
	if err := json.Unmarshal([]byte(stdout), &arr); err != nil {
		t.Fatalf("stdout not a JSON array: %v\n%s", err, stdout)
	}
	if len(arr) != 1 || arr[0]["id"] != "tok_1" {
		t.Errorf("unexpected json: %s", stdout)
	}
}

func TestTokenRevokeJSON(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"id":"tok_1","revoked_at":"2026-06-12T16:00:00Z"}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, _, code := runCLI([]string{"token", "revoke", "tok_1", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if strings.Contains(stdout, "Revoked ") {
		t.Errorf("--json should not print human text:\n%s", stdout)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout not JSON: %v\n%s", err, stdout)
	}
	if m["id"] != "tok_1" || m["revoked_at"] != "2026-06-12T16:00:00Z" {
		t.Errorf("unexpected json: %s", stdout)
	}
}

// --- whoami ---

func TestWhoamiJSONOutput(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"token":{"id":"tok_abc","name":"ci-laptop","created_at":"2026-06-12T15:04:05Z"}}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"whoami", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	req := srv.reqs[0]
	if req.method != "GET" || req.path != "/v1/whoami" {
		t.Errorf("request = %s %s, want GET /v1/whoami", req.method, req.path)
	}
	if req.auth != "Bearer tok-1" {
		t.Errorf("auth = %q, want Bearer tok-1", req.auth)
	}
	var m struct {
		Token map[string]any `json:"token"`
	}
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout not JSON: %v\n%s", err, stdout)
	}
	if m.Token["id"] != "tok_abc" || m.Token["name"] != "ci-laptop" || m.Token["created_at"] != "2026-06-12T15:04:05Z" {
		t.Errorf("token = %v", m.Token)
	}
}

func TestWhoamiUnauthorizedSurfaces(t *testing.T) {
	dir := setupEnv(t)
	srv := errServer(t, 401, "unauthorized", "A valid API token is required.", nil)
	writeConfig(t, dir, srv.URL, "sd_live_bad")

	stdout, stderr, code := runCLI([]string{"whoami"}, "")
	if code == 0 {
		t.Fatal("want non-zero exit for an invalid token")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "unauthorized") {
		t.Errorf("stderr %q should report the unauthorized code", stderr)
	}
}

func TestWhoamiHumanOutput(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"token":{"id":"tok_abc","name":"ci-laptop","created_at":"2026-06-12T15:04:05Z"}}`)
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"whoami"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	for _, want := range []string{"ci-laptop", "tok_abc", "2026-06-12T15:04:05Z"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout %q missing %q", stdout, want)
		}
	}
}

// --- login ---

func TestLoginWithFlags(t *testing.T) {
	dir := setupEnv(t)

	stdout, stderr, code := runCLI([]string{"login", "--api-url", "https://api.example", "--token", "tok-new"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	p := filepath.Join(dir, "snapdoc", "config.json")
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 600", perm)
	}
	data, _ := os.ReadFile(p)
	var cfg map[string]string
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["api_url"] != "https://api.example" || cfg["token"] != "tok-new" {
		t.Errorf("config = %v", cfg)
	}
	if !strings.Contains(stdout, p) {
		t.Errorf("stdout %q should mention config path", stdout)
	}
}

func TestLoginPrompts(t *testing.T) {
	dir := setupEnv(t)

	_, stderr, code := runCLI([]string{"login"}, "https://api.prompted\ntok-prompted\n")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	data, err := os.ReadFile(filepath.Join(dir, "snapdoc", "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]string
	json.Unmarshal(data, &cfg)
	if cfg["api_url"] != "https://api.prompted" || cfg["token"] != "tok-prompted" {
		t.Errorf("config = %v", cfg)
	}
}

func TestLoginPromptDefaultsAPIURL(t *testing.T) {
	dir := setupEnv(t)

	// Empty API URL line accepts the default; token still provided.
	_, stderr, code := runCLI([]string{"login"}, "\ntok-prompted\n")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "snapdoc", "config.json"))
	var cfg map[string]string
	json.Unmarshal(data, &cfg)
	if cfg["api_url"] != "https://api.snapdoc.carraes.dev" {
		t.Errorf("api_url = %q, want default", cfg["api_url"])
	}
}

func TestLoginEmptyTokenFails(t *testing.T) {
	setupEnv(t)
	_, stderr, code := runCLI([]string{"login"}, "\n\n")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if !strings.Contains(strings.ToLower(stderr), "token") {
		t.Errorf("stderr = %q", stderr)
	}
}

// --- misc ---

func TestUnknownCommandFails(t *testing.T) {
	setupEnv(t)
	_, stderr, code := runCLI([]string{"frobnicate"}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stderr == "" {
		t.Error("want error on stderr")
	}
}

func TestVersionFlag(t *testing.T) {
	stdout, _, code := runCLI([]string{"--version"}, "")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if strings.TrimSpace(stdout) == "" {
		t.Fatal("--version printed nothing")
	}
}

func TestPublishJSONOutput(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"publish", "--json", "-"}, "<h1>hi</h1>")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, stdout)
	}
	if m["id"] != "x7Kp9qWm2AbCdE" {
		t.Errorf("id = %v", m["id"])
	}
	if m["url"] == "" || m["url"] == nil {
		t.Error("missing url in JSON output")
	}
}

func TestPublishJSONBeatsQuiet(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"publish", "--json", "--quiet", "-"}, "x")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("--json should win over --quiet, got: %s", stdout)
	}
	if m["id"] != "x7Kp9qWm2AbCdE" {
		t.Errorf("id = %v", m["id"])
	}
}

func TestListJSONOutput(t *testing.T) {
	dir := setupEnv(t)
	body := `{"artifacts":[{"id":"a1","url":"u1","title":"t","status":"active","current_version":1,"content_type":"text/html","size_bytes":1,"created_at":"c","expires_at":"e"}],"next_cursor":""}`
	srv := okServer(t, 200, body)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"list", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout not JSON: %v\n%s", err, stdout)
	}
	arr, ok := m["artifacts"].([]any)
	if !ok || len(arr) != 1 {
		t.Errorf("artifacts = %v", m["artifacts"])
	}
}

func TestGetJSONOutput(t *testing.T) {
	dir := setupEnv(t)
	body := `{"artifact":` + artifactJSON + `,"versions":[{"version":1,"size_bytes":1,"content_type":"text/html","created_at":"c"}]}`
	srv := okServer(t, 200, body)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"get", "x7Kp9qWm2AbCdE", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout not JSON: %v\n%s", err, stdout)
	}
	if _, ok := m["artifact"]; !ok {
		t.Error("missing artifact key")
	}
	if _, ok := m["versions"]; !ok {
		t.Error("missing versions key")
	}
}

func TestOpenCommand(t *testing.T) {
	dir := setupEnv(t)
	body := `{"artifact":` + artifactJSON + `,"versions":[]}`
	srv := okServer(t, 200, body)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")

	var opened string
	orig := openURL
	openURL = func(u string) error { opened = u; return nil }
	defer func() { openURL = orig }()

	_, _, code := runCLI([]string{"open", "x7Kp9qWm2AbCdE"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if opened != "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE" {
		t.Errorf("opened = %q", opened)
	}
	if len(srv.reqs) == 0 || srv.reqs[0].method != "GET" || srv.reqs[0].path != "/v1/artifacts/x7Kp9qWm2AbCdE" {
		t.Errorf("expected GET /v1/artifacts/x7Kp9qWm2AbCdE, got %+v", srv.reqs)
	}
}

func TestPublishPasscodeHeader(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	_, _, code := runCLI([]string{"publish", "--passcode", "hunter2", "-"}, "<h1>hi</h1>")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if srv.reqs[0].passcode != "hunter2" {
		t.Errorf("X-Snapdoc-Passcode = %q, want hunter2", srv.reqs[0].passcode)
	}
}

func TestPublishNoPasscodeNoHeader(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	runCLI([]string{"publish", "-"}, "x")
	if srv.reqs[0].passcode != "" {
		t.Errorf("unexpected passcode header %q", srv.reqs[0].passcode)
	}
}

// --- publish video ---

func TestPublishVideoDetectsMP4BeforeReadInputAndStreamsExactLength(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	fi, err := os.Stat(fixtureVideoH264AAC)
	if err != nil {
		t.Fatalf("stat fixture: %v", err)
	}

	stdout, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if len(srv.reqs) != 1 {
		t.Fatalf("want 1 request, got %d: %+v", len(srv.reqs), srv.reqs)
	}
	req := srv.reqs[0]
	if req.method != "POST" || req.path != "/v1/artifacts" {
		t.Errorf("request = %s %s, want POST /v1/artifacts", req.method, req.path)
	}
	if req.ctype != "video/mp4" {
		t.Errorf("Content-Type = %q, want video/mp4 (proves the video branch, not the document one)", req.ctype)
	}
	if req.query["filename"] != "video-h264-aac.mp4" {
		t.Errorf("filename = %q, want the source file's basename", req.query["filename"])
	}
	if req.contentLength != fi.Size() {
		t.Errorf("Content-Length = %d, want exactly %d", req.contentLength, fi.Size())
	}
	if int64(len(req.body)) != fi.Size() {
		t.Errorf("streamed body length = %d, want %d", len(req.body), fi.Size())
	}
	if stdout == "" {
		t.Error("want non-empty human output")
	}
}

func TestPublishVideoForwardsFilenameTitleTTLPasscode(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	_, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--title", "Demo", "--ttl", "12h", "--passcode", "hunter2"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	req := srv.reqs[0]
	if req.query["title"] != "Demo" {
		t.Errorf("title = %q, want Demo", req.query["title"])
	}
	if req.query["ttl"] != "12h" {
		t.Errorf("ttl = %q, want 12h", req.query["ttl"])
	}
	if req.passcode != "hunter2" {
		t.Errorf("passcode header = %q, want hunter2", req.passcode)
	}
}

func TestPublishVideoUpdatePostsToVersionsAndOmitsPasscode(t *testing.T) {
	dir := setupEnv(t)
	updated := strings.Replace(videoArtifactJSON, `"current_version": 1`, `"current_version": 2`, 1)
	srv := okServer(t, 201, updated)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--update", "vAbc123XyZ", "--passcode", "ignored-on-update"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	req := srv.reqs[0]
	if req.method != "POST" || req.path != "/v1/artifacts/vAbc123XyZ/versions" {
		t.Errorf("request = %s %s, want POST /v1/artifacts/vAbc123XyZ/versions", req.method, req.path)
	}
	if req.passcode != "" {
		t.Errorf("passcode should not be sent on update, got %q", req.passcode)
	}
	if !strings.Contains(stdout, "2") {
		t.Errorf("stdout %q should mention version 2", stdout)
	}
}

func TestPublishVideoOmittedTTLLetsServerDefault(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	_, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if v, ok := srv.reqs[0].query["ttl"]; ok {
		t.Errorf("ttl should be omitted so the server can default it, got %q", v)
	}
}

func TestPublishVideoInvalidTTLSurfacesServerError(t *testing.T) {
	dir := setupEnv(t)
	srv := errServer(t, 400, "invalid_ttl", `TTL must be a duration between 1h and 7d, e.g. "12h" or "3d".`, nil)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--ttl", "30d"}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "invalid_ttl") {
		t.Errorf("stderr = %q, want it to surface invalid_ttl", stderr)
	}
}

func TestPublishVideoUploadsPoster(t *testing.T) {
	dir := setupEnv(t)
	srv := routedServer(t, map[string]respSpec{
		"POST /v1/artifacts":                             {201, videoArtifactJSON},
		"PUT /v1/artifacts/vAbc123XyZ/versions/1/poster": {200, videoVersionJSON},
	})
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	poster := writeTempBinaryFile(t, "poster.jpg", jpegMagicBytes)
	_, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--poster", poster}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if len(srv.reqs) != 2 {
		t.Fatalf("want 2 requests (video + poster), got %d: %+v", len(srv.reqs), srv.reqs)
	}
	posterReq := srv.reqs[1]
	if posterReq.method != "PUT" || posterReq.path != "/v1/artifacts/vAbc123XyZ/versions/1/poster" {
		t.Errorf("poster request = %s %s, want PUT /v1/artifacts/vAbc123XyZ/versions/1/poster", posterReq.method, posterReq.path)
	}
	if posterReq.ctype != "image/jpeg" {
		t.Errorf("poster Content-Type = %q, want image/jpeg", posterReq.ctype)
	}
	if posterReq.contentLength != int64(len(jpegMagicBytes)) {
		t.Errorf("poster Content-Length = %d, want %d", posterReq.contentLength, len(jpegMagicBytes))
	}
}

// TestPublishVideoPosterRetryTargetsReturnedVersion proves the poster always
// targets whatever version the create/update call just returned (not a
// hardcoded 1) — the mechanism that makes retrying the poster alone against
// "artifact ID + version" (as named in a partial-failure error) land on the
// right version.
func TestPublishVideoPosterRetryTargetsReturnedVersion(t *testing.T) {
	dir := setupEnv(t)
	updated := strings.Replace(videoArtifactJSON, `"current_version": 1`, `"current_version": 2`, 1)
	srv := routedServer(t, map[string]respSpec{
		"POST /v1/artifacts/vAbc123XyZ/versions":         {201, updated},
		"PUT /v1/artifacts/vAbc123XyZ/versions/2/poster": {200, videoVersionJSON},
	})
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	poster := writeTempBinaryFile(t, "poster.png", pngMagicBytes)
	_, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--update", "vAbc123XyZ", "--poster", poster}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if len(srv.reqs) != 2 {
		t.Fatalf("want 2 requests, got %d: %+v", len(srv.reqs), srv.reqs)
	}
	posterReq := srv.reqs[1]
	if posterReq.path != "/v1/artifacts/vAbc123XyZ/versions/2/poster" {
		t.Errorf("poster path = %q, want it to target the version just returned (2)", posterReq.path)
	}
	if posterReq.ctype != "image/png" {
		t.Errorf("poster Content-Type = %q, want image/png", posterReq.ctype)
	}
}

func TestPublishVideoHumanOutputIncludesWatchFileDurationSizeExpiry(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, _, code := runCLI([]string{"publish", fixtureVideoH264AAC}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	for _, want := range []string{
		"vAbc123XyZ",
		"https://snapdoc.carraes.dev/vAbc123XyZ", // watch URL
		"https://snapdoc.carraes.dev/vAbc123XyZ/media/video-h264-aac.mp4", // file URL
		"1.234s",               // duration (1234ms)
		"3600 bytes",           // size
		"2026-06-15T15:04:05Z", // expiry
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout %q missing %q", stdout, want)
		}
	}
}

func TestPublishVideoQuietPrintsOnlyWatchURL(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--quiet"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if stdout != "https://snapdoc.carraes.dev/vAbc123XyZ\n" {
		t.Errorf("stdout = %q, want exactly the watch URL", stdout)
	}
}

func TestPublishVideoJSONPrintsServerObject(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout is not JSON: %v\n%s", err, stdout)
	}
	if m["kind"] != "video" {
		t.Errorf("kind = %v, want video", m["kind"])
	}
	if m["duration_ms"] == nil {
		t.Error("missing duration_ms in JSON output")
	}
}

func TestPublishVideoPosterFailureIncludesArtifactAndVersion(t *testing.T) {
	dir := setupEnv(t)
	srv := routedServer(t, map[string]respSpec{
		"POST /v1/artifacts": {201, videoArtifactJSON},
		"PUT /v1/artifacts/vAbc123XyZ/versions/1/poster": {
			400,
			`{"error":{"code":"unsupported_content_type","message":"Poster Content-Type must be image/jpeg or image/png."}}`,
		},
	})
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	poster := writeTempBinaryFile(t, "poster.jpg", jpegMagicBytes)
	stdout, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--poster", poster}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "vAbc123XyZ") {
		t.Errorf("stderr %q must name the artifact ID so the poster can be retried", stderr)
	}
	if !strings.Contains(stderr, "version 1") {
		t.Errorf("stderr %q must name the version so the poster can be retried", stderr)
	}
	if !strings.Contains(stderr, "unsupported_content_type") {
		t.Errorf("stderr %q should still surface the underlying failure", stderr)
	}
}

func TestPublishVideoRejectsOversizePoster(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	f, err := createFileOfSize(t, "huge-poster.jpg", 5*1024*1024+1)
	if err != nil {
		t.Fatalf("createFileOfSize: %v", err)
	}

	stdout, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--poster", f}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "size limit") {
		t.Errorf("stderr = %q, want it to name the size limit", stderr)
	}
	if len(srv.reqs) != 1 {
		t.Errorf("only the video request should be sent, got %d: %+v", len(srv.reqs), srv.reqs)
	}
}

func TestPublishVideoRejectsNonImagePoster(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	notImage := writeTempFile(t, "poster.txt", "not an image")
	_, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--poster", notImage}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if !strings.Contains(stderr, "JPEG or PNG") {
		t.Errorf("stderr = %q, want it to name the accepted poster formats", stderr)
	}
}

func TestPublishVideoRejectsInvalidLocalMP4(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	f := writeTempFile(t, "not-really-a-video.mp4", "this is not an mp4")
	stdout, stderr, code := runCLI([]string{"publish", f}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "not a valid mp4") {
		t.Errorf("stderr = %q, want it to explain the file is not a valid mp4", stderr)
	}
	if len(srv.reqs) != 0 {
		t.Errorf("no request should be sent for a file that fails local preflight, got %d", len(srv.reqs))
	}
}

func TestPublishVideoStdinRejectedWithClearError(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	data, err := os.ReadFile(fixtureVideoH264AAC)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	stdout, stderr, code := runCLI([]string{"publish", "-"}, string(data))
	if code == 0 {
		t.Fatal("want non-zero exit for video piped via stdin")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "Content-Length") {
		t.Errorf("stderr = %q, want it to explain the exact Content-Length requirement", stderr)
	}
	if len(srv.reqs) != 0 {
		t.Errorf("no request should be sent, got %d", len(srv.reqs))
	}
}

// --- publish video: poster-only retry & flag validation ---

func TestPublishVideoPosterOnlyRetryUpdatesExistingVersion(t *testing.T) {
	dir := setupEnv(t)
	srv := routedServer(t, map[string]respSpec{
		"GET /v1/artifacts/vAbc123XyZ":                   {200, `{"artifact":` + videoArtifactJSON + `,"versions":[]}`},
		"PUT /v1/artifacts/vAbc123XyZ/versions/1/poster": {200, videoVersionJSON},
	})
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	poster := writeTempBinaryFile(t, "poster.jpg", jpegMagicBytes)
	stdout, stderr, code := runCLI([]string{"publish", "--update", "vAbc123XyZ", "--poster", poster}, "")
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	if len(srv.reqs) != 2 {
		t.Fatalf("want 2 requests (fetch + poster), got %d: %+v", len(srv.reqs), srv.reqs)
	}
	getReq := srv.reqs[0]
	if getReq.method != "GET" || getReq.path != "/v1/artifacts/vAbc123XyZ" {
		t.Errorf("first request = %s %s, want GET /v1/artifacts/vAbc123XyZ (no video is re-uploaded)", getReq.method, getReq.path)
	}
	posterReq := srv.reqs[1]
	if posterReq.method != "PUT" || posterReq.path != "/v1/artifacts/vAbc123XyZ/versions/1/poster" {
		t.Errorf("poster request = %s %s, want PUT /v1/artifacts/vAbc123XyZ/versions/1/poster", posterReq.method, posterReq.path)
	}
	if posterReq.ctype != "image/jpeg" {
		t.Errorf("poster Content-Type = %q, want image/jpeg", posterReq.ctype)
	}
	if !strings.Contains(stdout, "vAbc123XyZ") {
		t.Errorf("stdout %q should mention the artifact", stdout)
	}
}

func TestPublishVideoPosterOnlyRejectsNonVideoArtifact(t *testing.T) {
	dir := setupEnv(t)
	srv := routedServer(t, map[string]respSpec{
		"GET /v1/artifacts/x7Kp9qWm2AbCdE": {200, `{"artifact":` + artifactJSON + `,"versions":[]}`},
	})
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	poster := writeTempBinaryFile(t, "poster.jpg", jpegMagicBytes)
	stdout, stderr, code := runCLI([]string{"publish", "--update", "x7Kp9qWm2AbCdE", "--poster", poster}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "not a video") {
		t.Errorf("stderr = %q, want it to explain the artifact is not a video", stderr)
	}
}

func TestPublishVideoPosterWithoutUpdateOrFileErrors(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	poster := writeTempBinaryFile(t, "poster.jpg", jpegMagicBytes)
	stdout, stderr, code := runCLI([]string{"publish", "--poster", poster}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "--poster") {
		t.Errorf("stderr = %q, want an actionable --poster error", stderr)
	}
	if len(srv.reqs) != 0 {
		t.Errorf("no request should be sent, got %d", len(srv.reqs))
	}
}

func TestPublishVideoPosterWithDocumentFileErrors(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, artifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	doc := writeTempFile(t, "report.html", "<h1>hi</h1>")
	poster := writeTempBinaryFile(t, "poster.jpg", jpegMagicBytes)
	stdout, stderr, code := runCLI([]string{"publish", doc, "--poster", poster}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "video") {
		t.Errorf("stderr = %q, want it to explain posters are video-only", stderr)
	}
	if len(srv.reqs) != 0 {
		t.Errorf("no request should be sent, got %d", len(srv.reqs))
	}
}

func TestPublishVideoCommentsFlagErrors(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 201, videoArtifactJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	stdout, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--comments"}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "--comments") {
		t.Errorf("stderr = %q, want it to name --comments", stderr)
	}
	if len(srv.reqs) != 0 {
		t.Errorf("no request should be sent, got %d", len(srv.reqs))
	}
}

func TestPublishVideoPosterOnlyRejectsRetryIncompatibleFlags(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "comments", args: []string{"--comments"}, want: "--comments"},
		{name: "ttl", args: []string{"--ttl", "7d"}, want: "--ttl"},
		{name: "title", args: []string{"--title", "New Title"}, want: "--title"},
		{name: "markdown", args: []string{"--markdown"}, want: "--markdown"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := setupEnv(t)
			srv := okServer(t, 200, `{"artifact":`+videoArtifactJSON+`,"versions":[]}`)
			defer srv.Close()
			writeConfig(t, dir, srv.URL, "tok-1")

			poster := writeTempBinaryFile(t, "poster.jpg", jpegMagicBytes)
			args := append([]string{"publish", "--update", "vAbc123XyZ", "--poster", poster}, tt.args...)
			stdout, stderr, code := runCLI(args, "")
			if code == 0 {
				t.Fatal("want non-zero exit")
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want empty", stdout)
			}
			if !strings.Contains(stderr, tt.want) {
				t.Errorf("stderr = %q, want it to name %s", stderr, tt.want)
			}
			if len(srv.reqs) != 0 {
				t.Errorf("no request should be sent, got %d: %+v", len(srv.reqs), srv.reqs)
			}
		})
	}
}

func TestPublishVideoPosterFailureNamesRetryCommand(t *testing.T) {
	dir := setupEnv(t)
	srv := routedServer(t, map[string]respSpec{
		"POST /v1/artifacts": {201, videoArtifactJSON},
		"PUT /v1/artifacts/vAbc123XyZ/versions/1/poster": {
			400,
			`{"error":{"code":"unsupported_content_type","message":"Poster Content-Type must be image/jpeg or image/png."}}`,
		},
	})
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok-1")

	poster := writeTempBinaryFile(t, "poster.jpg", jpegMagicBytes)
	_, stderr, code := runCLI([]string{"publish", fixtureVideoH264AAC, "--poster", poster}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	wantCmd := fmt.Sprintf("snapdoc publish --update vAbc123XyZ --poster %s", poster)
	if !strings.Contains(stderr, wantCmd) {
		t.Errorf("stderr %q must name the exact retry command %q", stderr, wantCmd)
	}
}

func TestGetShowsPasscodeIndicator(t *testing.T) {
	dir := setupEnv(t)
	body := `{"artifact":{"id":"x7Kp9qWm2AbCdE","url":"u","title":"t","status":"active","current_version":1,"content_type":"text/html","size_bytes":1,"created_at":"c","expires_at":"e","has_passcode":true},"versions":[]}`
	srv := okServer(t, 200, body)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"get", "x7Kp9qWm2AbCdE"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(strings.ToLower(stdout), "passcode") {
		t.Errorf("get output missing passcode indicator:\n%s", stdout)
	}
}

func TestCommentsReadsAndRenders(t *testing.T) {
	dir := setupEnv(t)
	body := `{"artifact_id":"x7Kp9qWm2AbCdE","comments":[{"id":"cmt_1","author":"jane@team.com","version":2,"body":"tighten intro","created_at":"2026-06-17T10:00:00Z"}]}`
	srv := okServer(t, 200, body)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"comments", "x7Kp9qWm2AbCdE"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if srv.reqs[0].method != "GET" || srv.reqs[0].path != "/v1/artifacts/x7Kp9qWm2AbCdE/comments" {
		t.Errorf("req = %s %s", srv.reqs[0].method, srv.reqs[0].path)
	}
	if !strings.Contains(stdout, "jane@team.com") || !strings.Contains(stdout, "tighten intro") {
		t.Errorf("output missing comment:\n%s", stdout)
	}
}

func TestCommentsJSON(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"artifact_id":"x","comments":[{"id":"cmt_1","author":"a","version":1,"body":"b","created_at":"c"}]}`)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"comments", "x", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("not JSON: %s", stdout)
	}
	if _, ok := m["comments"]; !ok {
		t.Error("missing comments key")
	}
}

func TestCommentsEmpty(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"artifact_id":"x","comments":[]}`)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"comments", "x"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(strings.ToLower(stdout), "no comments") {
		t.Errorf("expected empty message:\n%s", stdout)
	}
}

func TestCommentsRendersThreadsAndResolved(t *testing.T) {
	dir := setupEnv(t)
	body := `{"artifact_id":"x","comments":[` +
		`{"id":"cmt_root","author":"jane@team.com","version":2,"body":"tighten intro","created_at":"t1","parent_id":null,"resolved":true,"resolved_at":"t2","resolved_by":"lead@team.com"},` +
		`{"id":"cmt_reply","author":"bob@team.com","version":3,"body":"done in v3","created_at":"t3","parent_id":"cmt_root","resolved":false,"resolved_at":null,"resolved_by":null}` +
		`]}`
	srv := okServer(t, 200, body)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"comments", "x"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(stdout, "resolved") || !strings.Contains(stdout, "lead@team.com") {
		t.Errorf("missing resolved marker:\n%s", stdout)
	}
	if !strings.Contains(stdout, "↳") || !strings.Contains(stdout, "bob@team.com") || !strings.Contains(stdout, "done in v3") {
		t.Errorf("missing indented reply:\n%s", stdout)
	}
}

func TestCommentsStatusFlag(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"artifact_id":"x","comments":[]}`)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	_, _, code := runCLI([]string{"comments", "x", "--status", "open"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if srv.reqs[0].query["status"] != "open" {
		t.Errorf("status query = %q, want open", srv.reqs[0].query["status"])
	}
}

// --- read ---

const contentEnvelopeJSON = `{"id":"x7Kp9qWm2AbCdE","version":2,"format":"md","content_type":"text/markdown","content":"# Hello\n\nWorld.\n"}`

func TestReadPrintsMarkdownContent(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, contentEnvelopeJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"read", "x7Kp9qWm2AbCdE"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(stdout, "# Hello") || !strings.Contains(stdout, "World.") {
		t.Errorf("stdout missing content:\n%s", stdout)
	}
	req := srv.reqs[0]
	if req.method != "GET" || req.path != "/v1/artifacts/x7Kp9qWm2AbCdE/content" {
		t.Errorf("got %s %s, want GET /v1/artifacts/x7Kp9qWm2AbCdE/content", req.method, req.path)
	}
	if req.query["format"] != "md" {
		t.Errorf("format query = %q, want md", req.query["format"])
	}
}

func TestReadRawSendsHTMLFormat(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, `{"id":"x","version":1,"format":"html","content_type":"text/html","content":"<!doctype html><h1>Hi</h1>"}`)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"read", "x", "--raw"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if srv.reqs[0].query["format"] != "html" {
		t.Errorf("format = %q, want html", srv.reqs[0].query["format"])
	}
	if !strings.Contains(stdout, "<!doctype html>") {
		t.Errorf("stdout missing html:\n%s", stdout)
	}
}

func TestReadVersionFlag(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, contentEnvelopeJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	if _, _, code := runCLI([]string{"read", "x", "--rev", "2"}, ""); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if srv.reqs[0].query["version"] != "2" {
		t.Errorf("version = %q, want 2", srv.reqs[0].query["version"])
	}
}

func TestReadPasscodeFlagSendsHeader(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, contentEnvelopeJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	if _, _, code := runCLI([]string{"read", "x", "--passcode", "hunter2"}, ""); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if srv.reqs[0].passcode != "hunter2" {
		t.Errorf("X-Snapdoc-Passcode = %q, want hunter2", srv.reqs[0].passcode)
	}
}

func TestReadPasscodeEnvSendsHeader(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, contentEnvelopeJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	t.Setenv("SNAPDOC_PASSCODE", "fromenv")
	if _, _, code := runCLI([]string{"read", "x"}, ""); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if srv.reqs[0].passcode != "fromenv" {
		t.Errorf("X-Snapdoc-Passcode = %q, want fromenv", srv.reqs[0].passcode)
	}
}

func TestReadJSONOutput(t *testing.T) {
	dir := setupEnv(t)
	srv := okServer(t, 200, contentEnvelopeJSON)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, _, code := runCLI([]string{"read", "x7Kp9qWm2AbCdE", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(stdout), &m); err != nil {
		t.Fatalf("stdout not JSON: %v\n%s", err, stdout)
	}
	for _, k := range []string{"id", "version", "format", "content_type", "content"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %q key", k)
		}
	}
}

// A non-TTY stdin (runCLI uses a strings.Reader) is the agent path: a
// passcode_required error must surface directly with no prompt and no retry.
func TestReadPasscodeRequiredNonTTYSurfacesError(t *testing.T) {
	dir := setupEnv(t)
	srv := errServer(t, 401, "passcode_required", "Supply X-Snapdoc-Passcode.", nil)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")
	stdout, stderr, code := runCLI([]string{"read", "x"}, "")
	if code == 0 {
		t.Fatal("want non-zero exit")
	}
	if stdout != "" {
		t.Errorf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "passcode_required") {
		t.Errorf("stderr %q missing passcode_required", stderr)
	}
	if len(srv.reqs) != 1 {
		t.Errorf("made %d requests, want 1 (no prompt retry when non-interactive)", len(srv.reqs))
	}
}

func TestCommentsFiltersOrphanedByDefault(t *testing.T) {
	dir := setupEnv(t)
	body := `{"artifact_id":"x","comments":[` +
		`{"id":"cmt_gone","author":"ana","version":1,"body":"stale note","created_at":"t1","parent_id":null,"orphaned":true,"anchor":{"exact":"old text","prefix":"","suffix":"","start":0,"end":8}},` +
		`{"id":"cmt_gone_reply","author":"bo","version":1,"body":"stale reply","created_at":"t2","parent_id":"cmt_gone"},` +
		`{"id":"cmt_live","author":"ana","version":1,"body":"fresh note","created_at":"t3","parent_id":null,"orphaned":false,"anchor":{"exact":"kept","prefix":"","suffix":"","start":0,"end":4}}` +
		`]}`
	srv := okServer(t, 200, body)
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")

	stdout, _, code := runCLI([]string{"comments", "x"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if strings.Contains(stdout, "stale note") || strings.Contains(stdout, "stale reply") {
		t.Errorf("orphaned thread should be hidden by default:\n%s", stdout)
	}
	if !strings.Contains(stdout, "fresh note") {
		t.Errorf("live thread missing:\n%s", stdout)
	}

	stdout, _, code = runCLI([]string{"comments", "x", "--include-orphaned"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(stdout, "stale note") || !strings.Contains(stdout, "[orphaned]") {
		t.Errorf("expected orphaned thread with marker:\n%s", stdout)
	}

	stdout, _, code = runCLI([]string{"comments", "x", "--json"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if strings.Contains(stdout, "cmt_gone") {
		t.Errorf("JSON output should filter orphaned threads by default:\n%s", stdout)
	}
}

func TestCommentsReplyPostsViaReaderAPI(t *testing.T) {
	dir := setupEnv(t)
	srv := newFakeServer(t, func(r recordedReq, w http.ResponseWriter) {
		if r.path == "/v1/whoami" {
			io.WriteString(w, `{"token":{"id":"tok_1","name":"codex-agent","created_at":"t"}}`)
			return
		}
		w.WriteHeader(201)
		io.WriteString(w, `{"id":"cmt_reply","author":"codex-agent","author_kind":"anon","version":1,"body":"done","created_at":"t","parent_id":"cmt_root","resolved":false}`)
	})
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")

	stdout, _, code := runCLI([]string{"comments", "reply", "x7Kp9qWm2AbCdE", "cmt_root", "done in v3"}, "")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	// Default name comes from whoami, then the reply posts to the reader API.
	post := srv.reqs[len(srv.reqs)-1]
	if post.method != "POST" || post.path != "/v1/reader/artifacts/x7Kp9qWm2AbCdE/comments" {
		t.Errorf("req = %s %s", post.method, post.path)
	}
	for _, want := range []string{`"parent_id":"cmt_root"`, `"author_name":"codex-agent"`, `"body":"done in v3"`} {
		if !strings.Contains(post.body, want) {
			t.Errorf("post body missing %s:\n%s", want, post.body)
		}
	}
	if !strings.Contains(stdout, "cmt_root") {
		t.Errorf("output should confirm the reply:\n%s", stdout)
	}
}

func TestCommentsReplyExplicitNameAndStdin(t *testing.T) {
	dir := setupEnv(t)
	srv := newFakeServer(t, func(r recordedReq, w http.ResponseWriter) {
		if r.path == "/v1/whoami" {
			t.Error("whoami should not be called when --name is given")
		}
		w.WriteHeader(201)
		io.WriteString(w, `{"id":"cmt_reply","author":"Codex","author_kind":"anon","version":1,"body":"b","created_at":"t","parent_id":"cmt_root","resolved":false}`)
	})
	defer srv.Close()
	writeConfig(t, dir, srv.URL, "tok")

	_, _, code := runCLI([]string{"comments", "reply", "x", "cmt_root", "-", "--name", "Codex"}, "fixed in the next version\n")
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	post := srv.reqs[len(srv.reqs)-1]
	for _, want := range []string{`"author_name":"Codex"`, `"body":"fixed in the next version"`} {
		if !strings.Contains(post.body, want) {
			t.Errorf("post body missing %s:\n%s", want, post.body)
		}
	}
}

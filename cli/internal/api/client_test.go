package api

import (
	"bytes"
	"encoding/json"
	"errors"
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

const videoArtifactJSON = `{
	"id": "v7Kp9qWm2AbCdE",
	"kind": "video",
	"url": "https://snapdoc.carraes.dev/v7Kp9qWm2AbCdE",
	"file_url": "https://snapdoc.carraes.dev/v7Kp9qWm2AbCdE/file.mp4",
	"version_url": "https://snapdoc.carraes.dev/v7Kp9qWm2AbCdE/v/1",
	"version_file_url": "https://snapdoc.carraes.dev/v7Kp9qWm2AbCdE/v/1/file.mp4",
	"poster_url": "https://snapdoc.carraes.dev/v7Kp9qWm2AbCdE/poster.jpg",
	"version_poster_url": "https://snapdoc.carraes.dev/v7Kp9qWm2AbCdE/v/1/poster.jpg",
	"title": "Checkout flow",
	"status": "active",
	"current_version": 1,
	"content_type": "video/mp4",
	"size_bytes": 5242880,
	"duration_ms": 12345,
	"width": 1920,
	"height": 1080,
	"video_codec": "h264",
	"audio_codec": "aac",
	"created_at": "2026-06-12T15:04:05Z",
	"expires_at": "2026-06-26T15:04:05Z"
}`

// videoVersionJSON has a null version_poster_url and audio_codec, exercising
// the nullable-media-field decode path (a silent video, or one whose poster
// hasn't been generated/uploaded yet).
const videoVersionJSON = `{
	"version": 2,
	"size_bytes": 7340032,
	"content_type": "video/mp4",
	"created_at": "2026-06-13T10:00:00Z",
	"kind": "video",
	"version_url": "https://snapdoc.carraes.dev/v7Kp9qWm2AbCdE/v/2",
	"version_file_url": "https://snapdoc.carraes.dev/v7Kp9qWm2AbCdE/v/2/file.mp4",
	"version_poster_url": null,
	"duration_ms": 20000,
	"width": 1280,
	"height": 720,
	"video_codec": "vp9",
	"audio_codec": null
}`

// capture records the last request the client sent.
type capture struct {
	method        string
	path          string
	query         string
	auth          string
	ctype         string
	body          string
	passcode      string
	contentLength int64
}

func contractServer(t *testing.T, cap *capture, status int, respBody string, header map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*cap = capture{
			method:        r.Method,
			path:          r.URL.Path,
			query:         r.URL.RawQuery,
			auth:          r.Header.Get("Authorization"),
			ctype:         r.Header.Get("Content-Type"),
			body:          string(b),
			passcode:      r.Header.Get("X-Snapdoc-Passcode"),
			contentLength: r.ContentLength,
		}
		for k, v := range header {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, respBody)
	}))
}

// spyReader counts bytes read so far. A custom RoundTripper checks this count
// the instant it is invoked — i.e. exactly when the client hands the request
// to the transport — to prove the client never drained the reader into a
// buffer beforehand (which the existing multipart/document path does, via
// io.Copy/io.ReadAll into a bytes.Buffer before ever building the request).
type spyReader struct {
	r    io.Reader
	read int
}

func (s *spyReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	s.read += n
	return n, err
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestPublish(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 201, artifactJSON, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "sd_live_abc"}
	a, err := c.Publish(strings.NewReader("<h1>hi</h1>"), "text/html", PublishOptions{Title: "Q3 plan review", TTL: "7d"})
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	if cap.method != "POST" || cap.path != "/v1/artifacts" {
		t.Errorf("request = %s %s, want POST /v1/artifacts", cap.method, cap.path)
	}
	if cap.auth != "Bearer sd_live_abc" {
		t.Errorf("Authorization = %q, want Bearer sd_live_abc", cap.auth)
	}
	if cap.ctype != "text/html" {
		t.Errorf("Content-Type = %q, want text/html", cap.ctype)
	}
	if cap.body != "<h1>hi</h1>" {
		t.Errorf("body = %q", cap.body)
	}
	for _, want := range []string{"title=Q3+plan+review", "ttl=7d"} {
		if !strings.Contains(cap.query, want) {
			t.Errorf("query %q missing %q", cap.query, want)
		}
	}
	if a.ID != "x7Kp9qWm2AbCdE" || a.URL != "https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE" || a.CurrentVersion != 1 {
		t.Errorf("artifact = %+v", a)
	}
}

func TestPublishOmitsEmptyParams(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 201, artifactJSON, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	if _, err := c.Publish(strings.NewReader("x"), "text/markdown", PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	if cap.query != "" {
		t.Errorf("query = %q, want empty", cap.query)
	}
	if cap.ctype != "text/markdown" {
		t.Errorf("Content-Type = %q, want text/markdown", cap.ctype)
	}
}

func TestPublishVersion(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 201, artifactJSON, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	if _, err := c.PublishVersion("x7Kp9qWm2AbCdE", strings.NewReader("v2"), "text/html", PublishOptions{TTL: "12h"}); err != nil {
		t.Fatal(err)
	}
	if cap.method != "POST" || cap.path != "/v1/artifacts/x7Kp9qWm2AbCdE/versions" {
		t.Errorf("request = %s %s, want POST /v1/artifacts/x7Kp9qWm2AbCdE/versions", cap.method, cap.path)
	}
	if cap.query != "ttl=12h" {
		t.Errorf("query = %q, want ttl=12h", cap.query)
	}
}

func TestPublishVideo(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 201, videoArtifactJSON, nil)
	defer srv.Close()

	payload := []byte("fake-mp4-bytes-0123456789")
	c := &Client{BaseURL: srv.URL, Token: "sd_live_abc"}
	a, err := c.PublishVideo(bytes.NewReader(payload), VideoPublishOptions{
		Title:    "Checkout flow",
		TTL:      "7d",
		Passcode: "hunter2",
		Filename: "checkout flow.mp4",
		Size:     int64(len(payload)),
	})
	if err != nil {
		t.Fatalf("PublishVideo() error = %v", err)
	}

	if cap.method != "POST" || cap.path != "/v1/artifacts" {
		t.Errorf("request = %s %s, want POST /v1/artifacts", cap.method, cap.path)
	}
	if cap.ctype != "video/mp4" {
		t.Errorf("Content-Type = %q, want video/mp4", cap.ctype)
	}
	if cap.contentLength != int64(len(payload)) {
		t.Errorf("Content-Length = %d, want %d", cap.contentLength, len(payload))
	}
	if cap.body != string(payload) {
		t.Errorf("body = %q, want %q", cap.body, payload)
	}
	if cap.auth != "Bearer sd_live_abc" {
		t.Errorf("Authorization = %q, want Bearer sd_live_abc", cap.auth)
	}
	if cap.passcode != "hunter2" {
		t.Errorf("X-Snapdoc-Passcode = %q, want hunter2", cap.passcode)
	}
	for _, want := range []string{"title=Checkout+flow", "ttl=7d", "filename=checkout+flow.mp4"} {
		if !strings.Contains(cap.query, want) {
			t.Errorf("query %q missing %q", cap.query, want)
		}
	}

	if a.Kind != "video" || a.FileURL == "" || a.VersionURL == "" || a.VersionFileURL == "" {
		t.Errorf("video url fields = %+v", a)
	}
	if a.PosterURL == nil || *a.PosterURL == "" || a.VersionPosterURL == nil || *a.VersionPosterURL == "" {
		t.Errorf("poster url fields = %+v", a)
	}
	if a.DurationMs != 12345 || a.Width != 1920 || a.Height != 1080 {
		t.Errorf("dimensions = %+v", a)
	}
	if a.VideoCodec != "h264" || a.AudioCodec == nil || *a.AudioCodec != "aac" {
		t.Errorf("codecs = %+v", a)
	}
}

func TestPublishVideoOmitsEmptyParams(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 201, videoArtifactJSON, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	payload := []byte("x")
	if _, err := c.PublishVideo(bytes.NewReader(payload), VideoPublishOptions{Size: int64(len(payload))}); err != nil {
		t.Fatal(err)
	}
	if cap.query != "" {
		t.Errorf("query = %q, want empty", cap.query)
	}
	if cap.passcode != "" {
		t.Errorf("X-Snapdoc-Passcode = %q, want empty", cap.passcode)
	}
}

func TestPublishVideoDoesNotBufferBody(t *testing.T) {
	payload := []byte("streamed-mp4-bytes-must-not-be-buffered")
	spy := &spyReader{r: bytes.NewReader(payload)}

	var readsAtDispatch int
	var gotContentLength int64
	rt := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		// Captured the instant the transport is handed the request: if the
		// client had pre-drained the reader (e.g. by reusing the multipart
		// path's io.Copy-into-bytes.Buffer trick), spy.read would already
		// equal len(payload) here instead of 0.
		readsAtDispatch = spy.read
		gotContentLength = req.ContentLength
		b, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		if string(b) != string(payload) {
			t.Errorf("transport saw body %q, want %q", b, payload)
		}
		return &http.Response{
			StatusCode: 201,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(videoArtifactJSON)),
		}, nil
	})

	c := &Client{BaseURL: "http://video.invalid", Token: "t", HTTP: &http.Client{Transport: rt}}
	if _, err := c.PublishVideo(spy, VideoPublishOptions{Size: int64(len(payload))}); err != nil {
		t.Fatalf("PublishVideo() error = %v", err)
	}

	if readsAtDispatch != 0 {
		t.Errorf("reader had %d/%d bytes already read when dispatched to the transport, want 0 (body must stream, not buffer)", readsAtDispatch, len(payload))
	}
	if gotContentLength != int64(len(payload)) {
		t.Errorf("req.ContentLength = %d, want %d", gotContentLength, len(payload))
	}
}

func TestPublishVideoVersion(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 201, videoArtifactJSON, nil)
	defer srv.Close()

	payload := []byte("more-mp4-bytes-for-a-new-version")
	c := &Client{BaseURL: srv.URL, Token: "t"}
	if _, err := c.PublishVideoVersion("v7Kp9qWm2AbCdE", bytes.NewReader(payload), VideoPublishOptions{TTL: "12h", Size: int64(len(payload))}); err != nil {
		t.Fatal(err)
	}
	if cap.method != "POST" || cap.path != "/v1/artifacts/v7Kp9qWm2AbCdE/versions" {
		t.Errorf("request = %s %s, want POST /v1/artifacts/v7Kp9qWm2AbCdE/versions", cap.method, cap.path)
	}
	if cap.ctype != "video/mp4" {
		t.Errorf("Content-Type = %q, want video/mp4", cap.ctype)
	}
	if cap.query != "ttl=12h" {
		t.Errorf("query = %q, want ttl=12h", cap.query)
	}
	if cap.contentLength != int64(len(payload)) {
		t.Errorf("Content-Length = %d, want %d", cap.contentLength, len(payload))
	}
	if cap.body != string(payload) {
		t.Errorf("body = %q, want %q", cap.body, payload)
	}
}

func TestUploadVideoPoster(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 200, videoVersionJSON, nil)
	defer srv.Close()

	payload := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46}
	c := &Client{BaseURL: srv.URL, Token: "t"}
	v, err := c.UploadVideoPoster("v7Kp9qWm2AbCdE", 2, bytes.NewReader(payload), "image/jpeg", int64(len(payload)))
	if err != nil {
		t.Fatalf("UploadVideoPoster() error = %v", err)
	}

	if cap.method != "PUT" || cap.path != "/v1/artifacts/v7Kp9qWm2AbCdE/versions/2/poster" {
		t.Errorf("request = %s %s, want PUT /v1/artifacts/v7Kp9qWm2AbCdE/versions/2/poster", cap.method, cap.path)
	}
	if cap.ctype != "image/jpeg" {
		t.Errorf("Content-Type = %q, want image/jpeg", cap.ctype)
	}
	if cap.contentLength != int64(len(payload)) {
		t.Errorf("Content-Length = %d, want %d", cap.contentLength, len(payload))
	}
	if cap.body != string(payload) {
		t.Errorf("body mismatch: got %q want %q", cap.body, payload)
	}

	if v.Kind != "video" || v.Version != 2 || v.VersionURL == "" || v.VersionFileURL == "" {
		t.Errorf("version fields = %+v", v)
	}
	if v.VersionPosterURL != nil {
		t.Errorf("VersionPosterURL = %v, want nil (server sent null)", *v.VersionPosterURL)
	}
	if v.AudioCodec != nil {
		t.Errorf("AudioCodec = %v, want nil (server sent null)", *v.AudioCodec)
	}
	if v.DurationMs != 20000 || v.Width != 1280 || v.Height != 720 || v.VideoCodec != "vp9" {
		t.Errorf("media fields = %+v", v)
	}
}

func TestUploadVideoPosterDoesNotBufferBody(t *testing.T) {
	payload := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46}
	spy := &spyReader{r: bytes.NewReader(payload)}

	var readsAtDispatch int
	var gotContentLength int64
	rt := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		readsAtDispatch = spy.read
		gotContentLength = req.ContentLength
		b, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(b, payload) {
			t.Errorf("transport saw body %x, want %x", b, payload)
		}
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(videoVersionJSON)),
		}, nil
	})

	c := &Client{BaseURL: "http://video.invalid", Token: "t", HTTP: &http.Client{Transport: rt}}
	if _, err := c.UploadVideoPoster("v7Kp9qWm2AbCdE", 2, spy, "image/jpeg", int64(len(payload))); err != nil {
		t.Fatalf("UploadVideoPoster() error = %v", err)
	}

	if readsAtDispatch != 0 {
		t.Errorf("reader had %d/%d bytes already read when dispatched to the transport, want 0 (body must stream, not buffer)", readsAtDispatch, len(payload))
	}
	if gotContentLength != int64(len(payload)) {
		t.Errorf("req.ContentLength = %d, want %d", gotContentLength, len(payload))
	}
}

func TestList(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 200, `{"artifacts":[`+artifactJSON+`],"next_cursor":"abc123"}`, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	res, err := c.List(ListOptions{Status: "active", Cursor: "prev"})
	if err != nil {
		t.Fatal(err)
	}
	if cap.method != "GET" || cap.path != "/v1/artifacts" {
		t.Errorf("request = %s %s, want GET /v1/artifacts", cap.method, cap.path)
	}
	for _, want := range []string{"status=active", "cursor=prev"} {
		if !strings.Contains(cap.query, want) {
			t.Errorf("query %q missing %q", cap.query, want)
		}
	}
	if len(res.Artifacts) != 1 || res.Artifacts[0].ID != "x7Kp9qWm2AbCdE" {
		t.Errorf("artifacts = %+v", res.Artifacts)
	}
	if res.NextCursor != "abc123" {
		t.Errorf("next_cursor = %q, want abc123", res.NextCursor)
	}
}

func TestListNullCursor(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 200, `{"artifacts":[],"next_cursor":null}`, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	res, err := c.List(ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if cap.query != "" {
		t.Errorf("query = %q, want empty", cap.query)
	}
	if res.NextCursor != "" {
		t.Errorf("next_cursor = %q, want empty", res.NextCursor)
	}
}

func TestGet(t *testing.T) {
	var cap capture
	body := `{"artifact":` + artifactJSON + `,"versions":[{"version":1,"size_bytes":31022,"content_type":"text/html","created_at":"2026-06-12T15:04:05Z"}],` +
		`"assets":[{"hash":"abc123","content_type":"image/png","size_bytes":2048,"url":"https://snapdoc.carraes.dev/x7Kp9qWm2AbCdE/a/abc123","created_at":"2026-06-12T15:04:05Z"}]}`
	srv := contractServer(t, &cap, 200, body, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	res, err := c.Get("x7Kp9qWm2AbCdE")
	if err != nil {
		t.Fatal(err)
	}
	if cap.method != "GET" || cap.path != "/v1/artifacts/x7Kp9qWm2AbCdE" {
		t.Errorf("request = %s %s", cap.method, cap.path)
	}
	if res.Artifact.ID != "x7Kp9qWm2AbCdE" || len(res.Versions) != 1 || res.Versions[0].Version != 1 {
		t.Errorf("get = %+v", res)
	}
	if len(res.Assets) != 1 || res.Assets[0].Hash != "abc123" || res.Assets[0].ContentType != "image/png" {
		t.Errorf("assets = %+v", res.Assets)
	}
}

func TestDelete(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 200, `{"id":"x7Kp9qWm2AbCdE","status":"deleted"}`, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	res, err := c.Delete("x7Kp9qWm2AbCdE")
	if err != nil {
		t.Fatal(err)
	}
	if cap.method != "DELETE" || cap.path != "/v1/artifacts/x7Kp9qWm2AbCdE" {
		t.Errorf("request = %s %s", cap.method, cap.path)
	}
	if res.ID != "x7Kp9qWm2AbCdE" || res.Status != "deleted" {
		t.Errorf("delete = %+v", res)
	}
}

func TestExpire(t *testing.T) {
	var cap capture
	expired := strings.Replace(artifactJSON, `"active"`, `"expired"`, 1)
	srv := contractServer(t, &cap, 200, expired, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	a, err := c.Expire("x7Kp9qWm2AbCdE")
	if err != nil {
		t.Fatal(err)
	}
	if cap.method != "POST" || cap.path != "/v1/artifacts/x7Kp9qWm2AbCdE/expire" {
		t.Errorf("request = %s %s", cap.method, cap.path)
	}
	if a.Status != "expired" {
		t.Errorf("status = %q, want expired", a.Status)
	}
}

func TestCreateToken(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 201, `{"id":"tok_1","name":"ci-bot","token":"sd_live_secret","created_at":"2026-06-12T15:04:05Z"}`, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "bootstrap-secret"}
	tok, err := c.CreateToken("ci-bot", false)
	if err != nil {
		t.Fatal(err)
	}
	if cap.method != "POST" || cap.path != "/v1/admin/tokens" {
		t.Errorf("request = %s %s", cap.method, cap.path)
	}
	if cap.auth != "Bearer bootstrap-secret" {
		t.Errorf("Authorization = %q", cap.auth)
	}
	if cap.ctype != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", cap.ctype)
	}
	var sent map[string]string
	if err := json.Unmarshal([]byte(cap.body), &sent); err != nil || sent["name"] != "ci-bot" {
		t.Errorf("body = %q, want {\"name\":\"ci-bot\"}", cap.body)
	}
	if tok.ID != "tok_1" || tok.Token != "sd_live_secret" {
		t.Errorf("token = %+v", tok)
	}
}

func TestListTokens(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 200, `{"tokens":[{"id":"tok_1","name":"ci-bot","created_at":"2026-06-12T15:04:05Z","last_used_at":null,"revoked_at":null}]}`, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	res, err := c.ListTokens()
	if err != nil {
		t.Fatal(err)
	}
	if cap.method != "GET" || cap.path != "/v1/admin/tokens" {
		t.Errorf("request = %s %s", cap.method, cap.path)
	}
	if len(res) != 1 || res[0].ID != "tok_1" || res[0].LastUsedAt != "" {
		t.Errorf("tokens = %+v", res)
	}
}

func TestRevokeToken(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 200, `{"id":"tok_1","revoked_at":"2026-06-12T16:00:00Z"}`, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	res, err := c.RevokeToken("tok_1")
	if err != nil {
		t.Fatal(err)
	}
	if cap.method != "DELETE" || cap.path != "/v1/admin/tokens/tok_1" {
		t.Errorf("request = %s %s", cap.method, cap.path)
	}
	if res.ID != "tok_1" || res.RevokedAt != "2026-06-12T16:00:00Z" {
		t.Errorf("revoke = %+v", res)
	}
}

func TestErrorEnvelope(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		code      string
		message   string
		header    map[string]string
		wantRetry string
		wantInErr []string
	}{
		{name: "invalid_request", status: 400, code: "invalid_request", message: "Malformed body.", wantInErr: []string{"invalid_request", "Malformed body."}},
		{name: "invalid_ttl", status: 400, code: "invalid_ttl", message: "TTL outside 1h-90d bounds.", wantInErr: []string{"invalid_ttl"}},
		{name: "unsupported_content_type", status: 400, code: "unsupported_content_type", message: "Not text/html or text/markdown.", wantInErr: []string{"unsupported_content_type"}},
		{name: "unauthorized", status: 401, code: "unauthorized", message: "Invalid token.", wantInErr: []string{"unauthorized", "Invalid token."}},
		{name: "not_found", status: 404, code: "not_found", message: "Unknown artifact.", wantInErr: []string{"not_found"}},
		{name: "not_active", status: 409, code: "not_active", message: "Artifact deleted.", wantInErr: []string{"not_active"}},
		{name: "too_large", status: 413, code: "too_large", message: "Artifact exceeds the 2 MB size limit.", wantInErr: []string{"too_large"}},
		{name: "rate_limited has retry-after", status: 429, code: "rate_limited", message: "Over 100 publishes/hr.", header: map[string]string{"Retry-After": "120"}, wantRetry: "120", wantInErr: []string{"rate_limited", "120"}},
		{name: "internal", status: 500, code: "internal", message: "Unexpected server error.", wantInErr: []string{"internal"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cap capture
			body := `{"error":{"code":"` + tt.code + `","message":"` + tt.message + `"}}`
			srv := contractServer(t, &cap, tt.status, body, tt.header)
			defer srv.Close()

			c := &Client{BaseURL: srv.URL, Token: "t"}
			_, err := c.Publish(strings.NewReader("x"), "text/html", PublishOptions{})
			if err == nil {
				t.Fatal("want error, got nil")
			}
			var apiErr *Error
			if !errors.As(err, &apiErr) {
				t.Fatalf("error type = %T, want *api.Error", err)
			}
			if apiErr.Code != tt.code {
				t.Errorf("Code = %q, want %q", apiErr.Code, tt.code)
			}
			if apiErr.Message != tt.message {
				t.Errorf("Message = %q, want %q", apiErr.Message, tt.message)
			}
			if apiErr.Status != tt.status {
				t.Errorf("Status = %d, want %d", apiErr.Status, tt.status)
			}
			if apiErr.RetryAfter != tt.wantRetry {
				t.Errorf("RetryAfter = %q, want %q", apiErr.RetryAfter, tt.wantRetry)
			}
			for _, want := range tt.wantInErr {
				if !strings.Contains(apiErr.Error(), want) {
					t.Errorf("Error() = %q missing %q", apiErr.Error(), want)
				}
			}
		})
	}
}

func TestErrorNonEnvelopeBody(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 502, "Bad Gateway", nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "t"}
	_, err := c.Get("x")
	var apiErr *Error
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type = %T, want *api.Error", err)
	}
	if apiErr.Status != 502 || apiErr.Code == "" {
		t.Errorf("err = %+v, want status 502 and non-empty code", apiErr)
	}
}

func TestNoAuthHeaderWhenTokenEmpty(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 200, `{"artifacts":[],"next_cursor":null}`, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL}
	if _, err := c.List(ListOptions{}); err != nil {
		t.Fatal(err)
	}
	if cap.auth != "" {
		t.Errorf("Authorization = %q, want empty", cap.auth)
	}
}

// Bootstrap minting must NOT use /v1/admin/* — Cloudflare Access intercepts
// that prefix at the edge, so headless bootstrap goes through /v1/tokens.
func TestCreateTokenBootstrapPath(t *testing.T) {
	var cap capture
	srv := contractServer(t, &cap, 201, `{"id":"tok_1","name":"ci-bot","token":"sd_live_secret","created_at":"2026-06-12T15:04:05Z"}`, nil)
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "bootstrap-secret"}
	if _, err := c.CreateToken("ci-bot", true); err != nil {
		t.Fatal(err)
	}
	if cap.method != "POST" || cap.path != "/v1/tokens" {
		t.Errorf("request = %s %s, want POST /v1/tokens", cap.method, cap.path)
	}
	if cap.auth != "Bearer bootstrap-secret" {
		t.Errorf("Authorization = %q", cap.auth)
	}
}

func TestPublishMultipart(t *testing.T) {
	dir := t.TempDir()
	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	if err := os.WriteFile(filepath.Join(dir, "diagram.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}

	var docType, docBody string
	var dispositions []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mr, err := r.MultipartReader()
		if err != nil {
			t.Errorf("MultipartReader: %v", err)
			return
		}
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Errorf("NextPart: %v", err)
				return
			}
			dispositions = append(dispositions, part.Header.Get("Content-Disposition"))
			if part.FormName() == "document" {
				docType = part.Header.Get("Content-Type")
				b, _ := io.ReadAll(part)
				docBody = string(b)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		io.WriteString(w, artifactJSON)
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, Token: "sd_live_abc"}
	a, err := c.PublishMultipart(
		strings.NewReader("# r\n\n![d](diagram.png)\n"),
		"text/markdown",
		[]AssetFile{
			{Ref: "diagram.png", Path: filepath.Join(dir, "diagram.png")},
			{Ref: "shots/a.png", Path: filepath.Join(dir, "a.png")},
		},
		PublishOptions{Title: "R"},
	)
	if err != nil {
		t.Fatalf("PublishMultipart() error = %v", err)
	}
	if a.ID != "x7Kp9qWm2AbCdE" {
		t.Errorf("artifact = %+v", a)
	}
	if docType != "text/markdown" {
		t.Errorf("document Content-Type = %q, want text/markdown", docType)
	}
	if !strings.Contains(docBody, "![d](diagram.png)") {
		t.Errorf("document body = %q", docBody)
	}
	joined := strings.Join(dispositions, "\n")
	for _, want := range []string{`name="document"`, `filename="diagram.png"`, `filename="shots/a.png"`} {
		if !strings.Contains(joined, want) {
			t.Errorf("dispositions %q missing %q", joined, want)
		}
	}
}

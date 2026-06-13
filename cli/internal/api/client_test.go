package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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

// capture records the last request the client sent.
type capture struct {
	method string
	path   string
	query  string
	auth   string
	ctype  string
	body   string
}

func contractServer(t *testing.T, cap *capture, status int, respBody string, header map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*cap = capture{
			method: r.Method,
			path:   r.URL.Path,
			query:  r.URL.RawQuery,
			auth:   r.Header.Get("Authorization"),
			ctype:  r.Header.Get("Content-Type"),
			body:   string(b),
		}
		for k, v := range header {
			w.Header().Set(k, v)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, respBody)
	}))
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
	body := `{"artifact":` + artifactJSON + `,"versions":[{"version":1,"size_bytes":31022,"content_type":"text/html","created_at":"2026-06-12T15:04:05Z"}]}`
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
		name       string
		status     int
		code       string
		message    string
		header     map[string]string
		wantRetry  string
		wantInErr  []string
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

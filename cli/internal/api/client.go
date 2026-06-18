// Package api is a thin HTTP client for the snapdoc API contract (API.md).
// It transports requests and decodes responses; all business rules live
// server-side.
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// Error is the decoded {"error":{"code","message"}} envelope plus transport
// details. Callers switch on Code, never on Message.
type Error struct {
	Status     int
	Code       string
	Message    string
	RetryAfter string // Retry-After header value (seconds), set on rate_limited
}

func (e *Error) Error() string {
	s := fmt.Sprintf("%s: %s", e.Code, e.Message)
	if e.RetryAfter != "" {
		s += fmt.Sprintf(" (retry after %s seconds)", e.RetryAfter)
	}
	return s
}

type Artifact struct {
	ID             string `json:"id"`
	URL            string `json:"url"`
	Title          string `json:"title"`
	Status         string `json:"status"`
	CurrentVersion int    `json:"current_version"`
	ContentType    string `json:"content_type"`
	SizeBytes      int64  `json:"size_bytes"`
	CreatedAt      string `json:"created_at"`
	ExpiresAt      string `json:"expires_at"`
	HasPasscode    bool   `json:"has_passcode"`
	TokenName      string `json:"token_name,omitempty"`
}

type Version struct {
	Version     int    `json:"version"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
	CreatedAt   string `json:"created_at"`
}

type PublishOptions struct {
	Title    string
	TTL      string
	Passcode string
}

type ListOptions struct {
	Status string
	Cursor string
}

type ListResult struct {
	Artifacts  []Artifact `json:"artifacts"`
	NextCursor string     `json:"next_cursor"`
}

type GetResult struct {
	Artifact Artifact  `json:"artifact"`
	Versions []Version `json:"versions"`
}

type DeleteResult struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type Comment struct {
	ID         string  `json:"id"`
	Author     string  `json:"author"`
	Version    int     `json:"version"`
	Body       string  `json:"body"`
	CreatedAt  string  `json:"created_at"`
	ParentID   *string `json:"parent_id"`
	Resolved   bool    `json:"resolved"`
	ResolvedAt *string `json:"resolved_at"`
	ResolvedBy *string `json:"resolved_by"`
}

type CommentsResult struct {
	ArtifactID string    `json:"artifact_id"`
	Comments   []Comment `json:"comments"`
	Truncated  bool      `json:"truncated"`
}

// Identity is the calling token's own metadata, returned by GET /v1/whoami.
type Identity struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

type WhoamiResult struct {
	Token Identity `json:"token"`
}

type TokenSecret struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Token     string `json:"token"`
	CreatedAt string `json:"created_at"`
}

type TokenInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CreatedAt  string `json:"created_at"`
	LastUsedAt string `json:"last_used_at"`
	RevokedAt  string `json:"revoked_at"`
}

type RevokeResult struct {
	ID        string `json:"id"`
	RevokedAt string `json:"revoked_at"`
}

func (c *Client) Publish(content io.Reader, contentType string, opts PublishOptions) (*Artifact, error) {
	return c.publish("/v1/artifacts", content, contentType, opts)
}

func (c *Client) PublishVersion(id string, content io.Reader, contentType string, opts PublishOptions) (*Artifact, error) {
	return c.publish("/v1/artifacts/"+url.PathEscape(id)+"/versions", content, contentType, opts)
}

func (c *Client) publish(path string, content io.Reader, contentType string, opts PublishOptions) (*Artifact, error) {
	q := url.Values{}
	if opts.Title != "" {
		q.Set("title", opts.Title)
	}
	if opts.TTL != "" {
		q.Set("ttl", opts.TTL)
	}
	var headers map[string]string
	if opts.Passcode != "" {
		// Header, not a query param: query strings get logged.
		headers = map[string]string{"X-Snapdoc-Passcode": opts.Passcode}
	}
	var a Artifact
	if err := c.doH("POST", path, q, content, contentType, headers, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

func (c *Client) List(opts ListOptions) (*ListResult, error) {
	q := url.Values{}
	if opts.Status != "" {
		q.Set("status", opts.Status)
	}
	if opts.Cursor != "" {
		q.Set("cursor", opts.Cursor)
	}
	var res ListResult
	if err := c.do("GET", "/v1/artifacts", q, nil, "", &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) Get(id string) (*GetResult, error) {
	var res GetResult
	if err := c.do("GET", "/v1/artifacts/"+url.PathEscape(id), nil, nil, "", &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// Whoami verifies the configured token and returns its identity. A successful
// call proves the token is valid; an invalid or revoked token surfaces as an
// *Error with code "unauthorized".
func (c *Client) Whoami() (*WhoamiResult, error) {
	var res WhoamiResult
	if err := c.do("GET", "/v1/whoami", nil, nil, "", &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) ListComments(id, status string) (*CommentsResult, error) {
	q := url.Values{}
	if status != "" {
		q.Set("status", status)
	}
	var res CommentsResult
	if err := c.do("GET", "/v1/artifacts/"+url.PathEscape(id)+"/comments", q, nil, "", &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) Delete(id string) (*DeleteResult, error) {
	var res DeleteResult
	if err := c.do("DELETE", "/v1/artifacts/"+url.PathEscape(id), nil, nil, "", &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) Expire(id string) (*Artifact, error) {
	var a Artifact
	if err := c.do("POST", "/v1/artifacts/"+url.PathEscape(id)+"/expire", nil, nil, "", &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// CreateToken mints a token via the admin API, or — when bootstrap is true —
// via POST /v1/tokens, which accepts only the bootstrap secret and is not
// behind Cloudflare Access (the /v1/admin/* prefix is gated at the edge).
func (c *Client) CreateToken(name string, bootstrap bool) (*TokenSecret, error) {
	body, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		return nil, err
	}
	path := "/v1/admin/tokens"
	if bootstrap {
		path = "/v1/tokens"
	}
	var res TokenSecret
	if err := c.do("POST", path, nil, bytes.NewReader(body), "application/json", &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) ListTokens() ([]TokenInfo, error) {
	var res struct {
		Tokens []TokenInfo `json:"tokens"`
	}
	if err := c.do("GET", "/v1/admin/tokens", nil, nil, "", &res); err != nil {
		return nil, err
	}
	return res.Tokens, nil
}

func (c *Client) RevokeToken(id string) (*RevokeResult, error) {
	var res RevokeResult
	if err := c.do("DELETE", "/v1/admin/tokens/"+url.PathEscape(id), nil, nil, "", &res); err != nil {
		return nil, err
	}
	return &res, nil
}

func (c *Client) do(method, path string, q url.Values, body io.Reader, contentType string, out any) error {
	return c.doH(method, path, q, body, contentType, nil, out)
}

func (c *Client) doH(method, path string, q url.Values, body io.Reader, contentType string, headers map[string]string, out any) error {
	u := strings.TrimRight(c.BaseURL, "/") + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequest(method, u, body)
	if err != nil {
		return err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return decodeError(resp, data)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

func decodeError(resp *http.Response, data []byte) error {
	apiErr := &Error{Status: resp.StatusCode}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err == nil && envelope.Error.Code != "" {
		apiErr.Code = envelope.Error.Code
		apiErr.Message = envelope.Error.Message
	} else {
		// Non-contract response (proxy, outage): synthesize a stable shape.
		apiErr.Code = "http_error"
		apiErr.Message = fmt.Sprintf("unexpected response (HTTP %d): %s", resp.StatusCode, truncate(string(data), 200))
	}
	if apiErr.Code == "rate_limited" {
		apiErr.RetryAfter = resp.Header.Get("Retry-After")
	}
	return apiErr
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return strings.TrimSpace(s)
}

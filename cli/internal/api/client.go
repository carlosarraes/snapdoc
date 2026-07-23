// Package api is a thin HTTP client for the snapdoc API contract (API.md).
// It transports requests and decodes responses; all business rules live
// server-side.
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"strconv"
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
	ID              string `json:"id"`
	URL             string `json:"url"`
	Title           string `json:"title"`
	Status          string `json:"status"`
	CurrentVersion  int    `json:"current_version"`
	ContentType     string `json:"content_type"`
	SizeBytes       int64  `json:"size_bytes"`
	CreatedAt       string `json:"created_at"`
	ExpiresAt       string `json:"expires_at"`
	HasPasscode     bool   `json:"has_passcode"`
	CommentsEnabled bool   `json:"comments_enabled"`
	TokenName       string `json:"token_name,omitempty"`
	// UnresolvedRefs is set on a multipart publish: local image refs the server
	// could not match to an uploaded file (left as-is in the document).
	UnresolvedRefs []string `json:"unresolved_refs,omitempty"`
	// Video-only fields, additive: present when Kind == "video".
	Kind             string  `json:"kind,omitempty"`
	FileURL          string  `json:"file_url,omitempty"`
	VersionURL       string  `json:"version_url,omitempty"`
	VersionFileURL   string  `json:"version_file_url,omitempty"`
	PosterURL        *string `json:"poster_url,omitempty"`
	VersionPosterURL *string `json:"version_poster_url,omitempty"`
	DurationMs       int64   `json:"duration_ms,omitempty"`
	Width            int     `json:"width,omitempty"`
	Height           int     `json:"height,omitempty"`
	VideoCodec       string  `json:"video_codec,omitempty"`
	AudioCodec       *string `json:"audio_codec,omitempty"`
}

type Asset struct {
	Hash        string `json:"hash"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	URL         string `json:"url"`
	CreatedAt   string `json:"created_at"`
}

type Version struct {
	Version     int    `json:"version"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
	CreatedAt   string `json:"created_at"`
	// Video-only fields, additive: present when Kind == "video". Mirrors
	// versionJson in worker/src/http.ts (a narrower set than Artifact's,
	// since a version has no top-level url/file_url of its own).
	Kind             string  `json:"kind,omitempty"`
	VersionURL       string  `json:"version_url,omitempty"`
	VersionFileURL   string  `json:"version_file_url,omitempty"`
	VersionPosterURL *string `json:"version_poster_url,omitempty"`
	DurationMs       int64   `json:"duration_ms,omitempty"`
	Width            int     `json:"width,omitempty"`
	Height           int     `json:"height,omitempty"`
	VideoCodec       string  `json:"video_codec,omitempty"`
	AudioCodec       *string `json:"audio_codec,omitempty"`
}

type PublishOptions struct {
	Title    string
	TTL      string
	Passcode string
	Comments bool
}

// VideoPublishOptions configures a raw MP4 publish/version request. Size is
// the exact byte length of body and is sent as Content-Length; unlike
// document publishes, video uploads always declare their length up front so
// the server can stream straight to storage.
type VideoPublishOptions struct {
	Title, TTL, Passcode, Filename string
	Size                           int64
}

// AssetFile is a local image to upload alongside a document. Ref is the verbatim
// reference string from the document (sent as the multipart filename so the
// server can match and rewrite it); Path is the local file to read.
type AssetFile struct {
	Ref  string
	Path string
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
	Assets   []Asset   `json:"assets,omitempty"`
}

type DeleteResult struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// Anchor locates a reader comment's highlighted span within the document.
type Anchor struct {
	Exact  string `json:"exact"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
	Start  int    `json:"start"`
	End    int    `json:"end"`
}

type Comment struct {
	ID         string  `json:"id"`
	Author     string  `json:"author"`
	AuthorKind string  `json:"author_kind"`
	Version    int     `json:"version"`
	Body       string  `json:"body"`
	CreatedAt  string  `json:"created_at"`
	ParentID   *string `json:"parent_id"`
	Resolved   bool    `json:"resolved"`
	ResolvedAt *string `json:"resolved_at"`
	ResolvedBy *string `json:"resolved_by"`
	// Set on reader (anon) comments: the unverified email and the text anchor.
	AuthorEmail *string `json:"author_email"`
	Anchor      *Anchor `json:"anchor"`
	// Set on anchored roots: true when the quoted text no longer appears in
	// the artifact's current version.
	Orphaned *bool `json:"orphaned,omitempty"`
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
	if opts.Comments {
		q.Set("comments", "1")
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

// PublishMultipart creates an artifact from a document plus its referenced
// images. The server uploads the images and rewrites the document's local
// <img> refs to hosted URLs.
func (c *Client) PublishMultipart(content io.Reader, contentType string, assets []AssetFile, opts PublishOptions) (*Artifact, error) {
	return c.publishMultipart("/v1/artifacts", content, contentType, assets, opts)
}

func (c *Client) PublishVersionMultipart(id string, content io.Reader, contentType string, assets []AssetFile, opts PublishOptions) (*Artifact, error) {
	return c.publishMultipart("/v1/artifacts/"+url.PathEscape(id)+"/versions", content, contentType, assets, opts)
}

func (c *Client) publishMultipart(path string, content io.Reader, contentType string, assets []AssetFile, opts PublishOptions) (*Artifact, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	// The document part carries its own Content-Type so the server knows whether
	// to render markdown; image parts are sniffed server-side, so their declared
	// type does not matter (the part filename is the ref the server matches).
	docHeader := textproto.MIMEHeader{}
	docHeader.Set("Content-Disposition", `form-data; name="document"; filename="document"`)
	docHeader.Set("Content-Type", contentType)
	docPart, err := mw.CreatePart(docHeader)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(docPart, content); err != nil {
		return nil, err
	}

	for _, a := range assets {
		f, err := os.Open(a.Path)
		if err != nil {
			return nil, err
		}
		part, err := mw.CreateFormFile("image", a.Ref)
		if err != nil {
			f.Close()
			return nil, err
		}
		if _, err := io.Copy(part, f); err != nil {
			f.Close()
			return nil, err
		}
		f.Close()
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}

	q := url.Values{}
	if opts.Title != "" {
		q.Set("title", opts.Title)
	}
	if opts.TTL != "" {
		q.Set("ttl", opts.TTL)
	}
	if opts.Comments {
		q.Set("comments", "1")
	}
	var headers map[string]string
	if opts.Passcode != "" {
		headers = map[string]string{"X-Snapdoc-Passcode": opts.Passcode}
	}
	var a Artifact
	if err := c.doH("POST", path, q, &buf, mw.FormDataContentType(), headers, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// PublishVideo creates a video artifact from a raw, streamed MP4 body. body
// is passed straight through to the transport (never buffered); opts.Size
// must be the exact byte length, sent as Content-Length.
func (c *Client) PublishVideo(body io.Reader, opts VideoPublishOptions) (*Artifact, error) {
	return c.publishVideo("/v1/artifacts", body, opts)
}

func (c *Client) PublishVideoVersion(id string, body io.Reader, opts VideoPublishOptions) (*Artifact, error) {
	return c.publishVideo("/v1/artifacts/"+url.PathEscape(id)+"/versions", body, opts)
}

func (c *Client) publishVideo(path string, body io.Reader, opts VideoPublishOptions) (*Artifact, error) {
	q := url.Values{}
	if opts.Title != "" {
		q.Set("title", opts.Title)
	}
	if opts.TTL != "" {
		q.Set("ttl", opts.TTL)
	}
	if opts.Filename != "" {
		q.Set("filename", opts.Filename)
	}
	var headers map[string]string
	if opts.Passcode != "" {
		headers = map[string]string{"X-Snapdoc-Passcode": opts.Passcode}
	}
	var a Artifact
	if err := c.doStream("POST", path, q, body, "video/mp4", opts.Size, headers, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// UploadVideoPoster replaces a video version's poster/thumbnail image. body
// is streamed with an explicit Content-Length, never buffered client-side;
// contentType must be image/jpeg or image/png (server-enforced).
func (c *Client) UploadVideoPoster(id string, version int, body io.Reader, contentType string, size int64) (*Version, error) {
	path := "/v1/artifacts/" + url.PathEscape(id) + "/versions/" + strconv.Itoa(version) + "/poster"
	var v Version
	if err := c.doStream("PUT", path, nil, body, contentType, size, nil, &v); err != nil {
		return nil, err
	}
	return &v, nil
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

type ContentResult struct {
	ID          string `json:"id"`
	Version     int    `json:"version"`
	Format      string `json:"format"`
	ContentType string `json:"content_type"`
	Content     string `json:"content"`
}

// ReadContent fetches an artifact's body. format is "md" (default) or "html";
// version <= 0 means the latest. A non-empty passcode travels in the
// X-Snapdoc-Passcode header (never a query param, which would be logged).
func (c *Client) ReadContent(id, format string, version int, passcode string) (*ContentResult, error) {
	q := url.Values{}
	if format != "" {
		q.Set("format", format)
	}
	if version > 0 {
		q.Set("version", strconv.Itoa(version))
	}
	var headers map[string]string
	if passcode != "" {
		headers = map[string]string{"X-Snapdoc-Passcode": passcode}
	}
	var res ContentResult
	if err := c.doH("GET", "/v1/artifacts/"+url.PathEscape(id)+"/content", q, nil, "", headers, &res); err != nil {
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

// SetCommentsEnabled toggles the anonymous reader-comment opt-in for an artifact.
func (c *Client) SetCommentsEnabled(id string, enabled bool) (*Artifact, error) {
	body, err := json.Marshal(map[string]bool{"enabled": enabled})
	if err != nil {
		return nil, err
	}
	var a Artifact
	if err := c.do("POST", "/v1/artifacts/"+url.PathEscape(id)+"/comment-settings", nil, bytes.NewReader(body), "application/json", &a); err != nil {
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
	req, err := c.newRequest(method, path, q, body, contentType, headers)
	if err != nil {
		return err
	}
	return c.send(req, out)
}

// doStream is the streaming variant used by raw video/image uploads: it sets
// req.ContentLength explicitly (a plain io.Reader carries no length Go can
// infer) and passes body straight to http.NewRequest, never copying it into
// a buffer first, so the transport streams it to the connection as read.
func (c *Client) doStream(method, path string, q url.Values, body io.Reader, contentType string, size int64, headers map[string]string, out any) error {
	req, err := c.newRequest(method, path, q, body, contentType, headers)
	if err != nil {
		return err
	}
	req.ContentLength = size
	return c.send(req, out)
}

func (c *Client) newRequest(method, path string, q url.Values, body io.Reader, contentType string, headers map[string]string) (*http.Request, error) {
	u := strings.TrimRight(c.BaseURL, "/") + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequest(method, u, body)
	if err != nil {
		return nil, err
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
	return req, nil
}

func (c *Client) send(req *http.Request, out any) error {
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

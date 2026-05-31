// Package mcp implements a minimal MCP HTTP/SSE client.
//
// MCP servers expose a single POST endpoint that accepts JSON-RPC payloads and
// responds either as plain JSON or as a Server-Sent Events stream
// (`text/event-stream`). Some servers (e.g. context7) also enforce a
// session-based handshake: an `initialize` request returns an `Mcp-Session-Id`
// header that must be echoed back on subsequent requests.
//
// This client supports both modes using only the standard library.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// Client is a minimal MCP JSON-RPC client over HTTP.
type Client struct {
	URL        string
	Headers    map[string]string
	HTTPClient *http.Client

	clientName    string
	clientVersion string

	sessionID string
	nextID    int64
}

// New creates a Client targeting the given MCP endpoint URL.
// Extra headers (e.g. API keys) are sent on every request.
func New(url string, headers map[string]string) *Client {
	return &Client{
		URL:           url,
		Headers:       headers,
		HTTPClient:    &http.Client{Timeout: 60 * time.Second},
		clientName:    "pi-skills",
		clientVersion: "0.1",
	}
}

func (c *Client) id() int64 {
	return atomic.AddInt64(&c.nextID, 1)
}

// rpcRequest is a JSON-RPC 2.0 request. Notifications omit ID.
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      *int64 `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// rpcResponse is a JSON-RPC 2.0 response envelope.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("mcp error %d: %s", e.Code, e.Message)
}

// post sends a JSON-RPC payload and returns the raw response body and headers.
// It does not parse SSE — that's the caller's job because notifications have
// no response body to parse.
func (c *Client) post(ctx context.Context, payload any) (*http.Response, []byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return nil, nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range c.Headers {
		req.Header.Set(k, v)
	}
	if c.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", c.sessionID)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, fmt.Errorf("read body: %w", err)
	}
	if resp.StatusCode >= 400 {
		return resp, raw, fmt.Errorf("mcp http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return resp, raw, nil
}

// decode parses a response body as either plain JSON or SSE-wrapped JSON.
// MCP servers may return `Content-Type: text/event-stream` with frames like:
//
//	event: message
//	data: {"jsonrpc":"2.0",...}
//
// We extract `data:` lines, concatenate them, and JSON-decode.
func decode(contentType string, body []byte) (*rpcResponse, error) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, errors.New("empty response body")
	}

	// Detect SSE either by Content-Type or by the `data:` prefix.
	isSSE := strings.Contains(contentType, "text/event-stream") ||
		bytes.HasPrefix(trimmed, []byte("event:")) ||
		bytes.HasPrefix(trimmed, []byte("data:"))

	var jsonBytes []byte
	if isSSE {
		var data strings.Builder
		scanner := bufio.NewScanner(bytes.NewReader(body))
		// SSE events can be larger than the default 64KB buffer.
		scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if rest, ok := strings.CutPrefix(line, "data:"); ok {
				data.WriteString(strings.TrimPrefix(rest, " "))
				data.WriteByte('\n')
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, fmt.Errorf("read sse: %w", err)
		}
		jsonBytes = []byte(strings.TrimSpace(data.String()))
	} else {
		jsonBytes = trimmed
	}

	if len(jsonBytes) == 0 {
		return nil, errors.New("no data frame in sse response")
	}
	var rpc rpcResponse
	if err := json.Unmarshal(jsonBytes, &rpc); err != nil {
		return nil, fmt.Errorf("decode json: %w (body=%q)", err, string(jsonBytes))
	}
	return &rpc, nil
}

// Initialize performs the full MCP handshake: `initialize` then
// `notifications/initialized`. The session ID returned by the server (if any)
// is captured and used for subsequent calls.
func (c *Client) Initialize(ctx context.Context) error {
	id := c.id()
	resp, body, err := c.post(ctx, rpcRequest{
		JSONRPC: "2.0",
		ID:      &id,
		Method:  "initialize",
		Params: map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{},
			"clientInfo": map[string]any{
				"name":    c.clientName,
				"version": c.clientVersion,
			},
		},
	})
	if err != nil {
		return err
	}
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		c.sessionID = sid
	}
	if _, err := decode(resp.Header.Get("Content-Type"), body); err != nil {
		return fmt.Errorf("initialize: %w", err)
	}
	return c.NotifyInitialized(ctx)
}

// NotifyInitialized sends the `notifications/initialized` notification. Some
// MCP servers (e.g. grep.app) require this even without a prior `initialize`.
func (c *Client) NotifyInitialized(ctx context.Context) error {
	_, _, err := c.post(ctx, rpcRequest{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
		Params:  map[string]any{},
	})
	// Notifications produce no useful body; ignore decode errors but surface
	// transport errors.
	return err
}

// ToolContent is one entry in a tool result's `content` array.
type ToolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// toolResult mirrors `result` of a tools/call response.
type toolResult struct {
	Content []ToolContent `json:"content"`
	IsError bool          `json:"isError"`
}

// CallTool invokes `tools/call` with the given tool name and arguments and
// returns the content array. If the server returns an error envelope it is
// surfaced as a Go error.
func (c *Client) CallTool(ctx context.Context, name string, arguments any) ([]ToolContent, error) {
	id := c.id()
	resp, body, err := c.post(ctx, rpcRequest{
		JSONRPC: "2.0",
		ID:      &id,
		Method:  "tools/call",
		Params: map[string]any{
			"name":      name,
			"arguments": arguments,
		},
	})
	if err != nil {
		return nil, err
	}
	rpc, err := decode(resp.Header.Get("Content-Type"), body)
	if err != nil {
		return nil, err
	}
	if rpc.Error != nil {
		return nil, rpc.Error
	}
	if len(rpc.Result) == 0 {
		return nil, errors.New("tools/call: empty result")
	}
	var tr toolResult
	if err := json.Unmarshal(rpc.Result, &tr); err != nil {
		return nil, fmt.Errorf("decode tool result: %w", err)
	}
	if tr.IsError {
		var msg strings.Builder
		for _, c := range tr.Content {
			msg.WriteString(c.Text)
		}
		return tr.Content, fmt.Errorf("tool error: %s", strings.TrimSpace(msg.String()))
	}
	return tr.Content, nil
}

// PrintTextContent writes the text content of a tool response to w, one entry
// per line. Non-text entries are skipped.
func PrintTextContent(w io.Writer, content []ToolContent) {
	for _, c := range content {
		if c.Type == "text" {
			fmt.Fprintln(w, c.Text)
		}
	}
}

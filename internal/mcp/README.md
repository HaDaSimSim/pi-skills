# internal/mcp

The only shared Go code in the repo: a minimal MCP (Model Context Protocol)
client over HTTP/SSE, standard library only. Skills that wrap a remote MCP
server build on this; skills that wrap a local CLI or a plain REST endpoint do
not.

## What it provides

- `Client` (URL, Headers, HTTPClient, session/id state), created via
  `New(url, headers)`.
- JSON-RPC 2.0 envelope: `rpcRequest` (notifications omit the ID) and
  `rpcResponse` (result/error), with atomic incrementing request IDs.
- `post` — sets `Accept: application/json, text/event-stream`, applies custom
  headers, echoes `Mcp-Session-Id` when set, surfaces HTTP ≥400 as errors.
- `decode` — parses plain JSON **or** `text/event-stream`, detecting SSE by
  Content-Type or `event:`/`data:` prefix, concatenating `data:` lines (8MB
  scanner buffer) before unmarshaling.
- `Initialize` — sends `initialize` (protocol `2024-11-05`), captures the
  returned `Mcp-Session-Id` header, then calls `NotifyInitialized`.
- `NotifyInitialized` — sends `notifications/initialized` (some servers, e.g.
  grep.app, require it even without a prior `initialize`).
- `CallTool` — invokes `tools/call`, decodes the `content` array, surfaces both
  RPC errors and `isError` tool envelopes as Go errors.
- `PrintTextContent` — writes each `text`-type content entry to a writer, one
  per line, skipping non-text.

## Who uses it

- `context7` — **session-based**: full `Initialize` handshake (captures
  `Mcp-Session-Id`).
- `grep-search` — **sessionless**: `NotifyInitialized` only, `mcp.New(endpoint,
  nil)`.

Not used by `ast-grep` (local CLI via `os/exec`) or `update-models` (plain
`net/http` REST).

See [`AGENTS.md`](AGENTS.md) for the rules that keep this package usable by both
session styles.

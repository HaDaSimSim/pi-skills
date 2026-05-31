# internal/mcp — agent contract

Rules for editing the shared MCP client. Two skills depend on it with different
session styles; keep both working.

## Hard rules

- **stdlib only.** No external Go modules — this package is imported by skills
  that must stay dependency-free.
- **Support both session styles.** `context7` is session-based (`Initialize`
  captures `Mcp-Session-Id`); `grep-search` is sessionless (`NotifyInitialized`
  only). Don't make the session id mandatory, and don't break the
  notify-without-initialize path.
- **Accept both response encodings.** `decode` must keep handling plain JSON
  *and* `text/event-stream`. SSE is detected by Content-Type or an
  `event:`/`data:` prefix; `data:` lines are concatenated before unmarshaling.
  Keep the large scanner buffer (8MB) — some doc payloads are big.
- **Surface errors honestly.** HTTP ≥400, JSON-RPC `error`, and tool-level
  `isError` envelopes must all turn into Go errors so the calling skill can
  exit non-zero.
- **Keep request IDs atomic** (notifications omit the ID).

## Output discipline

`PrintTextContent` writes only `text`-type content, one entry per line, to the
passed writer. Skills call it with `os.Stdout`. Anything diagnostic belongs on
`stderr` in the skill, not here.

## Protocol version

`Initialize` pins protocol `2024-11-05`. Bump deliberately and only after
checking both servers (Context7, grep.app) accept the new version.

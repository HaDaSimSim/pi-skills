# Skills — agent contract

Authoring rules for the Go skill binaries in this directory. Read this before
adding or editing a skill.

## SKILL.md = contract with pi

- pi reads `SKILL.md` to determine a skill's arg shape and purpose. It is a
  document for the agent, not for humans.
- Frontmatter (`name`, `description`) is **required** — pi uses it to build its
  skill registry, and the `description` is what makes the model decide whether
  to load the skill.
- CLI examples in the Usage section must exactly match the invocation form pi
  will use. If the binary's flags drift, fix `SKILL.md` in the same change.

## Build rules

- Go 1.26+, **standard library only** — no external Go modules in skills or in
  `internal/`.
- Tool output → **stdout only**. Diagnostics, progress, and errors → **stderr**.
  Mixing them breaks pi's output parsing.
- When shelling out to a local CLI, propagate the child's exit code so pi sees
  real success/failure.

## Transports — pick one

1. **Remote MCP server** → use the `internal/mcp` client. Build a `mcp.Client`,
   call `Initialize` (session-based) or just `NotifyInitialized` (sessionless),
   then `CallTool`, and print results via `mcp.PrintTextContent(os.Stdout, ...)`.
   See [`../internal/mcp/AGENTS.md`](../internal/mcp/AGENTS.md).
2. **Plain REST endpoint** → use `net/http` directly. `update-models` is the
   worked example: it GETs Relay's OpenCode config endpoint and translates the
   response into pi's `models.json` shape.
3. **Local CLI wrapper** → use `os/exec`, forward stdio, propagate the exit
   code. `ast-grep` is the example (maps curated flags onto `ast-grep run`).

## API key pattern

If a skill needs a key, follow the canonical `lookupAPIKey` shape used in
`context7`, `update-models`, and `websearch`: **env var first, `.env` next to
the resolved-symlink binary as fallback**. `.env` path resolution follows
symlinks via `EvalSymlinks` to find the real install directory. `chmod 600`
the file, never commit it.

## Per-skill notes

- `ast-grep` — not MCP. Shells out to `ast-grep` (preferred) or `sg` via
  `findAstGrep`; maps flags onto `ast-grep run -p/-r -l --color never
  --heading always`, `-C` for context, `-U` for `--apply`.
- `context7` — session-based MCP (`Mcp-Session-Id` handshake via `Initialize`).
  Two tool calls: `resolve-library-id` then `query-docs`. Key also passed as an
  MCP header. The legacy token-budget arg is intentionally ignored.
- `grep-search` — sessionless MCP (`NotifyInitialized` only) against
  `https://mcp.grep.app`; calls the `searchGitHub` tool.
- `update-models` — plain REST, no MCP, no SDK. `parseOpenCodeRelay` /
  `translateModel` convert the OpenCode shape (snake_case cost, models keyed by
  id, variant-based reasoning) into pi's (camelCase, ordered model array,
  `thinkingLevelMap`). `decodeOrderedModels` streams with a `json.Decoder` to
  preserve server model order. Variant sniff: `max` → Claude map, `xhigh` → GPT
  map, else no reasoning. `mergeRelay` swaps only the relay provider, leaving
  others intact. The written API-key value is the literal `$PI_RELAY_API_KEY` —
  pi resolves it at request time, so the user still needs the export in their
  shell rc.
- `websearch` — plain REST against `<base>/search?format=json`. `buildURL`
  maps flags to SearXNG params (`language`, `time_range`, `categories`,
  `engines`, `pageno`, `safesearch`). If decoding fails it hints to enable
  `search.formats: [json]` on the instance.

## Adding a skill

1. `mkdir skills/<name>`, add `main.go` + `SKILL.md`.
2. Pick a transport from the list above.
3. `SKILL.md` frontmatter must include `name` and `description`.
4. Append `<name>` to `ALL_SKILLS` in the root `Makefile`.
5. If a key is needed, follow the `.env` pattern above.
6. `make install` — the toggle reconciler appends the new name to
   `skills.local.json` under `skills` as `true`.

## Gotchas

- `make install` **preserves** sibling files (`.env`, etc.) in skill install
  dirs for enabled entries — never `rm -rf` an install dir by hand. For
  *disabled* entries the install dir is removed wholesale on the next install,
  including any `.env`. Back up the `.env` before toggling a skill off.

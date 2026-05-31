# pi-skills

Single-repo home for the [pi](https://github.com/earendil-works/pi) coding-agent
extras I run on every machine: a handful of Go skill binaries plus
TypeScript extensions, all installed into `~/.pi/agent/` by one `Makefile`.

Skills end up at `~/.pi/agent/skills/<name>/` (a `SKILL.md` + a single Go
binary, copied) and extensions are **symlinked** into
`~/.pi/agent/extensions/<name>{,.ts}` (pi follows the link and runs the TS
source directly). pi discovers both automatically — there is no MCP server,
no daemon, no runtime dependency beyond the skill binaries themselves.

## Skills

| Skill | What it does |
|---|---|
| `ast-grep` | Structural code search and rewrite via the local `ast-grep` CLI. |
| `context7` | Library documentation lookup via the Context7 MCP server. |
| `grep-search` | Source-code search across public GitHub repos via grep.app. |
| `update-models` | Sync the Relay (`sk-relay-...`) provider into `~/.pi/agent/models.json` via the OpenCode integration endpoint. |

`context7` and `grep-search` talk to remote MCP servers under the hood
(HTTP + SSE). `ast-grep` shells out to the local `ast-grep` binary.
`update-models` calls Relay's OpenCode integration endpoint
(`/integration/opencode/config`) and translates the response into pi's
`models.json` shape — Relay does not ship a pi-specific endpoint, so the
skill reuses the OpenCode one and converts variant-style reasoning controls
into pi's `thinkingLevelMap` form.

## Extensions

| Extension | What it does |
|---|---|
| `session-lock` | Exclusive advisory lock per session file. pi(TUI/CLI) claims a lock on `session_start` and re-checks ownership before every prompt/tool call, so the same session can't be written from two places at once. Shares its lock protocol (`shared/session-lock.ts`) with the `pi-web` backend. Adds `/takeover` to force-claim a session (demoting the other side to read-only). |

Drop a `<name>.ts` (single file) or `<name>/` (directory with `index.ts` /
`package.json`) into `extensions/`, append the name to `ALL_EXTENSIONS` in
the `Makefile`, and `make install` **symlinks** it into
`~/.pi/agent/extensions/`. Because it's a symlink (not a copy), edits in this
repo take effect on the next `/reload` — no re-install needed. See
[`extensions/README.md`](extensions/README.md) for the layout details.

## Build & install

Requires Go 1.22+. `ast-grep` also needs the [`ast-grep` CLI](https://ast-grep.github.io)
on `PATH` (`brew install ast-grep`). `make install` shells out to `python3`
(stdlib only) for the per-machine toggle file.

```bash
make build      # -> bin/<skill> for every enabled skill
make install    # copy SKILL.md + binary into ~/.pi/agent/skills/<name>/
                # and symlink extensions into ~/.pi/agent/extensions/<name>
                # also seeds/updates skills.local.json (see below)
make uninstall  # remove SKILL.md + binary + extension links, preserve .env / node_modules
make status     # show enabled/disabled skills + extensions
make clean
```

The Go skill binaries are self-contained, so a skill keeps working if the
repo moves. Extensions are different: they are **symlinked**, so the repo
must stay put — move or delete it and the link dangles. Re-run `make install`
to pick up new entries (existing extension edits need only `/reload`).

`install` leaves any sibling files in install dirs (`.env`, `node_modules/`,
etc.) alone unless an entry is disabled.

Override the install roots:

```bash
make install SKILLS_DIR=/some/other/skills EXTENSIONS_DIR=/some/other/extensions
```

## Toggling things per-machine

`skills.local.json` (next to the Makefile, gitignored) holds a per-machine
enable/disable map split by category:

```json
{
  "skills": {
    "ast-grep": true,
    "context7": true,
    "grep-search": true,
    "update-models": true
  },
  "extensions": {
    "my-extension": false
  }
}
```

`make install` reconciles this file on every run via
[`scripts/local-config.py`](scripts/local-config.py):

- **missing file** → created with every known name set to `true`
- **missing entries** → appended as `true` under the right category, in
  insertion order
- **present entries** → left exactly as you wrote them (`false` toggles
  survive across installs)
- **legacy flat format** (`{ "ast-grep": false, ... }` from older versions)
  → auto-migrated to the nested layout. Names that no longer correspond to
  any tracked skill or extension are dropped with a notice.
- **invalid JSON** → install fails hard

Names with `false` are skipped during build/install and any existing install
dir is removed on the next run, so toggling something off actually purges it
from pi's registries. `make status` shows the current state.

## Layout

```
pi-skills/
├── go.mod
├── Makefile
├── skills.local.json         # gitignored — per-machine enable/disable map
├── scripts/
│   └── local-config.py       # toggle file management (sync + disabled query)
├── internal/
│   └── mcp/
│       └── client.go         # MCP HTTP/SSE client (initialize, session id, tools/call)
├── extensions/               # TypeScript pi extensions (symlinked on install)
│   ├── README.md
│   └── session-lock/
│       ├── index.ts          # the extension entry point
│       └── shared/
│           └── session-lock.ts   # lock protocol (source of truth; pi-web links here)
└── skills/
    ├── ast-grep/
    │   ├── SKILL.md
    │   └── main.go
    ├── context7/
    │   ├── SKILL.md
    │   └── main.go
    ├── grep-search/
    │   ├── SKILL.md
    │   └── main.go
    └── update-models/
        ├── SKILL.md
        └── main.go
```

`internal/mcp` is the only shared Go code. It handles the JSON-RPC envelope,
the `Mcp-Session-Id` handshake, and parsing `text/event-stream` responses.
Used by `context7` (session-based) and `grep-search` (sessionless). Not
used by `ast-grep` (local CLI) or `update-models` (plain REST).

## Adding a new skill

1. `mkdir skills/<name>` and add `main.go` + `SKILL.md`.
2. For remote MCP servers, build a `mcp.Client`, call `Initialize` (or just
   `NotifyInitialized` if the server is sessionless), then `CallTool`. Print
   results with `mcp.PrintTextContent`. For local CLI wrappers, just shell
   out and forward stdio. For pure REST endpoints (like `update-models`),
   skip MCP entirely and just use `net/http`.
3. Append `<name>` to `ALL_SKILLS` in the `Makefile`.
4. `make install` — the helper script auto-adds the new name to
   `skills.local.json` under `skills` as `true`.

The binary's CLI shape is up to you — `SKILL.md` documents the arg shape pi
should use. Keep stdout clean (only the tool output) and write progress and
errors to stderr.

## Adding a new extension

1. Create `extensions/<name>.ts` or `extensions/<name>/index.ts`.
2. Append `<name>` to `ALL_EXTENSIONS` in the `Makefile`.
3. `make install` — the helper script auto-adds the new name to
   `skills.local.json` under `extensions` as `true`, and symlinks the
   extension into `~/.pi/agent/extensions/`.
4. `/reload` inside pi.

After the first `make install`, editing the extension in this repo needs
only `/reload` — the symlink means pi already sees your changes. Extensions
can declare `package.json` deps in their own subdirectory; install
`node_modules/` there and the symlinked directory exposes it as-is. A
self-contained extension keeps everything it imports inside its own
directory (e.g. `session-lock/shared/`), since the link points at that one
directory.

## Notes

- Standard library only on the Go side. No external Go modules.
- Built and tested for macOS arm64. Cross-compile with the usual
  `GOOS`/`GOARCH` env vars if you need other platforms.
- `context7` reads `CONTEXT7_API_KEY`, falling back to a `.env` next to the
  binary. `update-models` reads `RELAY_API_KEY` (or `PI_RELAY_API_KEY`),
  same `.env` fallback. Both files are preserved across `make install`
  re-runs. `chmod 600` them. Never commit them.

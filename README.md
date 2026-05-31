# pi-skills

Single-repo home for the [pi](https://github.com/earendil-works/pi)
coding-agent extras I run on every machine: Go **skill** binaries plus
TypeScript **extensions**, all installed into `~/.pi/agent/` by one `Makefile`.

- **Skills** are built and **copied** to `~/.pi/agent/skills/<name>/`
  (a `SKILL.md` + a single self-contained Go binary).
- **Extensions** are **symlinked** into `~/.pi/agent/extensions/<name>{,.ts}`
  (pi follows the link and runs the TS source directly).

pi discovers both automatically — no MCP server, no daemon, no runtime
dependency beyond the skill binaries themselves.

## Where things live

Each directory documents itself. Start there for details:

| Directory | Docs | What's inside |
|---|---|---|
| [`skills/`](skills/README.md) | [README](skills/README.md) · [AGENTS](skills/AGENTS.md) | Go skill binaries (`ast-grep`, `context7`, `grep-search`, `update-models`, `websearch`). |
| [`extensions/`](extensions/README.md) | [README](extensions/README.md) · [AGENTS](extensions/AGENTS.md) | TS extensions (`btw`, `goal`, `question`, `session-lock`, `subagents`, `telegram`, `ui-cosmetics`). |
| [`scripts/`](scripts/README.md) | [README](scripts/README.md) · [AGENTS](scripts/AGENTS.md) | `local-config.py` — the per-machine toggle reconciler. |
| [`internal/mcp/`](internal/mcp/README.md) | [README](internal/mcp/README.md) · [AGENTS](internal/mcp/AGENTS.md) | Shared MCP HTTP/SSE client (used by `context7` and `grep-search`). |

The repo-level [`AGENTS.md`](AGENTS.md) holds the cross-cutting workflow for
coding agents; per-directory `AGENTS.md` files hold the local contracts.

## Workflow

Requires Go 1.26+. `ast-grep` also needs the
[`ast-grep` CLI](https://ast-grep.github.io) on `PATH` (`brew install
ast-grep`). `make install` shells out to `python3` (stdlib only) for the
per-machine toggle file.

```bash
make build      # -> bin/<skill> for every enabled skill
make install    # copy skills into ~/.pi/agent/skills/<name>/, symlink
                # extensions into ~/.pi/agent/extensions/, reconcile
                # skills.local.json
make uninstall  # remove skills + extension links (preserves .env, node_modules)
make status     # show enabled/disabled skills + extensions
make clean      # remove bin/
```

Day-to-day:

- **Edit a skill** → `make install` again (binaries are copied).
- **Edit an extension** → just `/reload` in pi (symlinks are live). Adding a
  *new* extension still needs `make install` once to create the link.

Override the install roots:

```bash
make install SKILLS_DIR=/some/other/skills EXTENSIONS_DIR=/some/other/extensions
```

## Toggling things per-machine

`skills.local.json` (next to the Makefile, **gitignored**) holds a per-machine
enable/disable map split by category:

```json
{
  "skills":     { "ast-grep": true, "websearch": false },
  "extensions": { "telegram": false }
}
```

`make install` reconciles it on every run via
[`scripts/local-config.py`](scripts/README.md): missing file → created with all
names `true`; new names → appended as `true`; existing entries (including
`false`) → left alone; legacy flat format → auto-migrated; invalid JSON → hard
fail. Names with `false` are skipped during build/install and their install dir
is removed, so toggling off actually purges them. `make status` shows the
current state.

## Conventions

- **Go:** standard library only, no external modules. Built/tested for macOS
  arm64; cross-compile with the usual `GOOS`/`GOARCH`.
- **Skills:** keep stdout clean (tool output only); progress and errors go to
  stderr. `SKILL.md` documents the arg shape pi uses.
- **Secrets:** API keys come from an env var, falling back to a `.env` next to
  the binary (`chmod 600`, never commit). See each directory's docs for the
  exact env var names.

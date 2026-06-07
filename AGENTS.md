# AGENTS.md

Repo-level contract for coding agents. Cross-cutting workflow lives here; the
per-directory contracts hold the local detail.

**Always read the relevant subdirectory's `AGENTS.md` and `README.md` before
touching that area** — they are the source of truth for local rules and they
override anything implied here. Each lists the contract for its own slice:

- [`skills/AGENTS.md`](skills/AGENTS.md) · [`skills/README.md`](skills/README.md)
  — skill authoring (SKILL.md contract, transports, stdout/stderr discipline,
  `.env` pattern).
- [`extensions/AGENTS.md`](extensions/AGENTS.md) · [`extensions/README.md`](extensions/README.md)
  — extension authoring (symlink model, hooks, self-containment rule).
- [`scripts/AGENTS.md`](scripts/AGENTS.md) · [`scripts/README.md`](scripts/README.md)
  — `local-config.py` invariants and `check-extensions.py`.
- [`internal/mcp/AGENTS.md`](internal/mcp/AGENTS.md) · [`internal/mcp/README.md`](internal/mcp/README.md)
  — shared MCP client rules.

These files are scattered across the tree — when in doubt, `find . -name
AGENTS.md -o -name README.md` and read the one closest to the files you're
changing.

## Why this exists

This repo is the single home for the pi extras I run on every machine: Go
**skill** binaries plus TypeScript **extensions**, both installed under
`~/.pi/agent/` by one `Makefile`. pi does not natively speak MCP, so most
skills wrap a remote MCP server (or a REST endpoint, or a local CLI) into a
plain `argv in → stdout out` executable. Extensions live alongside as a
separate install target.

Two install mechanics drive almost everything:

- **Skills are copied** (built Go binary + `SKILL.md`) into
  `~/.pi/agent/skills/<name>/`. Iterate by re-running `make install` (or, while
  debugging, `make build && ./bin/<skill> ...` directly without pi).
- **Extensions are symlinked** into `~/.pi/agent/extensions/`. After the first
  `make install`, edits are live on the next `/reload` — no re-install. The
  repo must stay put or the link dangles, and each extension must be
  self-contained (everything it imports lives in its own dir).

## Build & workflow

- `make install` is the only install path. It builds enabled skills, copies
  them, symlinks enabled extensions, removes disabled entries, and runs
  `scripts/local-config.py sync` to reconcile `skills.local.json`.
- Go 1.26+, **standard library only** — no external Go modules in skills or
  `internal/`. `python3` (stdlib only) required on `PATH` for the toggle file.
- Skill binaries: tool output → **stdout only**; diagnostics/progress/errors →
  **stderr**. Mixing them breaks pi's output parsing.
- **Lint / format / typecheck** live at the repo root, not in the Makefile:
  `pnpm install` once installs [Biome](https://biomejs.dev) + [lefthook](https://lefthook.dev)
  and wires the git hooks. TS is Biome-formatted (2-space) and type-checked via
  `scripts/check-extensions.py` (resolves pi's globally installed types — no
  committed `node_modules/`); Go stays `gofmt`-clean + `go vet` passing. The
  lefthook **pre-commit** runs Biome + `gofmt` on staged files, **pre-push**
  runs the full typecheck + `go vet`. Hooks call `./node_modules/.bin/*`
  directly (not `pnpm exec`) so a broken global pnpm config can't block them.

## Adding things

- **A skill** → see [`skills/AGENTS.md`](skills/AGENTS.md). In short:
  `mkdir skills/<name>` with `main.go` + `SKILL.md`, append to `ALL_SKILLS` in
  the `Makefile`, `make install`.
- **An extension** → see [`extensions/AGENTS.md`](extensions/AGENTS.md). In
  short: create `extensions/<name>.ts` or `extensions/<name>/index.ts`, append
  to `ALL_EXTENSIONS`, `make install`, then `/reload`.

Both lists are reconciled into `skills.local.json` automatically (new names
appended as `true`).

## Per-machine toggles

`skills.local.json` (gitignored, sibling of the `Makefile`) holds the
enable/disable map, split by category:

```json
{
  "skills":     { "ast-grep": false },
  "extensions": { "my-extension": false }
}
```

On every `make install`: missing file → created with all names `true`; new
names → appended as `true`; existing entries (including `false`) → left alone;
legacy flat format → auto-migrated, untracked names dropped with a notice;
invalid JSON → hard fail. Disabled entries are skipped during build/install and
their install dir is removed wholesale on the next run so pi's registries stay
in sync. Full behavior contract: [`scripts/AGENTS.md`](scripts/AGENTS.md).

## Gotchas

- `make install` **preserves** sibling files (`.env`, `node_modules/`, etc.) in
  skill install dirs for enabled entries — never `rm -rf` an install dir by
  hand. For *disabled* skill entries the dir is removed wholesale on the next
  install, `.env` included; back it up before toggling off. (Extensions are
  symlinks, so disabling one just drops the link — the real files are
  untouched.)
- The Makefile computes the disabled set at parse time via `$(shell ...)`; the
  reconcile pass runs *during* install and only ever adds `true`, so that
  earlier set stays correct for the same run.
- Install targets: `~/.pi/agent/skills/` and `~/.pi/agent/extensions/`.
  Override with `SKILLS_DIR=` / `EXTENSIONS_DIR=`.

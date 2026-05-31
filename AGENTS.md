# AGENTS.md

## Why this exists

This repo is the single home for the pi extras I run on every machine: Go
**skill** binaries plus TypeScript **extensions**, both installed under
`~/.pi/agent/` by one `Makefile`. pi does not natively speak MCP, so most
skills here wrap a remote MCP server (or a REST endpoint, or a local CLI)
into a plain executable and expose only an `argv in → stdout out` interface
to the agent. Extensions live alongside as a separate install target.

## SKILL.md = contract with pi

- pi reads `SKILL.md` to determine a skill's arg shape and purpose. It is a
  document for the agent, not for humans.
- Frontmatter (`name`, `description`) is required — pi uses it to build its
  skill registry, and the description is what makes the model decide whether
  to load the skill.
- CLI examples in the Usage section must exactly match the invocation form
  pi will use.

## Build & workflow

- Go 1.26+, standard library only — no external Go modules allowed in
  skills or `internal/`.
- `make install` is the only install path. Skills are **copied** (built Go
  binary + `SKILL.md`); iterate by re-running `make install` (or, while
  debugging, `make build && ./bin/<skill> ...` directly without involving
  pi). Extensions are **symlinked**, so after the first `make install` you
  only need `/reload` in pi to pick up edits — no re-install.
- Skill binaries: tool output → stdout only, diagnostics/progress/errors
  → stderr. Mixing them breaks pi's output parsing.
- `make install` also runs `scripts/local-config.py sync` to reconcile
  `skills.local.json`. `python3` (stdlib only) is required on `PATH`.

## Adding a skill

1. `mkdir skills/<name>`, add `main.go` + `SKILL.md`.
2. In `main.go`, pick the right transport and stick to one of:
   - the `internal/mcp` client to talk to a remote MCP server, then print
     results via `mcp.PrintTextContent(os.Stdout, ...)`,
   - `net/http` directly for plain REST endpoints (see `update-models` for
     a worked example — fetches the OpenCode-shaped Relay response,
     translates it into pi's shape, merges into a local config file), or
   - `os/exec` to shell out to a local CLI, forwarding stdio and propagating
     the exit code.
3. `SKILL.md` frontmatter must include `name` and `description`.
4. Append the name to `ALL_SKILLS` in the `Makefile`.
5. If an API key is needed, follow the `.env` file pattern (place next to
   binary, `chmod 600`, never commit). The `lookupAPIKey` shape used in
   `context7` and `update-models` is the canonical pattern: env var first,
   `.env` next to the resolved-symlink binary as fallback.
6. Run `make install`. The toggle reconciler will append the new name to
   `skills.local.json` under `skills` as `true`.

## Adding an extension

1. Create `extensions/<name>.ts` (single file) or `extensions/<name>/` with
   an `index.ts` (and optional `package.json` for npm deps).
2. Append `<name>` to `ALL_EXTENSIONS` in the `Makefile`.
3. `make install` — appended to `skills.local.json` under `extensions` as
   `true`.
4. `/reload` inside pi — auto-discovery picks the new entry up.

Extensions are not built. `make install` **symlinks** the directory (or
single `.ts`) into `~/.pi/agent/extensions/` — it does not copy. pi follows
the link and runs the TS source via jiti. Consequences:

- Edits in this repo are live on the next `/reload`; no re-install needed.
- The repo must stay in place — move or delete it and the link dangles.
- An extension must be self-contained: everything it imports lives inside
  its own directory, since the link points at that one directory. The
  `session-lock` extension follows this — its lock protocol lives at
  `extensions/session-lock/shared/session-lock.ts`, not in a repo-level
  shared dir. (The `pi-web` project symlinks *that* file as its source of
  truth, so the lock protocol has exactly one copy.)
- `node_modules/` built inside the extension dir is exposed as-is through
  the link.

## Per-machine toggles

`skills.local.json` (gitignored, sibling of the `Makefile`) holds the
per-machine enable/disable map, split by category:

```json
{
  "skills":     { "ast-grep": false },
  "extensions": { "my-extension": false }
}
```

Behavior on every `make install`:

- The file is auto-created if missing, with every tracked name set to
  `true`.
- New skills/extensions added to the Makefile lists are appended to the
  right category as `true`.
- Existing entries — including `false` flips — are left alone.
- Legacy flat format (`{ "ast-grep": false, ... }` from earlier versions)
  is auto-migrated to the nested layout. Names that don't match any tracked
  skill or extension are dropped with a printed notice.
- Invalid JSON fails the install hard.

Disabled entries are skipped during build/install, and the install dir for
them is removed wholesale on the next run so pi's registries stay in sync.

The toggle logic lives in `scripts/local-config.py`, which exposes two
subcommands:

- `local-config.py sync <path> --skills ... --extensions ...` — the
  reconciliation pass run on each install.
- `local-config.py disabled <path> --kind {skills|extensions}` — used by
  the Makefile via `$(shell ...)` to compute the per-category disabled set.
  Reads both the nested format and legacy flat format, so the first install
  on a pre-migration file still honours `false` flips.

## Gotchas

- `make install` preserves sibling files (`.env`, `node_modules/`,
  lockfiles, etc.) in skill install dirs for enabled entries — never
  `rm -rf` the install dir manually. For *disabled* entries, the install
  dir is removed wholesale on the next install, including any `.env` or
  `node_modules/`. If you toggle an entry off, back up its `.env` first.
  (Extensions are symlinks, so disabling one just removes the link — the
  real files in this repo are untouched.)
- `context7` uses a session-based MCP server (`Mcp-Session-Id` handshake
  required). `grep-search` is sessionless. `ast-grep` is not MCP at all —
  it just shells out to the local `ast-grep` CLI. `update-models` is plain
  REST (`net/http`), no MCP, no SDK.
- `update-models` calls Relay's *OpenCode* config endpoint, not a
  pi-specific one — Relay does not ship one. The skill translates the
  OpenCode response (variant-based reasoning controls, snake_case cost
  fields, models keyed by id) into pi's shape (`thinkingLevelMap`,
  camelCase, models as an ordered array). The translation lives in
  `parseOpenCodeRelay` and `translateModel` in the skill's `main.go`.
- `update-models` does not set `$PI_RELAY_API_KEY` in the user's shell —
  pi resolves that variable at request time. The skill only manages
  `models.json` and the `.env` next to its own binary. The user still needs
  the export in their shell rc to actually run completions.
- `.env` path resolution follows symlinks via `EvalSymlinks` to find the real
  directory.
- Install targets: `~/.pi/agent/skills/` and `~/.pi/agent/extensions/`.
  Override with `SKILLS_DIR=` / `EXTENSIONS_DIR=`.
- The Makefile computes the disabled set with a `$(shell ...)` call into
  the helper script at parse time. The reconcile pass runs *during* install
  and only ever adds `true` entries, so the disabled set computed earlier
  is still correct for the same run.

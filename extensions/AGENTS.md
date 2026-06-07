# Extensions — agent contract

Authoring rules for the TypeScript extensions in this directory. Read this
before adding or editing one.

## Symlink model (not copied)

`make install` **symlinks** the extension directory (or single `.ts`) into
`~/.pi/agent/extensions/` — it does not copy. Consequences:

- Edits in this repo are live on the next `/reload`; no re-install needed.
- The repo must stay in place — move or delete it and the link dangles.
- An extension must be **self-contained**: everything it imports lives inside
  its own directory, since the link points at that one directory.
  - `session-lock` keeps its lock protocol at `shared/session-lock.ts` (not in
    a repo-level shared dir). The `pi-web` project symlinks *that* file as its
    source of truth, so the lock protocol has exactly one copy.
  - `subagents` keeps preset discovery in `agents.ts` and the bundled presets
    in `agents/*.md`.
- A `node_modules/` built inside the extension dir is exposed as-is through the
  link.

## What an extension can register

Extensions hook pi's lifecycle and surface. Observed patterns in this repo:

- **Lifecycle hooks**: `session_start`, `turn_start`, `before_agent_start`,
  `agent_end`, `tool_call`, `context`, `session_shutdown`.
- **Slash commands**: e.g. `/btw`, `/goal`, `/takeover`.
- **Tools**: e.g. `questionnaire`, `goal_done`/`goal_blocked`,
  `spawn_subagents` & friends. Tools may be added dynamically (goal adds its
  tools only while a goal is live).
- **Keyboard shortcuts**: e.g. `subagents` registers `ctrl+\` for a fullscreen
  viewer.
- **Renderers**: `registerMessageRenderer` for custom message types (e.g.
  `ui-cosmetics`' `turn-meta`, `question`'s custom `renderCall`/`renderResult`).
- **Event bus**: extensions can emit/listen — `goal` emits
  `goal:status-change`, `telegram` listens for it.

## Imports

Single-file extensions may import `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` with no
`package.json`. For anything else, use the directory style and `npm install`
inside the extension's own folder.

## Config / env

Read config from env first, then a `.env` next to the resolved binary
(`telegram`), or from pi's settings files (`ui-cosmetics` reads
`compaction` from `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json`).
Locate the agent dir via `PI_AGENT_DIR`, falling back to `~/.pi/agent`
(`session-lock`, `subagents`). An extension that isn't configured should no-op
quietly (`telegram`), not error.

## Adding an extension

1. Create `extensions/<name>.ts` (single file) or `extensions/<name>/` with an
   `index.ts` (and optional `package.json` for npm deps).
2. Append `<name>` to `ALL_EXTENSIONS` in the root `Makefile`.
3. `make install` — symlinks it in and appends `<name>` to
   `skills.local.json` under `extensions` as `true`.
4. `/reload` inside pi — auto-discovery picks the new entry up.

Before committing, the lefthook hooks (installed via `pnpm install` at the repo
root) run Biome format/lint and `scripts/check-extensions.py` over the
extensions; run `pnpm run check` / `pnpm run typecheck` manually if you want to
verify ahead of the hook. Keep to 2-space indent (Biome's config).

After the first install, editing the extension needs only `/reload` — the
symlink means pi already sees your changes.

## Gotcha

Disabling an extension just removes the symlink — the real files in this repo
are untouched (unlike skills, where a disabled entry's whole install dir,
`.env` included, is removed).

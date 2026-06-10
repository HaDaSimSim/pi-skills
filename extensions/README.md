# Extensions

TypeScript pi extensions. Unlike skills (built Go binaries that are copied),
extensions are **symlinked** into `~/.pi/agent/extensions/` on `make install` —
pi follows the link and runs the TS source directly via jiti.

Because it's a symlink, edits in this repo are live on the next `/reload`; no
re-install. The flip side: the repo must stay put — move or delete it and the
link dangles.

## Catalog

| Extension | What it does | Adds |
|---|---|---|
| `async-bash` | Runs long shell commands in the background (detached) and pings the main agent on exit instead of blocking the turn or polling with `sleep`. Same "fire and forget, get notified when done" model as `subagents`. Output streams to a temp log + capped inline buffer; jobs are session-persisted. | `bash_async`/`bash_jobs`/`bash_output`/`bash_abort` tools, `ctrl+b` viewer |
| `btw` | One-off "by the way" side question with full conversation context but zero effect on the main session (ports Claude Code's `/btw`). | `/btw <question>` |
| `file-guards` | Always-on file-safety guards: blocks `write` from clobbering an existing file not read this session, and appends recovery guidance when an `edit` fails to match. | — |
| `goal` | Autonomous goal loop (Ralph loop, ports Codex CLI's `/goal`) — pins a durable objective and re-injects continuation prompts each turn until done/blocked. | `/goal <objective>` (`pause`/`resume`/`clear`/`status`, `--budget N`, `--no-block`) |
| `question` | Interactive `questionnaire` tool — single question shows an option list, multiple shows tab-bar navigation with multi-select. | `questionnaire` tool |
| `session-lock` | Advisory exclusive session lock so a TUI session and the pi-web backend share one writer; non-owners drop to read-only. | `/takeover` |
| `stats` | Full-screen usage dashboard (ports opencode's `stats`) — per-session and global token/cost aggregation from session jsonl, read-only with zero LLM-context impact. | `/stats` |
| `subagents` | Background async multi-subagent runner — spawns concurrent child `pi` processes, persists transcripts, injects only final outputs back. | `spawn_subagents`/`list_subagents`/`fetch_subagent_result`/`send_to_subagent` tools, `ctrl+\` viewer |
| `telegram` | Telegram push notifications on long-task completion, goal status changes, and when user input is requested. | — |
| `todo` | Agent task-list tracker (ports Claude Code's TodoWrite) — the model manages a structured checklist; while working, in-progress/remaining items show in a widget right under the "Working… Ns" line, plus an always-on `n/N todos` footer count. Session-persisted, restored on reload. | `todo_write`/`todo_read` tools, `/todo` (`clear`) |
| `ui-cosmetics` | Footer customization (token counts, auto-compaction marker, stats/model/branch lines) plus a live "Working… 3s" timer and per-turn model+duration meta. | — |

## Config / env

Most extensions are self-contained and read nothing. The exceptions:

- `telegram` → `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional
  `TELEGRAM_MIN_SECONDS` (default 30), from env or a `.env` next to the
  resolved binary. No-ops if unconfigured.
- `session-lock` → `PI_AGENT_DIR` (else `~/.pi/agent`) to locate the `locks/`
  dir.
- `subagents` → `PI_AGENT_DIR`; isolates child sessions under
  `<agentDir>/.subagent-sessions`; discovers agent presets from
  `~/.pi/agent/agents/*.md`, `.pi/agents/*.md`, and its own bundled `agents/*.md`.
- `ui-cosmetics` → reads `compaction` settings from `~/.pi/agent/settings.json`
  and `<cwd>/.pi/settings.json`.

## Layout

Two shapes are supported per extension:

```
extensions/
├── <name>.ts        # single file → ~/.pi/agent/extensions/<name>.ts
└── <name>/          # directory   → ~/.pi/agent/extensions/<name>/
    ├── index.ts     #              entry point
    ├── package.json #              optional, for npm deps
    └── ...
```

A single-file extension can `import` from `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` without a
`package.json`. Anything else needs the directory style with its own
`node_modules/` (exposed as-is through the symlink). A self-contained extension
keeps everything it imports inside its own directory — e.g. `session-lock` keeps
its lock protocol at `session-lock/shared/session-lock.ts`, and `subagents`
keeps its preset discovery in `subagents/agents.ts` plus `subagents/agents/`.

See [`AGENTS.md`](AGENTS.md) for the authoring contract (hooks, self-containment
rule, how to add one).

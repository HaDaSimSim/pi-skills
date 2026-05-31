# Skills

Go **skill** binaries that pi runs as plain executables (`argv in → stdout
out`). Each skill wraps a remote MCP server, a REST endpoint, or a local CLI
behind a `SKILL.md` contract pi reads to decide when and how to invoke it.

On `make install` each enabled skill is **copied** (built binary + `SKILL.md`)
into `~/.pi/agent/skills/<name>/`. The binaries are self-contained, so a skill
keeps working even if this repo moves.

## Catalog

| Skill | What it does | Transport | Keys |
|---|---|---|---|
| `ast-grep` | AST-aware structural code search and rewrite across 25 languages (patterns, not regex). | local CLI (`ast-grep`/`sg`) | — |
| `context7` | Real-time library/framework documentation lookup. | MCP (session-based) | `CONTEXT7_API_KEY` |
| `grep-search` | Search real code across public GitHub repos via grep.app. | MCP (sessionless) | — |
| `update-models` | Sync the Relay (`sk-relay-...`) provider catalog into `~/.pi/agent/models.json`. | REST (`net/http`) | `RELAY_API_KEY` / `PI_RELAY_API_KEY` |
| `websearch` | Web search via a SearXNG instance, ranked plain-text results. | REST (`net/http`) | `SEARXNG_URL` (req), `SEARXNG_API_KEY` (opt) |

### CLI shapes

```bash
ast-grep search  "<pattern>" --lang <lang> [paths...] [--glob <g>]... [--context <n>]
ast-grep replace "<pattern>" "<rewrite>" --lang <lang> [paths...] [--glob <g>]... [--apply]

context7 resolve "<library name>" [query]
context7 query   "<library_id>" "<question>"

grep-search "<query>" [--lang <l>]... [--repo <owner/repo>] [--path <p>] [--regexp] [--case] [--words]

update-models {refresh | setup [--api-key K] [--skip-refresh] | remove | status | test}

websearch "<query>" [--count N] [--lang CODE] [--time RANGE] [--category CAT] \
          [--engines LIST] [--page N] [--safe 0|1|2] [--json]
```

The authoritative arg shape for each skill is its own `SKILL.md` — that is the
contract pi loads.

## API keys

Skills that need a key read it from an env var first, then fall back to a
`.env` file placed next to the resolved (symlink-followed) binary in the
install dir. `chmod 600` the `.env`, never commit it.

- `context7` → `CONTEXT7_API_KEY`
- `update-models` → `RELAY_API_KEY`, else `PI_RELAY_API_KEY` (key must start
  with `sk-relay-`). Also honours `RELAY_SETUP_URL` and `PI_MODELS_PATH`
  overrides.
- `websearch` → `SEARXNG_URL` (required base URL) and optional
  `SEARXNG_API_KEY` bearer token.

`ast-grep` and `grep-search` need no keys.

## Layout

```
skills/
├── <name>/
│   ├── SKILL.md   # contract pi reads (frontmatter: name, description)
│   └── main.go    # the skill binary's source
└── ...
```

See [`AGENTS.md`](AGENTS.md) for the skill-authoring contract (transport rules,
stdout/stderr discipline, the `.env` pattern, how to add a skill).

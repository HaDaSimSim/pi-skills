# scripts

Helper scripts for the build. `python3` (stdlib only) must be on `PATH`.

## local-config.py

Manages `skills.local.json` — the gitignored, per-machine enable/disable map
that sits next to the root `Makefile`. The Makefile calls it on every install.

Two subcommands:

```bash
# Reconcile the toggle file against the names tracked by the Makefile.
local-config.py sync <path> --skills NAME... --extensions NAME...

# Print disabled names (value false) for one category, one per line.
local-config.py disabled <path> --kind {skills|extensions}
```

### What `sync` does

- **missing/empty file** → created with every tracked name set to `true`.
- **missing entries** → appended as `true` under the right category.
- **present entries** (including `false` flips) → left exactly as written.
- **legacy flat format** (`{ "ast-grep": false, ... }`) → auto-migrated to the
  nested `{ "skills": {...}, "extensions": {...} }` layout using the category
  lists. Names in neither list are dropped with a printed notice.
- **invalid JSON / non-object root** → error to stderr, exit 1 (hard fail).

### What `disabled` does

Used by the Makefile's `$(shell ...)` to compute its disabled set. Reads both
formats: nested filters by `--kind`; legacy flat emits every `name:false` (the
Makefile then intersects with `ALL_SKILLS` / `ALL_EXTENSIONS`), so the first
install on a pre-migration file still honours `false` flips.

stdout is reserved for sync messages / disabled output; all errors go to stderr.

See [`AGENTS.md`](AGENTS.md) for invariants to preserve when editing.

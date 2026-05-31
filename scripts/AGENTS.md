# scripts — agent contract

Invariants to preserve when editing `local-config.py`. The Makefile depends on
this exact behavior; breaking it silently corrupts every machine's toggle file.

## Hard rules

- **stdlib only.** No external Python deps. `python3` is assumed on `PATH`.
- **stdout discipline.** `sync` prints human messages; `disabled` prints names
  one per line — that output is parsed by the Makefile via `$(shell ...)`.
  Everything else (errors, notices) goes to **stderr**. Do not print stray
  lines to stdout from `disabled`.
- **`sync` only ever adds `true` entries**, never `false`. The Makefile
  computes its disabled set at parse time, *before* `sync` runs during install;
  because sync never adds `false`, that earlier-computed set stays correct for
  the same run. Preserve this — do not make sync disable anything.
- **Never reorder or drop user `false` flips.** Existing entries (including
  `false`) must survive untouched across runs.

## Format contract

- Nested is canonical: `{ "skills": {name: bool}, "extensions": {name: bool} }`.
- `_is_nested` detects nested when `skills` or `extensions` maps to a dict; else
  the file is treated as legacy flat `{name: bool}`.
- Legacy flat is migrated on `sync` using the category lists; names matching
  neither category are dropped with a printed notice (to stderr).
- Invalid JSON or a non-object root must hard-fail (exit 1) — never silently
  rewrite a malformed file.

## How the Makefile consumes it

- `sync` runs inside the `install` target (after `build`, via the
  `sync-config` phony) with `--skills $(ALL_SKILLS) --extensions
  $(ALL_EXTENSIONS)`.
- `disabled` is called twice at parse time (`--kind skills`, `--kind
  extensions`); the Makefile intersects each result with the tracked name list
  so stray legacy names can't disable an unrelated new entry.

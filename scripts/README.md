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

## check-extensions.py

Type-checks the TypeScript extensions with `tsc --noEmit` without committing a
`node_modules/` or `tsconfig.json`. Extensions are plain `.ts` files run by pi
via jiti, so there is nothing locally for the compiler to resolve
`@earendil-works/*` or the Node builtins against. This script locates the
global pi install at runtime, writes a throwaway `tsconfig.json` pointing
`paths`/`typeRoots` at pi's bundled types, and runs `tsc` over the named
extension dirs.

```bash
# Type-check one or more extension dirs (all *.ts found under each).
check-extensions.py EXT_DIR [EXT_DIR ...]
```

Exit code is tsc's (0 clean, non-zero on type errors). Requires `node`, `npm`,
and `npx` on `PATH` — the same toolchain pi itself needs. Invoked by the
lefthook pre-push hook and the root `pnpm run typecheck` script.

## check-commit-msg.py

Enforces [Conventional Commits v1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
on the commit message header. Invoked by the lefthook `commit-msg` hook with
the path to git's commit-message file:

```bash
# Validate the header of a commit message file.
check-commit-msg.py <path-to-commit-msg-file>
```

The header (first non-blank, non-comment line) must match:

```
<type>[(scope)][!]: <description>
```

- **type** — one of `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `perf`,
  `refactor`, `revert`, `style`, `test` (lowercase).
- **(scope)** — optional, non-empty.
- **!** — optional, flags a breaking change.
- **`: `** — literal colon + single space separator.
- **description** — non-empty.

Git-generated messages (`Merge `, `Revert `, `fixup! `, `squash! `, `amend! `)
are skipped. Exit 0 on a conforming message, 1 otherwise with an actionable
explanation on stderr; stdout is left empty. stdlib only — needs `python3` on
`PATH`.

---
name: ast-grep
description: Structural code search and rewrite using ast-grep AST patterns across 25 languages. Use when you need to find or refactor code by syntax structure rather than text matching - function definitions, call sites, import shapes, control flow patterns. Not regex.
---

# ast-grep — Structural Code Search & Rewrite

AST-aware search/replace across the project. Patterns describe code shape, not text.

## Setup

Requires the `ast-grep` CLI (also published as `sg`) on PATH:

```bash
brew install ast-grep
# or: cargo install ast-grep --locked
```

## Pattern syntax

Patterns must be valid, parseable source in the target language. Two meta-variables:

| Token | Matches |
|-------|---------|
| `$VAR`  | exactly one AST node (an identifier, expression, statement, ...) |
| `$$$`   | zero or more nodes (argument lists, function bodies, statement sequences) |
| `$$$VAR`| same as `$$$`, captured for reuse in the rewrite |

Regex syntax does not work. No `|`, no `.*`, no `\w`, no `[a-z]`. For text or alternation, fall back to `grep-search` or ripgrep.

## Usage

### Search

```bash
./ast-grep search "<pattern>" --lang <lang> [paths...] [--glob <g>]... [--context <n>]
```

### Replace (dry-run preview)

```bash
./ast-grep replace "<pattern>" "<rewrite>" --lang <lang> [paths...] [--glob <g>]...
```

### Replace (apply changes)

```bash
./ast-grep replace "<pattern>" "<rewrite>" --lang <lang> [paths...] --apply
```

Without `--apply`, replace prints the diff without modifying files.

### Options

| Option | Description |
|--------|-------------|
| `--lang <lang>` (required) | One of: bash, c, cpp, csharp, css, elixir, go, haskell, html, java, javascript, json, kotlin, lua, nix, php, python, ruby, rust, scala, solidity, swift, typescript, tsx, yaml |
| `--glob <pattern>` | Include/exclude glob (repeatable). Prefix with `!` to exclude. |
| `--context <n>` | Lines of context around each match (search only). |
| `--apply` | Apply rewrites in place (replace only). |

Paths default to the current directory.

## Examples

Find every `console.log` call in a TS project:
```bash
./ast-grep search "console.log($$$)" --lang typescript src/
```

Find Go error-check blocks:
```bash
./ast-grep search "if err != nil { $$$ }" --lang go
```

Find React `useState` calls capturing the setter name:
```bash
./ast-grep search "const [$VAR, $SETTER] = useState($$$)" --lang tsx
```

Preview replacing `console.log` with a logger:
```bash
./ast-grep replace "console.log($MSG)" "logger.info($MSG)" --lang typescript src/
```

Apply the same rewrite:
```bash
./ast-grep replace "console.log($MSG)" "logger.info($MSG)" --lang typescript src/ --apply
```

Limit to a glob:
```bash
./ast-grep search "func $NAME($$$) error { $$$ }" --lang go --glob "internal/**"
```

## Tips

- Patterns must be syntactically valid for the language. `def foo($$$):` will not parse in Python — use `def foo($$$)` instead.
- Each `$VAR` matches one whole node. To match a function call with any number of args, use `$FN($$$)`, not `$FN(...)`.
- For text-shaped matches (substrings, alternations, character classes) use `grep-search` instead.
- Captured meta-variables in the rewrite preserve matched content: `pattern="log($MSG)"` + `rewrite="logger.info($MSG)"`.
- `--apply` is destructive. Run without it first and review the diff.

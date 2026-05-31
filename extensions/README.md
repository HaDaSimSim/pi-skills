# Extensions

pi extensions tracked by this repo. Built/installed alongside skills via
the top-level `Makefile` so a single `make install` keeps both in sync with
`~/.pi/agent/`.

This directory is empty by default — drop new extensions in here and add the
name to `ALL_EXTENSIONS` in the `Makefile`.

## Layout

Two shapes are supported per extension:

```
extensions/
├── <name>.ts            # single file → installed to ~/.pi/agent/extensions/<name>.ts
└── <name>/              # directory   → installed to ~/.pi/agent/extensions/<name>/
    ├── index.ts         #              entry point
    ├── package.json     #              optional, for npm deps
    └── ...
```

## Workflow

1. Create the extension at `extensions/<name>.ts` or `extensions/<name>/`.
2. Append `<name>` to `ALL_EXTENSIONS` in the `Makefile`.
3. `make install`.
4. `/reload` inside pi to pick it up.

## Per-machine toggles

`skills.local.json` (next to the Makefile, gitignored) holds the
enable/disable map split by category. Set an extension to `false` to skip
it on the next install:

```json
{
  "skills":     { "ast-grep": true },
  "extensions": { "my-extension": false }
}
```

Disabled extensions are removed from `~/.pi/agent/extensions/` on the next
`make install`. New extensions added to `ALL_EXTENSIONS` are appended to
the `extensions` section as `true` automatically. See the top-level
[`README.md`](../README.md#toggling-things-per-machine) for the full
behavior contract.

## Notes

- Anything other than the entry script (e.g. `node_modules/`,
  `package-lock.json`) lives inside the extension's directory and is
  copied along with it.
- Single-file extensions can `import` from `@earendil-works/pi-coding-agent`,
  `typebox`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` without a
  `package.json`. Anything else needs the directory style with `npm install`.
- See `~/.pi/agent/extensions/` after `make install` to confirm the install.

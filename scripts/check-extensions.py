#!/usr/bin/env python3
"""Type-check pi extensions with tsc, without polluting the repo.

The problem: extensions are plain `.ts` files run by pi via jiti, so there is
no `node_modules/` or `tsconfig.json` in this repo. Running `tsc` directly
fails on every import (`@earendil-works/*`, `typebox`) and every Node builtin
(`node:fs`, `process`, ...) because nothing tells the compiler where the types
live.

The fix: pi is installed globally and ships all those types inside its own
`node_modules/`. This script locates that install at runtime (machine
independent — no absolute paths committed), writes a throwaway `tsconfig.json`
that points `paths`/`typeRoots` at it, and runs `tsc --noEmit` over the named
extensions. No `npm install`, no committed `node_modules/`.

Usage:

  scripts/check-extensions.py EXT_DIR [EXT_DIR ...]

Each EXT_DIR is an extension directory under `extensions/` (the enabled set is
passed in by the Makefile). All `.ts` files found under each dir are checked.

Exit code is tsc's: 0 clean, non-zero on type errors. Diagnostics go to
stderr; tsc's own report goes to stdout.

stdlib only — no external Python deps. Requires `node`, `npm`, and `npx` on
PATH (the same toolchain pi itself needs).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

PI_PKG = "@earendil-works/pi-coding-agent"

# Type entry points to resolve inside the pi install. Keyed by the bare module
# specifier the extensions import; valued by the path *relative to the pi
# package root* (for pi itself) or to its bundled node_modules (for the rest).
# Resolved lazily below once we know the install root.
DEP_ENTRYPOINTS = {
    # pi itself lives at the package root.
    PI_PKG: ("pkg", "dist/index.d.ts"),
    # the rest are nested under pi's own node_modules.
    "@earendil-works/pi-ai": ("nm", "@earendil-works/pi-ai/dist/index.d.ts"),
    "@earendil-works/pi-tui": ("nm", "@earendil-works/pi-tui/dist/index.d.ts"),
    "typebox": ("nm", "typebox/build/index.d.mts"),
}


def die(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"check-extensions: {msg}", file=sys.stderr)
    sys.exit(2)


def npm_global_root() -> Path:
    """Locate the global node_modules where pi is installed."""
    try:
        out = subprocess.run(
            ["npm", "root", "-g"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as e:
        die(f"could not run `npm root -g`: {e}")
    root = Path(out)
    if not root.is_dir():
        die(f"npm global root does not exist: {root}")
    return root


def resolve_paths(global_root: Path) -> tuple[dict[str, list[str]], Path]:
    """Map each import specifier to its .d.ts inside the pi install."""
    pi_pkg = global_root / PI_PKG
    if not pi_pkg.is_dir():
        die(
            f"pi is not installed globally at {pi_pkg}.\n"
            f"  install it with `npm i -g {PI_PKG}` (or adjust your global prefix)."
        )
    pi_nm = pi_pkg / "node_modules"
    paths: dict[str, list[str]] = {}
    for spec, (base, rel) in DEP_ENTRYPOINTS.items():
        root = pi_pkg if base == "pkg" else pi_nm
        target = root / rel
        if not target.exists():
            die(
                f"expected type entry for `{spec}` not found at {target}.\n"
                f"  the pi install may have a different layout than this script expects."
            )
        paths[spec] = [str(target)]
    return paths, pi_nm


def collect_ts(ext_dirs: list[Path]) -> list[str]:
    files: list[str] = []
    for d in ext_dirs:
        if not d.is_dir():
            die(f"not a directory: {d}")
        found = sorted(str(p) for p in d.rglob("*.ts"))
        if not found:
            print(f"check-extensions: no .ts files under {d}, skipping", file=sys.stderr)
        files.extend(found)
    return files


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        die("usage: check-extensions.py EXT_DIR [EXT_DIR ...]")

    ext_dirs = [Path(a).resolve() for a in argv]
    ts_files = collect_ts(ext_dirs)
    if not ts_files:
        print("check-extensions: nothing to check", file=sys.stderr)
        return 0

    global_root = npm_global_root()
    paths, pi_nm = resolve_paths(global_root)

    tsconfig = {
        "compilerOptions": {
            "module": "esnext",
            "moduleResolution": "bundler",
            "target": "es2022",
            "lib": ["es2023"],
            # Extensions are loosely typed against pi's jiti runtime; mirror the
            # leniency pi's own examples assume rather than enforce full strict.
            # strictNullChecks stays ON, though: without it TypeScript won't
            # narrow discriminated unions (e.g. `if (!auth.ok)`), producing
            # bogus "property does not exist" errors on correct code.
            "strict": False,
            "strictNullChecks": True,
            "noImplicitAny": False,
            "noEmit": True,
            "skipLibCheck": True,
            "allowImportingTsExtensions": True,
            "types": ["node"],
            "typeRoots": [str(pi_nm / "@types")],
            "baseUrl": ".",
            "paths": paths,
        },
        "include": ts_files,
    }

    with tempfile.TemporaryDirectory(prefix="pi-check-") as tmp:
        cfg = Path(tmp) / "tsconfig.json"
        cfg.write_text(json.dumps(tsconfig, indent=2))
        try:
            proc = subprocess.run(
                ["npx", "-y", "-p", "typescript@5", "tsc", "-p", str(cfg)],
            )
        except OSError as e:
            die(f"could not run tsc via npx: {e}")
        return proc.returncode


if __name__ == "__main__":
    sys.exit(main())

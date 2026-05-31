#!/usr/bin/env python3
"""Manage skills.local.json — the per-machine enable/disable map.

Two subcommands, both invoked from the Makefile:

  scripts/local-config.py sync <path> --skills NAME... --extensions NAME...
      Reconcile the file with the names tracked by the Makefile:
      - missing file: create with every name set to `true`
      - missing entries: append as `true` under the right category
      - present entries: untouched
      - migration: a flat object (legacy format) is rewritten into
        { "skills": {...}, "extensions": {...} } using the provided category
        lists; entries that aren't in either list are dropped (with a notice)

  scripts/local-config.py disabled <path> --kind skills|extensions
      Print disabled names for one category, one per line. Used by Makefile
      to compute its DISABLED set with `$(shell ...)`.

Stdout is reserved for the sync messages and `disabled` output. Errors go
to stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


CATEGORIES = ("skills", "extensions")


def _load(path: Path) -> tuple[dict[str, Any] | None, bool]:
    """Return (parsed dict, existed). None on missing file."""
    if not path.exists() or path.stat().st_size == 0:
        return None, False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"error: {path} is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(data, dict):
        print(f"error: {path} root must be a JSON object", file=sys.stderr)
        sys.exit(1)
    return data, True


def _is_nested(data: dict[str, Any]) -> bool:
    """Heuristic: nested format has at least one of `skills`/`extensions`
    whose value is a JSON object. Anything else is treated as legacy flat."""
    for cat in CATEGORIES:
        v = data.get(cat)
        if isinstance(v, dict):
            return True
    return False


def _migrate_flat(
    data: dict[str, Any], skills: list[str], extensions: list[str]
) -> tuple[dict[str, Any], list[str]]:
    """Convert a flat `{name: bool}` map into `{skills: {...}, extensions: {...}}`.

    Returns (migrated, dropped_names). Names that aren't in either category
    list are reported and discarded — there's no way to know where they
    belong, and silently dropping `false` flips would be worse than telling
    the user.
    """
    skills_map: dict[str, bool] = {}
    extensions_map: dict[str, bool] = {}
    dropped: list[str] = []
    for k, v in data.items():
        if not isinstance(v, bool):
            continue
        if k in skills:
            skills_map[k] = v
        elif k in extensions:
            extensions_map[k] = v
        else:
            dropped.append(k)
    return {"skills": skills_map, "extensions": extensions_map}, dropped


def _ensure_section(data: dict[str, Any], cat: str) -> dict[str, bool]:
    sub = data.get(cat)
    if not isinstance(sub, dict):
        sub = {}
        data[cat] = sub
    return sub


def cmd_sync(args: argparse.Namespace) -> int:
    path = Path(args.path)
    skills: list[str] = args.skills or []
    extensions: list[str] = args.extensions or []

    data, existed = _load(path)
    if data is None:
        data = {"skills": {}, "extensions": {}}

    notices: list[str] = []

    # Migrate legacy flat format if encountered.
    if existed and not _is_nested(data):
        migrated, dropped = _migrate_flat(data, skills, extensions)
        data = migrated
        notices.append(f"migrated {path} to nested skills/extensions format")
        if dropped:
            notices.append(
                f"dropped unknown legacy entries from {path}: {', '.join(dropped)} "
                "(no longer in skills/extensions lists)"
            )

    skills_section = _ensure_section(data, "skills")
    extensions_section = _ensure_section(data, "extensions")

    added_skills = [n for n in skills if n not in skills_section]
    for n in added_skills:
        skills_section[n] = True
    added_exts = [n for n in extensions if n not in extensions_section]
    for n in added_exts:
        extensions_section[n] = True

    changed = bool(notices) or not existed or added_skills or added_exts
    if not changed:
        return 0

    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    if not existed:
        print(f"creating {path} (all entries enabled; flip to false to disable)")
        return 0

    for n in notices:
        print(n)
    if added_skills:
        print(f"added missing skills to {path}: {', '.join(added_skills)} (set to true)")
    if added_exts:
        print(
            f"added missing extensions to {path}: {', '.join(added_exts)} (set to true)"
        )
    return 0


def cmd_disabled(args: argparse.Namespace) -> int:
    path = Path(args.path)
    kind = args.kind
    data, existed = _load(path)
    if not existed or data is None:
        return 0
    # Support both nested and legacy-flat reads here so the Makefile sees a
    # consistent disabled set during the transition (sync runs after this in
    # the install target, so the first install on a legacy file still has to
    # honour `false` flips).
    if _is_nested(data):
        section = data.get(kind)
        if not isinstance(section, dict):
            return 0
        for name, value in section.items():
            if value is False:
                print(name)
        return 0
    # Legacy flat: emit any `name: false` regardless of category. The
    # Makefile filters by intersecting with $(ALL_SKILLS) / $(ALL_EXTENSIONS),
    # so emitting both here is safe.
    for name, value in data.items():
        if value is False:
            print(name)
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_sync = sub.add_parser("sync", help="Reconcile file with tracked names")
    p_sync.add_argument("path")
    p_sync.add_argument("--skills", nargs="*", default=[])
    p_sync.add_argument("--extensions", nargs="*", default=[])
    p_sync.set_defaults(func=cmd_sync)

    p_dis = sub.add_parser("disabled", help="Print disabled names for one category")
    p_dis.add_argument("path")
    p_dis.add_argument("--kind", choices=CATEGORIES, required=True)
    p_dis.set_defaults(func=cmd_disabled)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

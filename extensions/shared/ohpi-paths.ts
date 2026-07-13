// Shared `.ohpi/` project-state path resolver.
//
// Policy (omo-flow State & Version Control): a project has exactly ONE
// project-local state root — `.ohpi/` at the project directory. It holds ALL
// project-scoped state (plan/config files, spec-graph data, evidence, notepad,
// project personas). It is gitignored via a SINGLE `.ohpi/` line — no scatter,
// no partial-ignore exceptions carved inside it. Session-only ephemera
// (active-agent, ralph loop, ultrawork tier, todo-reasons) does NOT live here —
// it stays in the pi session jsonl via appendEntry.
//
// This module is the single source of truth for locating those subdirs. It
// mirrors the `session-lock` precedent (see extensions/AGENTS.md ~15-17): the
// canonical file lives in ONE place under `extensions/shared/`, and every
// self-contained extension that needs it SYMLINKS this exact file into its own
// directory rather than copying it. Because `make install` symlinks the whole
// extension dir into `~/.pi/agent/extensions/`, the link is exposed as-is at
// runtime, so there is exactly one copy of the protocol.
//
// How an extension consumes it (session-lock style):
//   1. Inside your extension dir, create a `shared/` subdir.
//   2. Symlink this file in:
//        ln -sfn ../../shared/ohpi-paths.ts <ext>/shared/ohpi-paths.ts
//      (adjust the relative depth so it points at THIS file — the one true copy)
//   3. Import it self-contained:
//        import { ohpiPaths } from "./shared/ohpi-paths.ts";
//
// Resolution is PURE/deterministic: given a cwd it returns absolute `.ohpi/…`
// paths. Nothing is created by resolving. Directories are created lazily only
// when you explicitly call `ensureDir` (mkdir -p) at write time.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** The one project-local state root directory name. */
export const OHPI_ROOT = ".ohpi";

// ── Subdir constants (the ONLY sanctioned children of `.ohpi/`) ───────────────
// Consumers MUST reference these constants, never hardcode the strings, so the
// layout stays single-sourced. Downstream tasks wire specific subdirs:
//   - spec-graph data dir  → `.ohpi/spec-graph/`   (task 18 points its CLI here)
//   - notepad              → `.ohpi/notepad/`      (task 15)
//   - evidence             → `.ohpi/evidence/`     (task 26)
//   - project personas     → `.ohpi/primary-agents/` (task 8 wires switching)
//   - plans / generic config → `.ohpi/config/`, `.ohpi/plans/`
export const OHPI_SUBDIRS = {
  /** spec-graph CLI data dir. Task 18's wrapper points `--data-dir` here. */
  specGraph: "spec-graph",
  /** Evidence artifacts captured during runs. Task 26. */
  evidence: "evidence",
  /** Notepad / learnings scratch space. Task 15. */
  notepad: "notepad",
  /** Project-scoped primary-agent personas (`*.md`). Task 8 wires switching. */
  primaryAgents: "primary-agents",
  /** Generic per-project config (categories, agent config, toggles). */
  config: "config",
  /** Plan files (agent + user read/edit them locally, git never tracks). */
  plans: "plans",
} as const;

export type OhpiSubdirKey = keyof typeof OHPI_SUBDIRS;

/** Resolved absolute paths for a given project root's `.ohpi/` tree. */
export interface OhpiPaths {
  /** Absolute path to `<cwd>/.ohpi`. */
  root: string;
  /** Absolute path to `<cwd>/.ohpi/spec-graph`. */
  specGraph: string;
  /** Absolute path to `<cwd>/.ohpi/evidence`. */
  evidence: string;
  /** Absolute path to `<cwd>/.ohpi/notepad`. */
  notepad: string;
  /** Absolute path to `<cwd>/.ohpi/primary-agents`. */
  primaryAgents: string;
  /** Absolute path to `<cwd>/.ohpi/config`. */
  config: string;
  /** Absolute path to `<cwd>/.ohpi/plans`. */
  plans: string;
}

/**
 * Resolve every sanctioned `.ohpi/` subdir under the given project directory.
 *
 * PURE: only string joins; touches no filesystem. `cwd` is the project root
 * (typically the pi session cwd). Callers that need a directory to exist call
 * `ensureDir(...)` at write time.
 */
export function ohpiPaths(cwd: string): OhpiPaths {
  const root = join(cwd, OHPI_ROOT);
  return {
    root,
    specGraph: join(root, OHPI_SUBDIRS.specGraph),
    evidence: join(root, OHPI_SUBDIRS.evidence),
    notepad: join(root, OHPI_SUBDIRS.notepad),
    primaryAgents: join(root, OHPI_SUBDIRS.primaryAgents),
    config: join(root, OHPI_SUBDIRS.config),
    plans: join(root, OHPI_SUBDIRS.plans),
  };
}

/**
 * Resolve a single `.ohpi/` subdir by key. PURE. Prefer this over hardcoding
 * subdir names so the layout stays single-sourced.
 */
export function ohpiSubdir(cwd: string, key: OhpiSubdirKey): string {
  return join(cwd, OHPI_ROOT, OHPI_SUBDIRS[key]);
}

/**
 * Resolve the `.ohpi/` root by walking up from `cwd` to the nearest ancestor
 * that already contains a `.ohpi/` directory. Returns `null` if none exists.
 *
 * Read-only discovery (used to find an existing project root from a nested
 * cwd). To locate WHERE to create state, use `ohpiPaths(cwd).root` directly.
 */
export function findOhpiRoot(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = join(current, OHPI_ROOT);
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Create a directory (and parents) if absent — the ONLY function here that
 * touches the filesystem. Idempotent (`mkdir -p` semantics). Returns the path.
 * Call this lazily at write time, never during resolution.
 */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// spec-graph — thin typed wrapper around the /opt/homebrew/bin/spec-graph CLI.
//
// Every call redirects the database to `<cwd>/.ohpi/spec-graph/graph.db` (task 31
// State & VC policy). Commands: init, validate, query unresolved, export json,
// phase next, entity, relation. No graph logic is reimplemented here — just spawn,
// parse JSON, surface structured errors.
//
// Key export: graphExists(cwd) — true iff the db file exists AND validate does
// NOT return NOT_INITIALIZED. This is the critical building block for downstream
// tasks (done-gate, escape valve, pi-gui observe).
//
// CLI-presence check: if `spec-graph` is not on PATH, every export no-ops quietly
// (graphExists→false, all wrappers return { ok: false, error: "CLI missing" }).
// Follows the no-op-quietly philosophy from extensions/AGENTS.md.
//
// EXTENSION ENTRYPOINT: The default export is a pi extension factory that wires
// the done-gate continuation intent at load time. pi loads index.ts (not
// done-gate.ts) — without this default export, spec-graph errors as "does not
// export a valid factory function". The done-gate's own export default is
// harmless (never called by pi directly) but preserved for standalone testing.
// The CANONICAL entrypoint is this file (index.ts).

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDoneGate } from "./done-gate.ts";
import { ensureDir, ohpiSubdir } from "./shared/ohpi-paths.ts";

// ── CLI detection (cached) ──────────────────────────────────────────────────

let cliChecked = false;
let cliAvailable = false;
const CLI_BINARY = "spec-graph";

/** Check (once) whether the spec-graph binary is available on PATH. */
function isCliAvailable(): boolean {
  if (cliChecked) return cliAvailable;
  cliChecked = true;
  try {
    const proc = spawn("which", [CLI_BINARY], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    cliAvailable = true;
    proc.on("error", () => {
      cliAvailable = false;
    });
    // Quick sync check: if the binary exists at the expected path, assume yes.
    // We also try the known path explicitly.
    if (existsSync("/opt/homebrew/bin/spec-graph")) {
      cliAvailable = true;
    }
    return cliAvailable;
  } catch {
    cliAvailable = false;
    return false;
  }
}

// ── Result types ────────────────────────────────────────────────────────────

/** Structured result from any CLI call. */
export interface SgResult<T = unknown> {
  ok: boolean;
  /** Parsed JSON output (present when ok=true). */
  data?: T;
  /** Error details (present when ok=false). */
  error?: SgError;
  /** Raw stdout when JSON parsing failed but exit code was 0. */
  raw?: string;
  /** Exit code from the child process. */
  exitCode?: number;
}

export interface SgError {
  code: string;
  message: string;
}

// ── Shared spawn helper ─────────────────────────────────────────────────────

const SG_BINARY = "/opt/homebrew/bin/spec-graph";

function dbPath(cwd: string): string {
  return `${ohpiSubdir(cwd, "specGraph")}/graph.db`;
}

/**
 * Run spec-graph with the given CLI arguments.
 * Always appends `--db <cwd>/.ohpi/spec-graph/graph.db`.
 */
function runSg(args: string[], cwd: string): Promise<SgResult> {
  if (!isCliAvailable()) {
    return Promise.resolve({
      ok: false,
      error: { code: "CLI_MISSING", message: "spec-graph CLI not found on PATH" },
    });
  }

  const fullArgs = ["--db", dbPath(cwd), ...args];

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(SG_BINARY, fullArgs, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        ok: false,
        error: {
          code: "SPAWN_FAILED",
          message: `spawn failed: ${(e as Error).message}`,
        },
      });
      return;
    }

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8");
    });

    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        error: { code: "PROCESS_ERROR", message: e.message },
      });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;

      const trimmed = stdout.trim();
      const stderrTrimmed = stderr.trim();

      // spec-graph writes success JSON to stdout, error JSON to stderr.
      // Try parsing both — prefer stderr for error objects.
      const tryParse = (raw: string): Record<string, unknown> | null => {
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") return parsed;
        } catch {
          // Not JSON.
        }
        return null;
      };

      const stdoutObj = tryParse(trimmed);
      const stderrObj = tryParse(stderrTrimmed);

      // If stderr has an error object, use it (spec-graph's error convention).
      if (stderrObj && "error" in stderrObj) {
        resolve({
          ok: false,
          error: stderrObj.error as SgError,
          exitCode: code ?? undefined,
        });
        return;
      }

      // If stdout has an error object, use it.
      if (stdoutObj && "error" in stdoutObj) {
        resolve({
          ok: false,
          error: stdoutObj.error as SgError,
          exitCode: code ?? undefined,
        });
        return;
      }

      // Success: prefer stdout JSON, fall back to stderr JSON.
      if (stdoutObj) {
        resolve({
          ok: code === 0,
          data: stdoutObj,
          exitCode: code ?? undefined,
        });
        return;
      }

      // Non-error stderr JSON (unusual, but handle it).
      if (stderrObj) {
        resolve({
          ok: code === 0,
          data: stderrObj,
          exitCode: code ?? undefined,
        });
        return;
      }

      if (code === 0) {
        resolve({
          ok: true,
          raw: trimmed || undefined,
          exitCode: 0,
        });
      } else {
        resolve({
          ok: false,
          error: stderrTrimmed
            ? { code: "CLI_ERROR", message: stderrTrimmed }
            : { code: "EXIT_NONZERO", message: `exited with code ${code}` },
          raw: trimmed || undefined,
          exitCode: code ?? undefined,
        });
      }
    });
  });
}

// ── Wrap helper: run a subcommand with args ─────────────────────────────────

async function sgCommand(subcommand: string[], cwd: string): Promise<SgResult> {
  return runSg(subcommand, cwd);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether a spec-graph exists and is initialized for the given project
 * directory. True iff:
 *   1. The CLI is available, AND
 *   2. The db file exists at `<cwd>/.ohpi/spec-graph/graph.db`, AND
 *   3. `validate` does NOT return NOT_INITIALIZED.
 *
 * This is the critical export. Downstream tasks (done-gate, escape valve,
 * pi-gui observe) gate on this check.
 */
export async function graphExists(cwd: string): Promise<boolean> {
  if (!isCliAvailable()) return false;

  const dbFile = dbPath(cwd);
  if (!existsSync(dbFile)) return false;

  // Fast path: db file exists, let's check it's initialized.
  const result = await runSg(["validate"], cwd);
  if (!result.ok) {
    // NOT_INITIALIZED means the db file exists but isn't a valid graph.
    if (result.error?.code === "NOT_INITIALIZED") return false;
    // Any other error (e.g. CLI crashed) — assume exists but degraded.
    return false;
  }
  return true;
}

/**
 * Synchronous, cheap check: does the db file exist? Does NOT validate graph
 * integrity. Use `graphExists` for a definitive answer.
 */
export function graphDbFileExists(cwd: string): boolean {
  return existsSync(dbPath(cwd));
}

/**
 * Initialize a spec-graph project. Creates the graph db at
 * `<cwd>/.ohpi/spec-graph/graph.db`. Ensures the parent directory exists first.
 *
 * Returns the CLI's JSON: `{ initialized: true, path: string }`.
 */
export async function init(cwd: string): Promise<SgResult<{ initialized: boolean; path: string }>> {
  ensureDir(ohpiSubdir(cwd, "specGraph"));
  return sgCommand(["init", "--db", dbPath(cwd)], cwd) as Promise<
    SgResult<{ initialized: boolean; path: string }>
  >;
}

/**
 * Validate the graph. Returns `{ valid: boolean, issues: [...], summary: {...} }`.
 *
 * @param checks - Optional comma-separated list of check names to restrict
 *   validation. Available: orphans, coverage, invalid_edges, superseded_refs,
 *   unresolved, cycles, conflicts, phase_order, single_active_plan, orphan_phases,
 *   exec_cycles, invalid_exec_edges, plan_coverage, delivery_completeness,
 *   mapping_consistency, invalid_mapping_edges, gates, phase_satisfaction.
 */
export async function validate(cwd: string, checks?: string): Promise<SgResult<ValidateResult>> {
  const args = ["validate"];
  if (checks) args.push("--check", checks);
  return sgCommand(args, cwd) as Promise<SgResult<ValidateResult>>;
}

/**
 * Synchronous validate — for use in continuation-intent decide() which runs
 * synchronously inside the coordinator arbiter.
 *
 * Uses spawnSync (blocking). Returns the same SgResult shape as async validate.
 */
export function validateSync(cwd: string, checks?: string): SgResult<ValidateResult> {
  if (!isCliAvailable()) {
    return {
      ok: false,
      error: { code: "CLI_MISSING", message: "spec-graph CLI not found on PATH" },
    };
  }

  const args = ["--db", dbPath(cwd), "validate"];
  if (checks) args.push("--check", checks);

  try {
    const proc = spawnSync(SG_BINARY, args, {
      cwd,
      shell: false,
      encoding: "utf-8",
    });

    const stdout = (proc.stdout ?? "").trim();
    const stderr = (proc.stderr ?? "").trim();
    const code = proc.status;

    // Parse both streams — spec-graph writes errors to stderr.
    const tryParse = (raw: string): Record<string, unknown> | null => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };

    const stderrObj = tryParse(stderr);
    const stdoutObj = tryParse(stdout);

    if (stderrObj && "error" in stderrObj) {
      return { ok: false, error: stderrObj.error as SgError, exitCode: code ?? undefined };
    }
    if (stdoutObj && "error" in stdoutObj) {
      return { ok: false, error: stdoutObj.error as SgError, exitCode: code ?? undefined };
    }
    if (stdoutObj) {
      return {
        ok: true,
        data: stdoutObj as unknown as ValidateResult,
        exitCode: code ?? undefined,
      };
    }
    if (code !== 0) {
      return {
        ok: false,
        error: stderr
          ? { code: "CLI_ERROR", message: stderr }
          : { code: "EXIT_NONZERO", message: `exited with code ${code}` },
        exitCode: code ?? undefined,
      };
    }
    return { ok: true, raw: stdout || undefined, exitCode: 0 };
  } catch (e) {
    return {
      ok: false,
      error: { code: "SPAWN_FAILED", message: `spawnSync failed: ${(e as Error).message}` },
    };
  }
}

export interface ValidateIssue {
  severity: string;
  check: string;
  entity?: string;
  message: string;
}

export interface ValidateResult {
  valid: boolean;
  issues: ValidateIssue[];
  summary: {
    total_issues: number;
    by_severity: Record<string, number>;
  };
}

/**
 * List unresolved questions, assumptions, and risks.
 */
export async function queryUnresolved(cwd: string): Promise<SgResult<QueryUnresolvedResult>> {
  return sgCommand(["query", "unresolved"], cwd) as Promise<SgResult<QueryUnresolvedResult>>;
}

export interface QueryUnresolvedResult {
  entities: unknown[];
  summary: {
    total: number;
    by_type: Record<string, number>;
  };
}

/**
 * Export the full graph as JSON.
 */
export async function exportJson(cwd: string): Promise<SgResult<ExportJsonResult>> {
  return sgCommand(["export", "--format", "json"], cwd) as Promise<SgResult<ExportJsonResult>>;
}

export interface ExportJsonResult {
  entities: unknown[];
  relations: unknown[];
}

/**
 * Get the next phase in the active plan.
 */
export async function phaseNext(cwd: string): Promise<SgResult<unknown>> {
  return sgCommand(["phase", "next"], cwd);
}

/**
 * Run an arbitrary `spec-graph entity` subcommand.
 * @param subcommandArgs - Everything after `entity` in the CLI, e.g.
 *   `["list", "REQ"]` or `["get", "REQ-001"]`.
 */
export async function entity(cwd: string, ...subcommandArgs: string[]): Promise<SgResult<unknown>> {
  return sgCommand(["entity", ...subcommandArgs], cwd);
}

/**
 * Run an arbitrary `spec-graph relation` subcommand.
 * @param subcommandArgs - Everything after `relation` in the CLI, e.g.
 *   `["list"]` or `["add", "--type", "covers", "--from", "REQ-001", "--to", "DEC-001"]`.
 */
export async function relation(
  cwd: string,
  ...subcommandArgs: string[]
): Promise<SgResult<unknown>> {
  return sgCommand(["relation", ...subcommandArgs], cwd);
}

// ── Extension factory (pi loads index.ts — canonical entrypoint) ─────────────

export default function (pi: ExtensionAPI): void {
  registerDoneGate(pi, process.cwd());
}

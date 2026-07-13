// spec-graph done-gate — intercepts done-declaration when a spec-graph EXISTS.
//
// When a graph exists for the session cwd, the gate runs validateSync with
// completion-relevant checks (delivery_completeness, phase_satisfaction, gates,
// unresolved) at each agent_end. If the graph is unmet, the gate:
//
//   1. Emits `ralph:status-change {status:"blocked", reason}` so ralph + GUI
//      reflect the blocked state.
//   2. Returns a re-prompt with the specific unmet issues so the agent can
//      address them.
//
// If the graph validates clean, the gate abstains (allow done through).
// Without a graph (db file missing or NOT_INITIALIZED), the gate abstains
// (escape valve, task 20).
//
// Finiteness: the gate fires ONCE per agent_end (one per edge via arbiter).
// A consecutive-unmet counter tracks retries; after MAX_RETRIES the message
// escalates but the gate still blocks. The agent/user must fix the graph or
// delete it to unblock — the gate NEVER allows done through an unmet graph.
//
// Priority: 201 — highest in loop-engine band (200-299). Checked BEFORE
// ultrawork evidence-gate (203) and ralph-loop (205), so an unmet graph
// blocks done before evidence or continuation fires.
//
// Guardrail: registered via hook-coordinator:register-continuation (event bus).
// NEVER a raw pi.on("agent_end") handler.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { graphDbFileExists, type ValidateResult, validateSync } from "./index.ts";

// ── Constants ────────────────────────────────────────────────────────────────

export const GATE_NAME = "spec-graph-done-gate";
export const GATE_PRIORITY = 201;
const MAX_RETRIES = 5;

/** Completion-relevant validation checks. */
export const COMPLETION_CHECKS = "delivery_completeness,phase_satisfaction,gates,unresolved";

// ── State ────────────────────────────────────────────────────────────────────

let consecutiveUnmet = 0;
let lastReasons: string[] = [];

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function extractReasons(result: ValidateResult): string[] {
  if (result.valid && result.issues.length === 0) return [];
  return result.issues.map((issue) => {
    const entity = issue.entity ? ` [${issue.entity}]` : "";
    return `[${issue.check}] ${issue.message}${entity}`;
  });
}

export function isUnmet(result: ValidateResult): boolean {
  return !result.valid || result.issues.length > 0 || result.summary.total_issues > 0;
}

export function buildRePrompt(reasons: string[], retryCount: number): string {
  const items = reasons.map((r) => `  - ${r}`).join("\n");

  if (retryCount >= MAX_RETRIES) {
    return [
      "[spec-graph-done-gate] **PERSISTENT BLOCK** — the spec-graph has unmet items after multiple attempts.",
      `This gate has fired ${retryCount} times. The graph must be fixed or deleted before done can be declared.`,
      "Unmet items:",
      items,
      "",
      "The current turn cannot declare done. Address the items above or delete the graph.",
    ].join("\n");
  }

  return [
    "[spec-graph-done-gate] The spec-graph has unmet completion requirements.",
    "These items must be resolved before declaring done:",
    items,
    "",
    "Address them now. When the graph validates clean, done will be allowed.",
  ].join("\n");
}

// ── Gate decide() (synchronous — called by coordinator arbiter) ──────────────

/**
 * Decide whether to block done at this agent_end.
 *
 * Runs validateSync (spawnSync, ~100ms). Abtains when:
 *   - No graph (NOT_INITIALIZED / CLI missing / db file absent)
 *   - Graph exists and validates CLEAN (valid=true, no issues)
 *
 * Blocks (returns re-prompt) when the graph exists and has unmet items.
 * Also emits ralph:status-change {status:"blocked"} so GUI reflects blocked.
 */
export function decide(
  cwd: string,
  pi?: ExtensionAPI,
):
  | {
      prompt: string;
      deliverAs?: "followUp";
    }
  | undefined {
  // Escape valve (task 20): if no graph db file exists, abstain immediately.
  // ZERO CLI spawns on the no-graph path — graphDbFileExists is a sync file stat.
  if (!graphDbFileExists(cwd)) {
    consecutiveUnmet = 0;
    lastReasons = [];
    return undefined;
  }

  // Run completion validation synchronously (only when db file exists).
  const result = validateSync(cwd, COMPLETION_CHECKS);

  // No graph: NOT_INITIALIZED, CLI missing, or spawn failed → abstain.
  if (!result.ok) {
    const code = result.error?.code;
    if (code === "NOT_INITIALIZED" || code === "CLI_MISSING") {
      consecutiveUnmet = 0;
      lastReasons = [];
      return undefined;
    }
    // Unexpected error (CLI crashed, etc.) — treat as unmet for safety.
    consecutiveUnmet++;
    const errorMsg = result.error?.message ?? "validation failed";
    lastReasons = [`validate error: ${errorMsg}`];
    if (pi) emitBlocked(pi, `spec-graph validate error: ${errorMsg}`, consecutiveUnmet);
    return { prompt: buildRePrompt(lastReasons, consecutiveUnmet) };
  }

  const data = result.data!;

  // Clean graph → allow done through.
  if (!isUnmet(data)) {
    consecutiveUnmet = 0;
    lastReasons = [];
    return undefined;
  }

  // Graph is unmet — block done.
  consecutiveUnmet++;
  lastReasons = extractReasons(data);
  const reasonSummary =
    lastReasons.length > 0 ? lastReasons[0] : "graph has unmet validation items";
  if (pi) emitBlocked(pi, reasonSummary, consecutiveUnmet);

  return { prompt: buildRePrompt(lastReasons, consecutiveUnmet) };
}

// ── Blocked emission ─────────────────────────────────────────────────────────

function emitBlocked(pi: ExtensionAPI, reason: string, retryCount: number): void {
  const suffix =
    retryCount >= MAX_RETRIES
      ? ` (persistent — ${retryCount} attempts)`
      : retryCount > 1
        ? ` (attempt ${retryCount})`
        : "";
  pi.events.emit("ralph:status-change", {
    status: "blocked",
    note: `[spec-graph] ${reason}${suffix}`,
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerDoneGate(pi: ExtensionAPI, cwd: string): void {
  const intent = {
    name: GATE_NAME,
    priority: GATE_PRIORITY,
    decide: () => decide(cwd, pi),
  };

  pi.events.emit("hook-coordinator:register-continuation", intent);
  pi.events.on("hook-coordinator:ready", () => {
    pi.events.emit("hook-coordinator:register-continuation", intent);
  });
}

// ── Extension entrypoint ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  registerDoneGate(pi, process.cwd());
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _resetForTest(): void {
  consecutiveUnmet = 0;
  lastReasons = [];
}

export function _getConsecutiveUnmet(): number {
  return consecutiveUnmet;
}

export function _setConsecutiveUnmet(n: number): void {
  consecutiveUnmet = n;
}

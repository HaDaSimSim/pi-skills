// planning-cast — ENFORCED GATE FLOW as a STATE MACHINE.
//
// Stages: idle → pre-plan (Metis gate) → planning (planner produces plan) → awaiting-critique (Momus gate) → passed | blocked
//
// ── Gate flow (task 23 + 24) ──────────────────────────────────────────────
//
//  idle
//   │ /cast start <task>
//   ▼
//  pre-plan ─── Metis (deep-reviewer subagent) pre-plan analysis ─── PASS → planning
//                                                                     REJECT → blocked → retry
//  planning ─── Planner persona (primary-agents "planner", read-mostly) produces plan artifact
//            ── /cast set-plan <path> auto-advances to awaiting-critique
//
//  awaiting-critique ─── Momus (deep-reviewer subagent) critiques plan ─── PASS → passed
//                                                                          REJECT → blocked → retry
//  passed ─── implementation proceeds
//
// ── Planner↔gate coupling (task 24) ───────────────────────────────────────
//
//  The planner persona (primary-agents/agents/planner.md, task 6/8 — Prometheus-inspired,
//  read-mostly tools) is the PLANNED plan producer between Metis and Momus.
//  The gate encourages the planner persona at the "planning" stage but does NOT
//  hard-require it — any plan producer that sets planPath can advance.
//
//  Coupling is through TWO mechanisms:
//   1. /cast set-plan <path> at planning stage AUTO-ADVANCES to awaiting-critique.
//      This is the "plan produced → advance" trigger.
//   2. The continuation intent at planning stage without planPath BLOCKS with
//      guidance to "switch to planner persona (/agent planner) and produce a plan."
//
//  The planner persona itself lives in primary-agents (task 6/8). The gate
//  references its name and sentinel but does NOT import from primary-agents.
//  Agent switches persona via the existing /agent planner command.
//
// ── ENFORCEMENT (task 23 invariant preserved) ─────────────────────────────
//
//  Progression to implementation is BLOCKED until the Momus critique gate returns PASS.
//  The cast-gate continuation intent (priority 202, between done-gate 201 and ultrawork-gate 203)
//  blocks the agent_end loop when the stage is "awaiting-critique" without a Momus pass.
//  No bypass is possible — the arbiter fires this intent BEFORE ultrawork/ralph.
//
// ── Durable state ─────────────────────────────────────────────────────────
//
//  appendEntry("cast-gate", {stage, metisVerdict?, momusVerdict?, task?, planPath?, ...})
//  Restores on session_start — gate state survives reload and compaction.
//
// ── Commands ──────────────────────────────────────────────────────────────
//
//  /cast start|status|plan|record-verdict|advance|set-plan|reset

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

/** Planning cast stages. */
export type CastStage =
  | "idle"
  | "pre-plan"
  | "planning"
  | "awaiting-critique"
  | "passed"
  | "blocked";

/** Gate role: who produced the verdict. */
export type GateRole = "metis" | "momus";

/** A verdict recorded by one of the gate agents. */
export interface Verdict {
  role: GateRole;
  verdict: "PASS" | "REJECT";
  summary?: string;
  reasons?: string[];
  ts: number;
}

/** Durable state persisted via appendEntry("cast-gate", ...). */
export interface CastGateState {
  stage: CastStage;
  task?: string;
  planPath?: string;
  metisVerdict?: Verdict;
  momusVerdict?: Verdict;
  startedAt?: number;
  updatedAt?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

export const STATE_ENTRY_TYPE = "cast-gate";

/**
 * Priority in the arbiter's loop-engine band.
 * 202 sits between done-gate (201) and ultrawork-evidence-gate (203).
 * Lower = checked first → when the cast gate blocks, neither ultrawork nor
 * ralph can fire → implementation is truly BLOCKED.
 */
export const GATE_PRIORITY = 202;
export const GATE_NAME = "planning-cast-gate";

/**
 * Metis pre-plan criteria — harvested from omo metis.ts.
 * These are the questions Metis checks before planning begins.
 */
export const METIS_CRITERIA = [
  "Intent classified (Refactoring | Build from Scratch | Mid-sized | Collaborative | Architecture | Research)",
  "Pre-analysis findings documented (codebase patterns explored, risks identified)",
  "Clarifying questions raised for the user (if ambiguity exists)",
  "Directives for Prometheus prepared (MUST / MUST NOT / PATTERN / TOOL)",
  "QA/acceptance criteria directives included (agent-executable, not human-in-the-loop)",
];

/**
 * Momus critique criteria — harvested from omo momus.ts + deep-reviewer.md.
 * These are the checks Momus performs on the plan.
 */
export const MOMUS_CRITERIA = [
  "Reference verification: do referenced files/paths exist?",
  "Executability: can each task be started with the context provided?",
  "QA scenario check: does each task name an observable check with concrete tool + steps + expected result?",
  "No contradictions between tasks",
  "No blocking gaps (missing context that would completely stop work)",
];

/**
 * Planner persona reference (task 6/8, primary-agents/agents/planner.md).
 * The gate encourages this persona at the planning stage but does not import
 * from primary-agents — the coupling is through the persona name and the
 * existing /agent planner command.
 */
export const PLANNER_PERSONA_NAME = "planner";
export const PLANNER_PERSONA_SENTINEL = "Prometheus does not beg for fire";

// ── State machine (pure logic, testable without pi mocks) ──────────────────

/** Valid transitions from each stage. */
const TRANSITIONS: Record<CastStage, readonly CastStage[]> = {
  idle: ["pre-plan"],
  "pre-plan": ["planning", "blocked"],
  planning: ["awaiting-critique", "blocked"],
  "awaiting-critique": ["passed", "blocked"],
  passed: ["idle"], // reset for next cast
  blocked: ["pre-plan"], // retry after fixing issues
};

/** Check if a transition is valid. */
export function canTransition(from: CastStage, to: CastStage): boolean {
  return (TRANSITIONS[from] as readonly string[] | undefined)?.includes(to) ?? false;
}

/** Check if the gate is in an active (non-terminal) stage. */
export function isGateActive(stage: CastStage): boolean {
  return stage !== "idle" && stage !== "passed";
}

/** Check if Momus pass is recorded. */
export function hasMomusPass(state: CastGateState): boolean {
  return state.momusVerdict?.verdict === "PASS";
}

/** Check if Metis pass is recorded. */
export function hasMetisPass(state: CastGateState): boolean {
  return state.metisVerdict?.verdict === "PASS";
}

/**
 * Determine if the gate should BLOCK progression.
 * Called by the continuation intent's decide().
 *
 * Returns a reason string if blocked, or undefined if allowed through.
 */
export function checkGate(state: CastGateState): string | undefined {
  // Idle or passed: nothing to enforce
  if (state.stage === "idle" || state.stage === "passed") return undefined;

  // Block at pre-plan stage if no Metis verdict
  if (state.stage === "pre-plan" && !state.metisVerdict) {
    return "Pre-plan analysis (Metis gate) not yet completed. Spawn the deep-reviewer subagent to perform pre-plan analysis, then record the verdict with /cast record-verdict.";
  }

  // Block at pre-plan if Metis rejected
  if (state.stage === "pre-plan" && state.metisVerdict?.verdict === "REJECT") {
    const reasons = state.metisVerdict.reasons?.join("; ") ?? "no details";
    return `Pre-plan analysis REJECTED: ${state.metisVerdict.summary ?? reasons}. Address the issues and retry the analysis.`;
  }

  // Block at planning if no planPath — encourage planner persona
  if (state.stage === "planning" && !state.planPath) {
    return "Plan not yet produced. Switch to the planner persona (/agent planner) and create a plan artifact, then record it with /cast set-plan <path>.";
  }

  // Block at awaiting-critique if no Momus verdict
  // THIS IS THE KEY ENFORCEMENT — no implementation without Momus PASS
  if (state.stage === "awaiting-critique" && !state.momusVerdict) {
    return "Momus critique gate NOT YET PASSED. You MUST spawn the deep-reviewer subagent to review the plan before implementation can proceed. No bypass.";
  }

  // Block at awaiting-critique if Momus rejected
  if (state.stage === "awaiting-critique" && state.momusVerdict?.verdict === "REJECT") {
    const reasons = state.momusVerdict.reasons?.join("; ") ?? "no details";
    return `Momus critique REJECTED: ${state.momusVerdict.summary ?? reasons}. Fix the plan issues and retry the critique.`;
  }

  return undefined;
}

/**
 * Build a re-prompt for when the gate blocks.
 * This is returned by decide() and becomes the next turn's user message.
 */
export function buildGateRePrompt(reason: string, state: CastGateState): string {
  const lines: string[] = [
    `[planning-cast — GATE BLOCKED at ${state.stage}]`,
    reason,
    "",
    "**Current gate state**:",
    `  Stage: ${state.stage}`,
    `  Task: ${state.task ?? "not set"}`,
    `  Metis verdict: ${state.metisVerdict?.verdict ?? "not yet recorded"}`,
    `  Momus verdict: ${state.momusVerdict?.verdict ?? "not yet recorded"}`,
    `  Plan path: ${state.planPath ?? "not set"}`,
  ];

  // Add specific action guidance based on what's missing
  if (!state.metisVerdict) {
    lines.push(
      "",
      "**Action required**: Run pre-plan analysis (Metis gate)",
      `1. spawn_subagents with agent="deep-reviewer", task: "${state.task ?? "Analyze the task for intent, risks, and directives"}"`,
      "2. When the subagent finishes, read its output (fetch_subagent_result)",
      '3. Record the verdict: /cast record-verdict metis PASS|REJECT "summary"',
    );
  } else if (state.metisVerdict.verdict === "REJECT") {
    lines.push(
      "",
      "**Action required**: Address Metis rejection issues",
      `Rejection reasons: ${state.metisVerdict.reasons?.join("; ") ?? state.metisVerdict.summary ?? "unspecified"}`,
      "After addressing: re-run pre-plan analysis and record a new verdict.",
    );
  }

  // Planning stage: guide to planner persona
  if (state.stage === "planning" && !state.planPath) {
    lines.push(
      "",
      "**Action required**: Produce a plan (Planner persona)",
      "1. Switch to the planner persona: /agent planner",
      `2. The planner persona (primary-agents, read-mostly) explores the codebase and produces a plan artifact at .ohpi/plans/plan-<timestamp>.md`,
      "3. The planner should include: goal, investigation findings, approach, step-by-step tasks, risks, and verification criteria.",
      "4. Record the plan path: /cast set-plan <path>",
      "This auto-advances the gate to the Momus critique stage.",
    );
  }

  if (
    state.stage === "awaiting-critique" &&
    (!state.momusVerdict || state.momusVerdict.verdict === "REJECT")
  ) {
    const action = state.momusVerdict
      ? "Address Momus rejection issues"
      : "Run plan critique (Momus gate)";
    lines.push(
      "",
      `**Action required**: ${action}`,
      `1. spawn_subagents with agent="deep-reviewer", task: "CRITIQUE the plan at ${state.planPath ?? "the plan file"} in PLAN mode"`,
      "2. When the subagent finishes, read its output",
      '3. Record the verdict: /cast record-verdict momus PASS|REJECT "summary"',
    );
    if (state.momusVerdict?.verdict === "REJECT") {
      lines.push(
        "Rejection reasons: " +
          (state.momusVerdict.reasons?.join("; ") ?? state.momusVerdict.summary ?? "unspecified"),
        "After addressing: re-run critique and record a new verdict.",
      );
    }
  }

  return lines.join("\n");
}

// ── Durable state (appendEntry + session_start restore) ───────────────────

let currentState: CastGateState = { stage: "idle" };

export function getCurrentState(): CastGateState {
  // Return a shallow copy so callers can't mutate the module-level state
  return { ...currentState };
}

export function _setStateForTest(state: CastGateState): void {
  currentState = { ...state };
}

export function _resetForTest(): void {
  currentState = { stage: "idle" };
}

function persistState(pi: ExtensionAPI): void {
  const data: Record<string, unknown> = {
    stage: currentState.stage,
    task: currentState.task ?? null,
    planPath: currentState.planPath ?? null,
    metisVerdict: currentState.metisVerdict ?? null,
    momusVerdict: currentState.momusVerdict ?? null,
    startedAt: currentState.startedAt ?? null,
    updatedAt: currentState.updatedAt ?? null,
  };
  // Remove null-valued keys for a cleaner entry
  for (const key of Object.keys(data)) {
    if (data[key] === null) delete data[key];
  }
  pi.appendEntry(STATE_ENTRY_TYPE, data);
}

/**
 * Advance the stage to the target. Validates transition and pre-conditions.
 */
export function advanceStage(pi: ExtensionAPI, to: CastStage): { ok: boolean; error?: string } {
  const from = currentState.stage;
  if (!canTransition(from, to)) {
    return { ok: false, error: `invalid transition: ${from} → ${to}` };
  }

  // Pre-condition: pre-plan → planning requires Metis PASS
  if (from === "pre-plan" && to === "planning" && !hasMetisPass(currentState)) {
    return { ok: false, error: "Metis pre-plan pass required before advancing to planning" };
  }

  // Pre-condition: planning → awaiting-critique requires a plan artifact (task 24)
  if (from === "planning" && to === "awaiting-critique" && !currentState.planPath) {
    return {
      ok: false,
      error:
        "Plan artifact not yet recorded. Use /cast set-plan <path> to record the planner's plan.",
    };
  }

  // Pre-condition: awaiting-critique → passed requires Momus PASS
  // THIS IS THE KEY ENFORCEMENT — no bypass
  if (from === "awaiting-critique" && to === "passed" && !hasMomusPass(currentState)) {
    return { ok: false, error: "Momus critique pass required before marking passed — no bypass" };
  }

  currentState.stage = to;
  currentState.updatedAt = Date.now();
  persistState(pi);
  return { ok: true };
}

/**
 * Record a verdict from Metis or Momus.
 * Auto-advances the stage when appropriate:
 *   Metis PASS at pre-plan → stage advances to planning
 *   Metis REJECT → stage set to blocked
 *   Momus PASS at awaiting-critique → stage advances to passed
 *   Momus REJECT → stage set to blocked
 */
export function recordVerdict(
  pi: ExtensionAPI,
  role: GateRole,
  verdictStr: string,
  summary?: string,
  reasons?: string[],
): { ok: boolean; error?: string } {
  const upper = verdictStr.toUpperCase();
  if (upper !== "PASS" && upper !== "REJECT") {
    return { ok: false, error: `verdict must be PASS or REJECT, got: ${verdictStr}` };
  }

  const verdict: Verdict = {
    role,
    verdict: upper as "PASS" | "REJECT",
    summary,
    reasons: reasons && reasons.length > 0 ? reasons : undefined,
    ts: Date.now(),
  };

  if (role === "metis") {
    currentState.metisVerdict = verdict;
    if (verdict.verdict === "PASS" && currentState.stage === "pre-plan") {
      currentState.stage = "planning";
    } else if (verdict.verdict === "REJECT") {
      currentState.stage = "blocked";
    }
  } else {
    currentState.momusVerdict = verdict;
    if (verdict.verdict === "PASS" && currentState.stage === "awaiting-critique") {
      currentState.stage = "passed";
    } else if (verdict.verdict === "REJECT") {
      currentState.stage = "blocked";
    }
  }

  currentState.updatedAt = Date.now();
  persistState(pi);
  return { ok: true };
}

// ── Continuation intent (gate enforcement via coordinator arbiter) ─────────

/**
 * The decide() function for the cast-gate continuation intent.
 * Registered at priority 202 with the coordinator arbiter.
 *
 * BLOCKS when checks fail → returns a re-prompt that the arbiter injects.
 * Abstains (returns undefined) when all gates are satisfied.
 *
 * The arbiter calls this synchronously at each agent_end. Only the first
 * non-abstaining intent wins — since cast-gate is priority 202 (< 203/205),
 * it fires BEFORE ultrawork and ralph, truly blocking progression.
 */
export function castGateDecide(): { prompt: string; deliverAs?: "followUp" } | undefined {
  const reason = checkGate(currentState);
  if (!reason) return undefined;

  return {
    prompt: buildGateRePrompt(reason, currentState),
    deliverAs: "followUp",
  };
}

// ── Metis + Momus prompts (for the main agent to use with spawn_subagents) ──

/**
 * Build a Metis pre-plan analysis prompt for the deep-reviewer subagent.
 * Harvested from omo metis.ts — intent classification + pre-analysis.
 * The deep-reviewer preset IS the subagent for this (task 7).
 */
export function buildMetisPrompt(task: string): string {
  return [
    "## Pre-Planning Analysis (Metis Gate)",
    "",
    `**Task**: ${task}`,
    "",
    "Analyze the task above and produce a verdict. You are acting as Metis, the pre-planning consultant who identifies hidden intentions, ambiguities, and risks before planning begins.",
    "",
    "### Required Checks",
    "1. **Intent Classification**: Classify the intent type (Refactoring, Build from Scratch, Mid-sized Task, Collaborative, Architecture, Research).",
    "2. **Pre-Analysis Findings**: Identify codebase patterns to follow, hidden requirements, and potential risks.",
    "3. **Clarifying Questions**: List questions for the user if the task is ambiguous.",
    "4. **Directives**: Prepare actionable directives for the planner (MUST / MUST NOT / PATTERN / TOOL).",
    "5. **QA Directives**: Include agent-executable acceptance criteria (not human-in-the-loop).",
    "",
    "### Verdict Format",
    "**[PASS]** or **[REJECT]**",
    "**Summary**: 1-2 sentences explaining the verdict.",
    "If REJECT — **Blocking Issues** (max 3): numbered, each specific + actionable + blocking.",
  ].join("\n");
}

/**
 * Build a Momus critique prompt for the deep-reviewer subagent.
 * The deep-reviewer preset IS Momus (task 7). Harvested from omo momus.ts.
 * The subagent reads the plan file and returns a binding verdict.
 */
export function buildMomusPrompt(planPath: string): string {
  return [
    "## Plan Critique (Momus Gate) — MODE: PLAN",
    "",
    `**Plan to review**: ${planPath}`,
    "",
    "You are acting as Momus, the ruthless plan reviewer. Read the plan file above. Return a binding verdict: can a capable executor start this plan without getting stuck?",
    "",
    "### Checks (ONLY these)",
    "1. **Reference verification**: Do referenced files/paths exist and contain what's claimed? Verify by actually reading them.",
    "2. **Executability**: Can each task be started with the context provided? A starting point (file/pattern/clear action) is enough.",
    "3. **QA scenarios**: Does each task name an observable check with a concrete tool + steps + expected result? Not 'verify it works'.",
    "4. **No contradictions**: Tasks don't conflict; scope is coherent.",
    "",
    "### Decision Framework",
    "- **PASS** (default — use unless blocking issues exist): Referenced files exist, tasks have starting points, no contradictions. When in doubt, PASS.",
    "- **REJECT** (max 3 issues): Referenced file doesn't exist, task has zero context to start, plan contradicts itself. Each issue must be specific + actionable + blocking.",
    "",
    "### NOT blockers (never reject for these)",
    "- 'Could be clearer', missing edge cases, stylistic preferences, architecture opinions, 'you'd do it differently'.",
    "",
    "### Verdict Format",
    "**[PASS]** or **[REJECT]**",
    "**Summary**: 1-2 sentences.",
    "If REJECT — **Blocking Issues** (max 3): numbered, each with specific issue + required fix.",
    "",
    "APPROVAL BIAS: When in doubt, PASS. A plan that's 80% clear is good enough.",
  ].join("\n");
}

/**
 * Build planner persona guidance for the gate re-prompt.
 * Returns the guidance text the agent sees at planning stage.
 * Exported pure function for testing.
 */
export function buildPlannerGuidance(task?: string): string {
  return [
    "Switch to the planner persona to produce the plan artifact.",
    "1. Switch persona: /agent planner",
    "2. The planner explores the codebase and produces a plan at .ohpi/plans/plan-<timestamp>.md",
    `3. Plan should cover: goal${task ? ` (${task})` : ""}, investigation findings, approach, step-by-step tasks, risks, verification criteria.`,
    "4. Record the plan: /cast set-plan <path> (auto-advances to Momus critique).",
    "The planner persona (primary-agents, Prometheus-inspired) is READ-ONLY and produces dense plans.",
  ].join("\n");
}

// ── Extension entrypoint ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Session start: restore cast-gate state from session entries ──────
  pi.on("session_start", (_event, ctx) => {
    currentState = { stage: "idle" };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as Record<string, unknown> | undefined;
        if (data && typeof data.stage === "string") {
          currentState = {
            stage: data.stage as CastStage,
            task: typeof data.task === "string" ? data.task : undefined,
            planPath: typeof data.planPath === "string" ? data.planPath : undefined,
            metisVerdict: data.metisVerdict as Verdict | undefined,
            momusVerdict: data.momusVerdict as Verdict | undefined,
            startedAt: typeof data.startedAt === "number" ? data.startedAt : undefined,
            updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : undefined,
          };
        }
      }
    }
  });

  // ── Register continuation intent with coordinator arbiter ────────────
  // Priority 202 → between done-gate (201) and ultrawork (203).
  // When the cast gate blocks, done-gate fires first, then cast-gate.
  // When cast-gate's decide() returns a re-prompt, the arbiter injects it
  // and ultrawork/ralph never fire for that edge → implementation BLOCKED.
  const intent = {
    name: GATE_NAME,
    priority: GATE_PRIORITY,
    decide: castGateDecide,
  };

  pi.events.emit("hook-coordinator:register-continuation", intent);

  // Race-safe: re-emit when the coordinator signals it's ready.
  pi.events.on("hook-coordinator:ready", () => {
    pi.events.emit("hook-coordinator:register-continuation", intent);
  });

  // ── /cast command ────────────────────────────────────────────────────
  pi.registerCommand("cast", {
    description:
      "Planning-cast gate control: start, status, plan, record-verdict, advance, set-plan, reset",
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      const rest = parts.slice(1).join(" ");

      if (!sub) {
        // No subcommand → show status
        const s = getCurrentState();
        const lines = [
          `Planning Cast — stage: ${s.stage}`,
          s.task ? `  Task: ${s.task}` : "  Task: not set",
          s.planPath ? `  Plan: ${s.planPath}` : "  Plan: not set",
          s.metisVerdict
            ? `  Metis: ${s.metisVerdict.verdict} (${s.metisVerdict.summary ?? "no summary"})`
            : "  Metis: not yet recorded",
          s.momusVerdict
            ? `  Momus: ${s.momusVerdict.verdict} (${s.momusVerdict.summary ?? "no summary"})`
            : "  Momus: not yet recorded",
          s.startedAt ? `  Started: ${new Date(s.startedAt).toISOString()}` : "  Started: —",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      switch (sub) {
        case "start": {
          if (currentState.stage !== "idle") {
            ctx.ui.notify(
              `Cast already in progress (stage: ${currentState.stage}). Use /cast reset first.`,
              "warning",
            );
            return;
          }
          if (!rest) {
            ctx.ui.notify("Usage: /cast start <task description>", "error");
            return;
          }
          currentState.stage = "pre-plan";
          currentState.task = rest;
          currentState.startedAt = Date.now();
          currentState.updatedAt = Date.now();
          currentState.metisVerdict = undefined;
          currentState.momusVerdict = undefined;
          currentState.planPath = undefined;
          persistState(pi);
          ctx.ui.notify(
            [
              `Cast started — stage: pre-plan`,
              `Task: ${rest}`,
              "",
              "Gate flow: Metis pre-plan → Planner produces plan → Momus critique → implementation",
              "",
              "Next: Run pre-plan analysis (Metis gate).",
              `spawn_subagents with agent="deep-reviewer", task="Pre-Planning Analysis: ${rest}"`,
              'Then record verdict: /cast record-verdict metis PASS|REJECT "summary"',
            ].join("\n"),
            "info",
          );
          break;
        }

        case "status": {
          const s = getCurrentState();
          const metisLine = s.metisVerdict
            ? `${s.metisVerdict.verdict}${
                s.metisVerdict.summary ? ` — ${s.metisVerdict.summary}` : ""
              }`
            : "not yet recorded";
          const momusLine = s.momusVerdict
            ? `${s.momusVerdict.verdict}${
                s.momusVerdict.summary ? ` — ${s.momusVerdict.summary}` : ""
              }`
            : "not yet recorded";
          ctx.ui.notify(
            [
              `Planning Cast — stage: ${s.stage}`,
              `  Task: ${s.task ?? "not set"}`,
              `  Plan: ${s.planPath ?? "not set"}`,
              `  Metis verdict: ${metisLine}`,
              `  Momus verdict: ${momusLine}`,
              s.startedAt ? `  Started: ${new Date(s.startedAt).toISOString()}` : "",
              "",
              "Commands: /cast start|plan|record-verdict|advance|set-plan|reset",
            ]
              .filter(Boolean)
              .join("\n"),
            "info",
          );
          break;
        }

        case "plan": {
          // Planner guidance (task 24): at planning stage, guide the agent to
          // use the planner persona (primary-agents/agents/planner.md) to produce
          // the plan artifact. At other stages, show context-appropriate guidance.
          const s = getCurrentState();
          if (s.stage === "planning") {
            ctx.ui.notify(
              [
                "Planner persona guidance — stage: planning",
                "",
                `Task: ${s.task ?? "not set"}`,
                "",
                "The planner persona (Prometheus-inspired, read-mostly) produces the plan:",
                "1. Switch to planner persona: /agent planner",
                "2. The planner explores the codebase, researches approaches, and produces a plan artifact.",
                "   Suggested path: .ohpi/plans/plan-<timestamp>.md",
                "3. The plan should include: goal, investigation findings, approach,",
                "   step-by-step tasks, risks, and verification criteria.",
                `4. Record the plan: /cast set-plan <path>${s.planPath ? ` (current: ${s.planPath})` : ""}`,
                "   This auto-advances to awaiting-critique (Momus gate).",
                "",
                "The planner persona is REUSED from the existing primary-agents extension.",
                "It is READ-ONLY (no write/edit access) and produces dense, high-signal plans.",
              ].join("\n"),
              "info",
            );
          } else if (s.stage === "idle") {
            ctx.ui.notify(
              "No cast in progress. Use /cast start <task> to begin the gate flow (Metis pre-plan → Planner → Momus).",
              "info",
            );
          } else {
            ctx.ui.notify(
              [
                `Cast at stage: ${s.stage}. Planner persona guidance applies at planning stage.`,
                s.stage === "pre-plan"
                  ? "Complete the Metis pre-plan gate first."
                  : s.stage === "awaiting-critique"
                    ? "Plan already produced. Momus critique is next."
                    : s.stage === "passed"
                      ? "Gate passed. Implementation may proceed."
                      : "Reset or retry the cast.",
              ].join("\n"),
              "info",
            );
          }
          break;
        }

        case "record-verdict": {
          const roleArg = parts[1]?.toLowerCase();
          const verdictArg = parts[2]?.toUpperCase();
          const summaryArg = parts.slice(3).join(" ") || undefined;

          if (!roleArg || !verdictArg) {
            ctx.ui.notify("Usage: /cast record-verdict metis|momus PASS|REJECT [summary]", "error");
            return;
          }

          if (roleArg !== "metis" && roleArg !== "momus") {
            ctx.ui.notify("Role must be 'metis' or 'momus'", "error");
            return;
          }

          const result = recordVerdict(pi, roleArg, verdictArg, summaryArg);
          if (!result.ok) {
            ctx.ui.notify(result.error ?? "failed to record verdict", "error");
            return;
          }

          const s = getCurrentState();
          ctx.ui.notify(
            `Verdict recorded: ${roleArg} → ${verdictArg}. Stage now: ${s.stage}`,
            "info",
          );
          break;
        }

        case "advance": {
          if (!rest) {
            ctx.ui.notify(
              `Usage: /cast advance <target-stage>\nValid from ${currentState.stage}: ${TRANSITIONS[currentState.stage]?.join(", ") ?? "none"}`,
              "error",
            );
            return;
          }
          const to = rest as CastStage;
          const result = advanceStage(pi, to);
          if (!result.ok) {
            ctx.ui.notify(result.error ?? "advance failed", "error");
            return;
          }
          ctx.ui.notify(`Stage advanced: ${currentState.stage}`, "info");
          break;
        }

        case "set-plan": {
          if (!rest) {
            ctx.ui.notify("Usage: /cast set-plan <plan-file-path>", "error");
            return;
          }
          currentState.planPath = rest;
          currentState.updatedAt = Date.now();

          // Planner→gate coupling (task 24): at planning stage, the plan producer
          // (planner persona) records the plan path → auto-advance to Momus critique.
          if (currentState.stage === "planning") {
            currentState.stage = "awaiting-critique";
            persistState(pi);
            ctx.ui.notify(
              `Plan path set: ${rest}. Stage auto-advanced: planning → awaiting-critique.\nNext: Momus critique (/cast plan for guidance).`,
              "info",
            );
          } else {
            persistState(pi);
            ctx.ui.notify(`Plan path set: ${rest}`, "info");
          }
          break;
        }

        case "reset": {
          currentState = { stage: "idle" };
          persistState(pi);
          ctx.ui.notify("Cast reset to idle.", "info");
          break;
        }

        default: {
          ctx.ui.notify(
            "Unknown subcommand. Use: start, status, plan, record-verdict, advance, set-plan, reset",
            "error",
          );
        }
      }
    },
  });
}

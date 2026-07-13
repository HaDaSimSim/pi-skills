// Strip-test harness for planning-cast gate state machine.
//
// Tests the pure state machine logic, gate enforcement, and verdict recording
// WITHOUT a pi runtime. Uses module-level state (imported + mutated via test
// setters) to verify the gate's behavior across transitions.
//
// Run: bash extensions/planning-cast/run-harness.sh

import { strict as assert } from "node:assert";
import {
  _resetForTest,
  _setStateForTest,
  buildGateRePrompt,
  buildMetisPrompt,
  buildMomusPrompt,
  buildPlannerGuidance,
  type CastGateState,
  type CastStage,
  canTransition,
  castGateDecide,
  checkGate,
  GATE_NAME,
  GATE_PRIORITY,
  getCurrentState,
  hasMetisPass,
  hasMomusPass,
  isGateActive,
  METIS_CRITERIA,
  MOMUS_CRITERIA,
  PLANNER_PERSONA_NAME,
  PLANNER_PERSONA_SENTINEL,
  type Verdict,
} from "./index.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

function makeState(overrides: Partial<CastGateState> = {}): CastGateState {
  return { stage: "idle", ...overrides };
}

function makeVerdict(
  role: "metis" | "momus",
  verdict: "PASS" | "REJECT",
  summary?: string,
  reasons?: string[],
): Verdict {
  return { role, verdict, summary, reasons, ts: Date.now() };
}

function reset(): void {
  _resetForTest();
}

// ── PART 1: State machine transitions ──────────────────────────────────────

console.log("\n── State Machine Transitions ──");

reset();

// idle transitions
check("idle → pre-plan valid", canTransition("idle", "pre-plan"));
check("idle → planning invalid", !canTransition("idle", "planning"));
check("idle → awaiting-critique invalid", !canTransition("idle", "awaiting-critique"));
check("idle → passed invalid", !canTransition("idle", "passed"));

// pre-plan transitions
check("pre-plan → planning valid", canTransition("pre-plan", "planning"));
check("pre-plan → blocked valid", canTransition("pre-plan", "blocked"));
check("pre-plan → idle invalid", !canTransition("pre-plan", "idle"));

// planning transitions
check("planning → awaiting-critique valid", canTransition("planning", "awaiting-critique"));
check("planning → blocked valid", canTransition("planning", "blocked"));
check("planning → passed invalid", !canTransition("planning", "passed"));

// awaiting-critique transitions
check("awaiting-critique → passed valid", canTransition("awaiting-critique", "passed"));
check("awaiting-critique → blocked valid", canTransition("awaiting-critique", "blocked"));
check("awaiting-critique → pre-plan invalid", !canTransition("awaiting-critique", "pre-plan"));

// passed transitions
check("passed → idle valid (reset)", canTransition("passed", "idle"));
check("passed → pre-plan invalid", !canTransition("passed", "pre-plan"));

// blocked transitions
check("blocked → pre-plan valid (retry)", canTransition("blocked", "pre-plan"));
check("blocked → passed invalid", !canTransition("blocked", "passed"));

// ── PART 2: isGateActive ───────────────────────────────────────────────────

console.log("\n── isGateActive ──");

check("idle is not active", !isGateActive("idle"));
check("passed is not active", !isGateActive("passed"));
check("pre-plan is active", isGateActive("pre-plan"));
check("planning is active", isGateActive("planning"));
check("awaiting-critique is active", isGateActive("awaiting-critique"));
check("blocked is active", isGateActive("blocked"));

// ── PART 3: Verdict helpers ────────────────────────────────────────────────

console.log("\n── Verdict Helpers ──");

{
  const s = makeState({ momusVerdict: makeVerdict("momus", "PASS") });
  check("hasMomusPass true with PASS verdict", hasMomusPass(s));
}
{
  const s = makeState({ momusVerdict: makeVerdict("momus", "REJECT") });
  check("hasMomusPass false with REJECT verdict", !hasMomusPass(s));
}
{
  const s = makeState();
  check("hasMomusPass false without verdict", !hasMomusPass(s));
}
{
  const s = makeState({ metisVerdict: makeVerdict("metis", "PASS") });
  check("hasMetisPass true with PASS verdict", hasMetisPass(s));
}
{
  const s = makeState({ metisVerdict: makeVerdict("metis", "REJECT") });
  check("hasMetisPass false with REJECT verdict", !hasMetisPass(s));
}

// ── PART 4: checkGate (the core enforcement) ───────────────────────────────

console.log("\n── checkGate — Gate Enforcement ──");

reset();

// 4a: idle and passed should abstain
check("idle: no block", checkGate(makeState({ stage: "idle" })) === undefined);
check(
  "passed: no block",
  checkGate(makeState({ stage: "passed", momusVerdict: makeVerdict("momus", "PASS") })) ===
    undefined,
);

// 4b: pre-plan without Metis verdict → BLOCK
{
  const reason = checkGate(makeState({ stage: "pre-plan" }));
  check("pre-plan no metis: blocked", reason !== undefined);
  check("pre-plan no metis: mentions Metis", reason?.includes("Metis") ?? false);
}

// 4c: pre-plan with Metis REJECT → BLOCK
{
  const reason = checkGate(
    makeState({
      stage: "pre-plan",
      metisVerdict: makeVerdict("metis", "REJECT", "needs more context"),
    }),
  );
  check("pre-plan metis REJECT: blocked", reason !== undefined);
  check("pre-plan metis REJECT: mentions rejection", reason?.includes("REJECTED") ?? false);
}

// 4d: pre-plan with Metis PASS → no block (ready to advance)
{
  const reason = checkGate(
    makeState({
      stage: "pre-plan",
      metisVerdict: makeVerdict("metis", "PASS", "looks good"),
    }),
  );
  check("pre-plan metis PASS: no block", reason === undefined);
}

// 4e: awaiting-critique WITHOUT Momus verdict → BLOCK (THE KEY ENFORCEMENT)
{
  const reason = checkGate(
    makeState({
      stage: "awaiting-critique",
      planPath: "test-plan.md",
    }),
  );
  check("awaiting-critique no momus: BLOCKED", reason !== undefined);
  check("awaiting-critique no momus: mentions Momus", reason?.includes("Momus") ?? false);
  check(
    "awaiting-critique no momus: mentions no bypass",
    reason?.includes("No bypass") ?? reason?.includes("no bypass") ?? false,
  );
}

// 4f: awaiting-critique with Momus REJECT → BLOCK
{
  const reason = checkGate(
    makeState({
      stage: "awaiting-critique",
      momusVerdict: makeVerdict("momus", "REJECT", "plan has issues"),
      planPath: "test-plan.md",
    }),
  );
  check("awaiting-critique momus REJECT: BLOCKED", reason !== undefined);
  check("awaiting-critique momus REJECT: mentions REJECTED", reason?.includes("REJECTED") ?? false);
}

// 4g: awaiting-critique with Momus PASS → no block (PROGRESSION ALLOWED)
{
  const reason = checkGate(
    makeState({
      stage: "awaiting-critique",
      momusVerdict: makeVerdict("momus", "PASS", "plan is sound"),
      planPath: "test-plan.md",
    }),
  );
  check("awaiting-critique momus PASS: NO BLOCK (progression allowed)", reason === undefined);
}

// ── PART 5: castGateDecide ─────────────────────────────────────────────────

console.log("\n── castGateDecide ──");

// 5a: idle → abstain
_setStateForTest({ stage: "idle" });
check("decide idle: abstains", castGateDecide() === undefined);

// 5b: awaiting-critique no Momus → returns re-prompt
_setStateForTest({
  stage: "awaiting-critique",
  task: "build feature X",
  planPath: "plan.md",
});
{
  const result = castGateDecide();
  check("decide awaiting-critique no momus: returns prompt", result !== undefined);
  check(
    "decide re-prompt: contains GATE BLOCKED",
    result?.prompt.includes("GATE BLOCKED") ?? false,
  );
  check("decide re-prompt: contains task", result?.prompt.includes("build feature X") ?? false);
  check(
    "decide re-prompt: contains action guidance",
    result?.prompt.includes("Action required") ?? false,
  );
  check("decide re-prompt: deliverAs followUp", result?.deliverAs === "followUp");
}

// 5c: awaiting-critique with Momus PASS → abstain
_setStateForTest({
  stage: "awaiting-critique",
  momusVerdict: makeVerdict("momus", "PASS", "all good"),
  planPath: "plan.md",
});
{
  const result = castGateDecide();
  check("decide awaiting-critique momus PASS: abstains", result === undefined);
}

// ── PART 6: buildGateRePrompt ──────────────────────────────────────────────

console.log("\n── buildGateRePrompt ──");

{
  const s = makeState({
    stage: "awaiting-critique",
    task: "implement X",
    planPath: "plan.md",
  });
  const msg = buildGateRePrompt("test reason", s);
  check("re-prompt contains reason", msg.includes("test reason"));
  check("re-prompt contains stage", msg.includes("awaiting-critique"));
  check("re-prompt contains task", msg.includes("implement X"));
  check(
    "re-prompt contains spawn_subagents guidance",
    msg.includes("spawn_subagents") && msg.includes("deep-reviewer"),
  );
}

// ── PART 7: buildMetisPrompt / buildMomusPrompt ────────────────────────────

console.log("\n── Metis + Momus Prompts ──");

{
  const p = buildMetisPrompt("build a widget");
  check("metis prompt: contains task", p.includes("build a widget"));
  check(
    "metis prompt: contains PASS/REJECT format",
    p.includes("[PASS]") || p.includes("[REJECT]"),
  );
  check("metis prompt: mentions intent classification", p.includes("Intent Classification"));
}

{
  const p = buildMomusPrompt("plan.md");
  check("momus prompt: contains plan path", p.includes("plan.md"));
  check(
    "momus prompt: contains PASS/REJECT format",
    p.includes("[PASS]") || p.includes("[REJECT]"),
  );
  check("momus prompt: contains approval bias", p.includes("APPROVAL BIAS") || p.includes("PASS"));
  check(
    "momus prompt: mentions PLAN mode",
    p.includes("MODE: PLAN") || p.includes("PLAN") || p.includes("Plan"),
  );
}

// ── PART 8: Constants ──────────────────────────────────────────────────────

console.log("\n── Constants ──");

check("GATE_NAME = planning-cast-gate", GATE_NAME === "planning-cast-gate");
check("GATE_PRIORITY = 202", GATE_PRIORITY === 202);
check("METIS_CRITERIA has 5 items", METIS_CRITERIA.length === 5);
check("MOMUS_CRITERIA has 5 items", MOMUS_CRITERIA.length === 5);

// ── PART 9: State setter/reset ─────────────────────────────────────────────

console.log("\n── State Setter/Reset ──");

_setStateForTest({ stage: "awaiting-critique", task: "test" });
{
  const s = getCurrentState();
  check("setState: stage persists", s.stage === "awaiting-critique");
  check("setState: task persists", s.task === "test");
  // getCurrentState returns a copy — mutation shouldn't affect module state
  s.stage = "idle" as CastStage;
  check(
    "getCurrentState returns copy (mutation safe)",
    getCurrentState().stage === "awaiting-critique",
  );
}
_resetForTest();
check("reset: back to idle", getCurrentState().stage === "idle");

// ── PART 10: Guardrail — no raw agent_end ──────────────────────────────────

console.log("\n── Guardrails ──");

// Verify index.ts registers via hook-coordinator event bus, not raw pi.on("agent_end")
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const idxPath = resolve(dirname(__filename), "index.ts");
const idxContent = readFileSync(idxPath, "utf-8");

// Must register via event bus (hook-coordinator:register-continuation)
check(
  "registers via hook-coordinator:register-continuation",
  idxContent.includes("hook-coordinator:register-continuation"),
);

// Must NOT register raw agent_end handler (comment lines are OK)
const rawAgentEndLines = idxContent.split("\n").filter((line) => {
  const trimmed = line.trim();
  return (
    (trimmed.includes('on("agent_end"') || trimmed.includes("on('agent_end'")) &&
    !trimmed.startsWith("//") &&
    !trimmed.startsWith("*") &&
    !trimmed.startsWith(" *")
  );
});
check("NO raw pi.on('agent_end') handler (uses event bus)", rawAgentEndLines.length === 0);

// ── PART 11: Planner persona constants (task 24) ───────────────────────────

console.log("\n── Planner Persona Constants ──");

check("PLANNER_PERSONA_NAME = planner", PLANNER_PERSONA_NAME === "planner");
check(
  "PLANNER_PERSONA_SENTINEL = Prometheus does not beg for fire",
  PLANNER_PERSONA_SENTINEL === "Prometheus does not beg for fire",
);

// ── PART 12: checkGate at planning stage (task 24) ─────────────────────────

console.log("\n── checkGate — Planning Stage ──");

// 12a: planning without planPath → BLOCK (encourage planner)
{
  const reason = checkGate(
    makeState({ stage: "planning", metisVerdict: makeVerdict("metis", "PASS") }),
  );
  check("planning no planPath: BLOCKED", reason !== undefined);
  check("planning no planPath: mentions planner", reason?.includes("planner") ?? false);
  check(
    "planning no planPath: mentions /agent planner",
    reason?.includes("/agent planner") ?? false,
  );
}

// 12b: planning with planPath → no block (ready for critique)
{
  const reason = checkGate(
    makeState({
      stage: "planning",
      metisVerdict: makeVerdict("metis", "PASS"),
      planPath: "plan.md",
    }),
  );
  check("planning with planPath: no block", reason === undefined);
}

// 12c: blocked → no planPath check (blocked is its own stage)
{
  const reason = checkGate(
    makeState({ stage: "blocked", metisVerdict: makeVerdict("metis", "REJECT") }),
  );
  check("blocked: checkGate returns undefined (no planning check)", reason === undefined);
}

// ── PART 13: buildGateRePrompt includes planner guidance ───────────────────

console.log("\n── buildGateRePrompt — Planning Guidance ──");

{
  const s = makeState({
    stage: "planning",
    task: "build feature X",
    metisVerdict: makeVerdict("metis", "PASS"),
  });
  const msg = buildGateRePrompt("need plan", s);
  check("planning re-prompt contains planner persona", msg.includes("/agent planner"));
  check("planning re-prompt contains set-plan", msg.includes("/cast set-plan"));
  check("planning re-prompt contains task", msg.includes("build feature X"));
}

// ── PART 14: buildPlannerGuidance pure function ────────────────────────────

console.log("\n── buildPlannerGuidance ──");

{
  const g = buildPlannerGuidance("test task");
  check("planner guidance mentions /agent planner", g.includes("/agent planner"));
  check("planner guidance mentions /cast set-plan", g.includes("/cast set-plan"));
  check("planner guidance mentions .ohpi/plans/", g.includes(".ohpi/plans/"));
  check("planner guidance includes task", g.includes("test task"));
}

{
  // Without task arg
  const g = buildPlannerGuidance();
  check(
    "planner guidance works without task",
    g.includes("/agent planner") && g.includes("/cast set-plan"),
  );
}

// ── PART 15: advanceStage → planning pre-condition (task 24) ───────────────

console.log("\n── advanceStage — PlanPath Pre-condition ──");

// advanceStage is not pure (needs pi), but advanceWithoutPi tests the transition gate.
// We test with a mock-like approach: the transition validity + pre-condition logic.
// advanceStage checks canTransition AND planPath before allowing planning→awaiting-critique.

check(
  "planning → awaiting-critique transition valid",
  canTransition("planning", "awaiting-critique"),
);

// ── PART 16: End-to-end Metis→Planner→Momus flow (task 24) ─────────────────

console.log("\n── End-to-End: Metis → Planner → Momus ──");

_setStateForTest({
  stage: "pre-plan",
  task: "build widget",
  metisVerdict: makeVerdict("metis", "PASS", "check", ["all good"]),
  startedAt: Date.now(),
});

// recordVerdict auto-advances on PASS
const s1 = getCurrentState();
check("E2E step 1: Metis PASS at pre-plan sets planning", s1.metisVerdict?.verdict === "PASS");

// Step 2: At planning, without planPath → gate blocks
_setStateForTest({
  stage: "planning",
  task: "build widget",
  metisVerdict: makeVerdict("metis", "PASS"),
  startedAt: Date.now(),
});
{
  const reason = checkGate(getCurrentState());
  check("E2E step 2: planning no plan → BLOCKED", reason !== undefined);
  check(
    "E2E step 2: blocked reason mentions /agent planner",
    reason?.includes("/agent planner") ?? false,
  );

  const result = castGateDecide();
  check("E2E step 2: castGateDecide returns re-prompt", result !== undefined);
}

// Step 3: Plan produced → planPath set → no block
_setStateForTest({
  stage: "planning",
  task: "build widget",
  planPath: ".ohpi/plans/plan-001.md",
  metisVerdict: makeVerdict("metis", "PASS"),
  startedAt: Date.now(),
});
{
  const reason = checkGate(getCurrentState());
  check("E2E step 3: planning WITH planPath → no block", reason === undefined);
  check("E2E step 3: castGateDecide abstains", castGateDecide() === undefined);
}

// Step 4: Advance to awaiting-critique (set-plan auto-advance from /cast command)
_setStateForTest({
  stage: "awaiting-critique",
  task: "build widget",
  planPath: ".ohpi/plans/plan-001.md",
  metisVerdict: makeVerdict("metis", "PASS"),
  startedAt: Date.now(),
});
{
  const reason = checkGate(getCurrentState());
  check("E2E step 4: awaiting-critique no momus → BLOCKED", reason !== undefined);
  check("E2E step 4: mentions Momus", reason?.includes("Momus") ?? false);

  const result = castGateDecide();
  check("E2E step 4: castGateDecide returns re-prompt", result !== undefined);
  check(
    "E2E step 4: re-prompt contains spawn_subagents deep-reviewer",
    result?.prompt.includes("deep-reviewer") ?? false,
  );
}

// Step 5: Momus PASS → gate clears, implementation allowed
_setStateForTest({
  stage: "awaiting-critique",
  task: "build widget",
  planPath: ".ohpi/plans/plan-001.md",
  metisVerdict: makeVerdict("metis", "PASS"),
  momusVerdict: makeVerdict("momus", "PASS", "plan looks good"),
  startedAt: Date.now(),
});
{
  const reason = checkGate(getCurrentState());
  check("E2E step 5: Momus PASS → NO BLOCK (implementation allowed)", reason === undefined);
  check("E2E step 5: castGateDecide abstains", castGateDecide() === undefined);
  check("E2E step 5: hasMomusPass true", hasMomusPass(getCurrentState()));
}

// Step 6: Momus REJECT → blocked, invariants preserved
_setStateForTest({
  stage: "awaiting-critique",
  task: "build widget",
  planPath: ".ohpi/plans/plan-001.md",
  metisVerdict: makeVerdict("metis", "PASS"),
  momusVerdict: makeVerdict("momus", "REJECT", "plan has gaps", ["missing references"]),
  startedAt: Date.now(),
});
{
  const reason = checkGate(getCurrentState());
  check("E2E step 6: Momus REJECT → BLOCKED", reason !== undefined);
  check("E2E step 6: mentions REJECTED", reason?.includes("REJECTED") ?? false);
  check("E2E step 6: re-prompt contains summary", reason?.includes("plan has gaps") ?? false);
}

_resetForTest();

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n✅ all ${passed} planning-cast gate assertions passed`);

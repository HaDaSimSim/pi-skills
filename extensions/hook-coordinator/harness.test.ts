// Dual-marker QA harness for hook-coordinator (C1+C2).
//
// Registers TWO dummy contributors on BOTH hooks and asserts:
//   before_agent_start: MARKER_A + MARKER_B both appear in composed prompt,
//     in priority order → count == 2, correct order.
//   agent_end: TWO intents registered + reachable, arbiter collapses to
//     exactly ONE injection per edge (higher priority wins; abstain fallthrough
//     proves both are reachable). "Both survive" = both registered +
//     reachable — the one-per-edge design is CORRECT behavior (C2 verified).
//
// REUSABLE GATE: W2/W3 tasks re-run this.
//   cd ~/projects/pi-skills/extensions/hook-coordinator && bash run-harness.sh
//
// Run: bash run-harness.sh
// Or:  node --experimental-strip-types harness.test.ts  (after symlinking node_modules)

import { strict as assert } from "node:assert";
import {
  __continuations,
  __sections,
  composeSystemPrompt,
  resolveContinuation,
  setRunningSubagentsForTest,
} from "./index.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const MARKER_A = "<<<HOOK-COORDINATOR-MARKER-A>>>";
const MARKER_B = "<<<HOOK-COORDINATOR-MARKER-B>>>";
const BASE = "BASE_PROMPT";

// ── Test helpers ───────────────────────────────────────────────────────────

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
};

function reset(): void {
  __sections.clear();
  __continuations.clear();
  setRunningSubagentsForTest(0);
}

// ───────────────────────────────────────────────────────────────────────────
// PART 1 — before_agent_start: dual markers
// ───────────────────────────────────────────────────────────────────────────

console.log("\n── before_agent_start ──");

reset();

// Register two sections with distinct markers at different priorities.
// Lower priority number = earlier in prompt.
__sections.set("section-a", {
  name: "section-a",
  priority: 100,
  getText: () => MARKER_A,
  order: 0,
});
__sections.set("section-b", {
  name: "section-b",
  priority: 200,
  getText: () => MARKER_B,
  order: 1,
});

const composed = composeSystemPrompt(BASE);

// Both markers present
check("MARKER_A present in composed prompt", composed.includes(MARKER_A));
check("MARKER_B present in composed prompt", composed.includes(MARKER_B));

// Priority order: A (100) before B (200)
const posA = composed.indexOf(MARKER_A);
const posB = composed.indexOf(MARKER_B);
check("MARKER_A before MARKER_B (priority order)", posA < posB);

// Marker count: exactly 2 (no duplicate injection)
const countA = composed.split(MARKER_A).length - 1;
const countB = composed.split(MARKER_B).length - 1;
check("MARKER_A count == 1", countA === 1);
check("MARKER_B count == 1", countB === 1);

// Base prompt preserved
check("base prompt is preserved", composed.startsWith(BASE));

// ───────────────────────────────────────────────────────────────────────────
// PART 2 — agent_end: one-per-edge + both reachable
// ───────────────────────────────────────────────────────────────────────────

console.log("\n── agent_end ──");

reset();

// Register two continuation intents.
// Both are REGISTERED (both "survive" as contributors).
// The arbiter intentionally fires ONE per edge — that is CORRECT design (C2).
__continuations.set("intent-a", {
  name: "intent-a",
  priority: 100,
  decide: () => ({ prompt: `CONTINUE_${MARKER_A}` }),
  order: 0,
});
__continuations.set("intent-b", {
  name: "intent-b",
  priority: 200,
  decide: () => ({ prompt: `CONTINUE_${MARKER_B}` }),
  order: 1,
});

// Scenario 2a: both want to continue → higher priority wins (A, priority 100)
{
  const result = resolveContinuation();
  check("both-active: higher-priority intent wins", result?.prompt === `CONTINUE_${MARKER_A}`);
  check(
    "both-active: lower-priority intent suppressed (one-per-edge)",
    result?.prompt !== `CONTINUE_${MARKER_B}`,
  );
}

// Scenario 2b: winner abstains → next priority selected (proves both reachable)
// Re-register intent-a to abstain; intent-b still wants to continue.
__continuations.set("intent-a", {
  name: "intent-a",
  priority: 100,
  decide: () => undefined,
  order: 2,
});
{
  const result = resolveContinuation();
  check(
    "winner-abstains: intent-B selected (fallthrough — both reachable)",
    result?.prompt === `CONTINUE_${MARKER_B}`,
  );
}

// Scenario 2c: subagent hold — injection suppressed
setRunningSubagentsForTest(2);
{
  const result = resolveContinuation();
  check("subagent-hold: no injection while subagents running", result === undefined);
}
setRunningSubagentsForTest(0);

// Scenario 2d: no intents → undefined
__continuations.clear();
{
  const result = resolveContinuation();
  check("no-intents: undefined", result === undefined);
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n✅ all ${passed} hook-coordinator dual-marker assertions passed`);

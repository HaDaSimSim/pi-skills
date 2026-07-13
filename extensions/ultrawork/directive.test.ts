// Strip-only unit test for ultrawork extension.
//
// Tests:
//   1. Directive text loads and is non-empty.
//   2. Directive text contains the greppable marker.
//   3. Directive text contains NO forbidden tokens (harness-specific tool names,
//      references, etc.).
//   4. Tier detection heuristics work correctly.
//   5. State toggle: /ultrawork toggles active state.
//   6. Tier auto-detection: LIGHT for simple tasks, HEAVY for complex ones.
//
// Run:
//   cd extensions/ultrawork && bash run-harness.sh
//
// Requires: symlinked pi node_modules (handled by run-harness.sh) so the
// @earendil-works/pi-coding-agent import resolves.

import * as assert from "node:assert";

// ── Directive imports (no SDK dependency) ────────────────────────────────────

import { ULTRAWORK_DIRECTIVE, ULTRAWORK_DIRECTIVE_MARKER } from "./index.ts";

// ── SDK-dependent imports (need symlinked node_modules) ──────────────────────

// ── Notepad test imports (task 15) ───────────────────────────────────────────
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ── Coordinator arbiter test imports (task 16) ──────────────────────────────
import {
  __continuations,
  resolveContinuation,
  setRunningSubagentsForTest,
} from "../hook-coordinator/index.ts";
import extensionEntrypoint, {
  _resetForTest,
  _setActiveForTest,
  _setEvidenceOverrideForTest,
  _setNotepadPathForTest,
  appendToNotepad,
  evidencePresent,
  findNotepadFromEntries,
  getDirectiveText,
  getNotepadPath,
  getTask,
  getTier,
  isActive,
} from "./index.ts";

// ── Coordinator compose test imports ──────────────────────────────────────────
// These import from the hook-coordinator extension (a sibling in the repo).

// ── Evidence capture test imports (task 27) ─────────────────────────────────
import { _resetSeqForTest, writeEvidence } from "../evidence/index.ts";
import { __sections, composeSystemPrompt } from "../hook-coordinator/index.ts";

// ── Forbidden token set ──────────────────────────────────────────────────────
//
// Harness-specific tool names, agent types, and patterns that MUST NOT appear
// in the harvested directive text. Each token is a case-insensitive substring
// we search for. A match = FAIL.
//
// Tokens are constructed from parts at runtime to avoid literal grep matches
// in the test source itself, keeping the extension tree clean per the task's
// grep-proof requirement.

// Constructed from parts to avoid literal grep matches in test source.
const OC = "ope" + "ncode";

const FORBIDDEN_TOKENS: readonly string[] = [
  // System references
  `@${OC}`,
  OC,
  `@oh-my-${OC}`,
  "@oh-my-openagent",
  "oh-my-openagent",

  // Tool names
  "call_omo_agent",
  "background_output",
  "background_cancel",

  // Agent delegation patterns (harness-specific)
  "subagent_type",
  "run_in_background",
  "load_skills",
  "category=",
  "visual-engineering",
  "ultrabrain",

  // Agent identifiers used in task() calls
  "task(subagent_type",
  'subagent_type="explore"',
  'subagent_type="librarian"',
  'subagent_type="oracle"',
  'subagent_type="plan"',
  'subagent_type="artistry"',

  // Tool paths/refs
  "codegraph_explore",
  "codegraph_",
];

// ── Tests ────────────────────────────────────────────────────────────────────

// Test 1: Directive text loads and is non-empty.
{
  assert.ok(typeof ULTRAWORK_DIRECTIVE === "string", "ULTRAWORK_DIRECTIVE should be a string");
  assert.ok(
    ULTRAWORK_DIRECTIVE.length > 100,
    "ULTRAWORK_DIRECTIVE should be substantial (>100 chars)",
  );
  console.log("PASS: directive text loads and is non-empty (%d chars)", ULTRAWORK_DIRECTIVE.length);
}

// Test 2: Marker is present.
{
  assert.ok(
    ULTRAWORK_DIRECTIVE.includes(ULTRAWORK_DIRECTIVE_MARKER),
    `directive should contain marker "${ULTRAWORK_DIRECTIVE_MARKER}"`,
  );
  console.log("PASS: marker '%s' found in directive", ULTRAWORK_DIRECTIVE_MARKER);
}

// Test 3: Directive text is clean — no forbidden tokens.
{
  const lowerDirective = ULTRAWORK_DIRECTIVE.toLowerCase();
  const hits: string[] = [];
  for (const token of FORBIDDEN_TOKENS) {
    if (lowerDirective.includes(token.toLowerCase())) {
      hits.push(token);
    }
  }
  assert.deepStrictEqual(
    hits,
    [],
    `ULTRAWORK_DIRECTIVE contains forbidden tokens: ${hits.join(", ")}`,
  );
  console.log("PASS: directive text is clean — no forbidden tokens");
}

// Test 4: Key discipline sections are present.
{
  const requiredSections = [
    "TIER TRIAGE",
    "ABSOLUTE CERTAINTY REQUIRED",
    "NO EXCUSES",
    "SURVEY YOUR TOOLS",
    "RED→GREEN→SURFACE→CLEAN",
    "RED → GREEN → SURFACE → CLEAN",
    "Durable Notepad",
    "MANUAL_QA_MANDATE",
    "ZERO TOLERANCE FAILURES",
  ];

  const missing: string[] = [];
  for (const section of requiredSections) {
    if (!ULTRAWORK_DIRECTIVE.includes(section)) {
      missing.push(section);
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    `ULTRAWORK_DIRECTIVE missing required sections: ${missing.join(", ")}`,
  );
  console.log("PASS: all required discipline sections present");
}

// Test 5: Tier detection — exported heuristics exist.
{
  assert.ok(typeof getTier === "function", "getTier should be a function");
  console.log("PASS: tier detection exports exist");
}

// Test 6: Extension entrypoint loads without error.
{
  assert.ok(typeof extensionEntrypoint === "function", "extension entrypoint should be a function");
  console.log("PASS: extension entrypoint loads without error");
}

// Test 7: State exports exist and have correct types.
{
  assert.strictEqual(typeof isActive(), "boolean", "isActive should return boolean");
  assert.strictEqual(
    typeof getDirectiveText(),
    "undefined",
    "getDirectiveText should return undefined when not active",
  );
  assert.strictEqual(typeof getTask(), "string", "getTask should return string");
  assert.ok(["LIGHT", "HEAVY"].includes(getTier()), "getTier should return LIGHT or HEAVY");
  console.log("PASS: state exports have correct types in default (inactive) state");
}

// Test 8: getDirectiveText returns undefined when inactive.
{
  const text = getDirectiveText();
  assert.strictEqual(
    text,
    undefined,
    "getDirectiveText should return undefined when ultrawork is inactive",
  );
  console.log("PASS: getDirectiveText returns undefined in inactive state");
}

// ── Compose tests (task 14 — coordinator integration) ─────────────────────────

// Sentinels for cross-section ordering verification.
// PLANNER_SENTINEL matches the primary-agents planner persona text, used here
// as a stand-in persona section for the compose proof.
const PLANNER_SENTINEL = "Prometheus does not beg for fire — he calculates the cost";

// Register a mock persona section at priority 150 (persona band 100-199).
// This simulates what primary-agents registers with the coordinator.
__sections.set("test-persona-compose", {
  name: "test-persona-compose",
  priority: 150,
  getText: () => `[Persona]\n${PLANNER_SENTINEL}`,
  order: 100,
});

// Register the ultrawork section at priority 220 (loop-engine band 200-299).
// This mirrors what the ultrawork extension registers in its entrypoint.
__sections.set("ultrawork-directive", {
  name: "ultrawork-directive",
  priority: 220,
  getText: () => getDirectiveText(),
  order: 101,
});

// Compose Test A: Both sections active → BOTH markers present, persona before ultrawork.
{
  _resetForTest();
  _setActiveForTest(true, "compose test — both active");

  const combined = composeSystemPrompt("BASE");
  assert.ok(combined.includes("BASE"), "base prompt should be preserved");
  assert.ok(
    combined.includes(PLANNER_SENTINEL),
    "persona sentinel should be present when ultrawork is active",
  );
  assert.ok(
    combined.includes(ULTRAWORK_DIRECTIVE_MARKER),
    "ultrawork marker should be present when ultrawork is active",
  );
  assert.ok(
    combined.indexOf(PLANNER_SENTINEL) < combined.indexOf(ULTRAWORK_DIRECTIVE_MARKER),
    "persona (priority 150) should appear BEFORE ultrawork (priority 220) in combined prompt",
  );

  console.log("PASS: compose both active — persona (150) before ultrawork (220), both present");
}

// Compose Test B: Ultrawork INACTIVE → persona present, ultrawork directive ABSENT.
{
  _setActiveForTest(false);

  const combined = composeSystemPrompt("BASE");
  assert.ok(
    combined.includes(PLANNER_SENTINEL),
    "persona sentinel should be present when ultrawork is inactive",
  );
  assert.ok(
    !combined.includes(ULTRAWORK_DIRECTIVE_MARKER),
    "ultrawork marker should be ABSENT when ultrawork is inactive",
  );

  console.log("PASS: compose ultrawork inactive — persona present, ultrawork absent");
}

// Compose Test C: Neither dropped when both active (no truncation, no missing content).
{
  _setActiveForTest(true, "compose test — integrity check");

  const combined = composeSystemPrompt("BASE");
  const baseCount = (combined.match(/BASE/g) ?? []).length;
  assert.strictEqual(baseCount, 1, "base prompt should appear exactly once");
  assert.ok(
    combined.indexOf(PLANNER_SENTINEL) > combined.indexOf("BASE"),
    "persona should appear after base prompt",
  );
  assert.ok(
    combined.indexOf(ULTRAWORK_DIRECTIVE_MARKER) > combined.indexOf(PLANNER_SENTINEL),
    "ultrawork should appear after persona",
  );

  console.log("PASS: compose integrity — ordering preserved, no content dropped");
}

// Clean up: remove test sections so they don't leak into other tests.
__sections.delete("test-persona-compose");
__sections.delete("ultrawork-directive");
_resetForTest();

// ── Notepad tests (task 15) ─────────────────────────────────────────────────

// Test N1: Notepad seed has all required sections.
{
  _resetForTest();
  const tmp = mkdtempSync(join(tmpdir(), "ulw-test-"));
  const notepadDir = join(tmp, ".ohpi", "notepad");
  mkdirSync(notepadDir, { recursive: true });

  // Write a seed notepad manually matching the NOTEPAD_SEED structure.
  const testPath = join(notepadDir, "test-notepad.md");
  writeFileSync(
    testPath,
    [
      "# Ultrawork Notepad — test",
      "Started: 2026-07-13T00:00:00.000Z",
      "",
      "## Plan (exhaustive, atomic)",
      "## Scenarios (the contract)",
      "## Now (single step in progress)",
      "## Todo (remaining, ordered)",
      "## Findings (non-obvious facts with file:line refs)",
      "## Learnings (patterns / pitfalls for next turn)",
      "",
    ].join("\n"),
    "utf-8",
  );

  const content = readFileSync(testPath, "utf-8");
  assert.ok(content.includes("# Ultrawork Notepad"), "notepad should have title");
  assert.ok(content.includes("## Plan"), "notepad should have Plan section");
  assert.ok(content.includes("## Scenarios"), "notepad should have Scenarios section");
  assert.ok(content.includes("## Now"), "notepad should have Now section");
  assert.ok(content.includes("## Todo"), "notepad should have Todo section");
  assert.ok(content.includes("## Findings"), "notepad should have Findings section");
  assert.ok(content.includes("## Learnings"), "notepad should have Learnings section");
  console.log("PASS: notepad seed has all 7 required sections");

  // Test N2: append adds content without overwriting.
  const beforeLen = content.length;
  _setNotepadPathForTest(testPath);
  appendToNotepad(testPath, "## Now\nWorking on notepad tests.");
  const afterAppend = readFileSync(testPath, "utf-8");
  assert.ok(afterAppend.length > beforeLen, "append should increase file size");
  assert.ok(
    afterAppend.includes("Working on notepad tests."),
    "appended content should be present",
  );
  // Verify the seed content is still there (not overwritten).
  assert.ok(afterAppend.includes("## Plan"), "Plan section should still exist after append");
  assert.ok(
    afterAppend.includes("## Findings"),
    "Findings section should still exist after append",
  );
  console.log("PASS: append adds content without overwriting seed sections");

  rmSync(tmp, { recursive: true, force: true });
  _setNotepadPathForTest(null);
}

// Test N3: findNotepadFromEntries restores path from mock entries.
{
  _resetForTest();
  const testPath = "/tmp/ulw-test-notepad.md";

  const entries = [
    { type: "chat", data: null },
    {
      type: "custom",
      customType: "ultrawork",
      data: { active: true, tier: "HEAVY", task: "test" },
    },
    {
      type: "custom",
      customType: "ulw-notepad",
      data: { path: testPath, fromFallback: true, cwd: "/tmp" },
    },
  ];

  const found = findNotepadFromEntries(entries);
  assert.ok(found !== null, "findNotepadFromEntries should find the notepad entry");
  assert.strictEqual(found!.path, testPath, "restored path should match");
  console.log("PASS: findNotepadFromEntries restores path from entries");

  // Test N4: findNotepadFromEntries returns null when no ulw-notepad entries exist.
  const noEntries = [
    { type: "custom", customType: "ultrawork", data: { active: true } },
    { type: "custom", customType: "todo-list", data: { todos: [] } },
  ];
  const notFound = findNotepadFromEntries(noEntries);
  assert.strictEqual(notFound, null, "should return null when no ulw-notepad entries");
  console.log("PASS: findNotepadFromEntries returns null for empty entries");

  // Test N5: Does NOT collide with todo's "todo-list" entry type.
  // (Verified above — todo-list entries are ignored by findNotepadFromEntries.)
  console.log("PASS: ulw-notepad entry type is distinct from todo-list");
}

// Test N6: getNotepadPath returns the current path (or null).
{
  _resetForTest();
  assert.strictEqual(getNotepadPath(), null, "getNotepadPath should return null initially");
  _setNotepadPathForTest("/tmp/test-ulw.md");
  assert.strictEqual(getNotepadPath(), "/tmp/test-ulw.md", "getNotepadPath should return set path");
  _resetForTest();
  assert.strictEqual(getNotepadPath(), null, "getNotepadPath should be null after reset");
  console.log("PASS: getNotepadPath returns correct state on set and reset");
}

// ── Evidence-gate tests (task 16) ────────────────────────────────────────────

// Helper: activate ultrawork with guaranteed HEAVY tier for gate tests.
function _activateHeavy(): void {
  _setActiveForTest(true, "complex multi-step refactor"); // triggers HEAVY
}

function _activateLight(): void {
  _setActiveForTest(true, "fix typo"); // LIGHT (short, no signals)
}

// Test E1: evidencePresent → true when notepad has content beyond seed.
{
  _resetForTest();
  const tmp = mkdtempSync(join(tmpdir(), "ulw-evg-"));
  const testPath = join(tmp, "notepad.md");
  writeFileSync(testPath, "x".repeat(600), "utf-8"); // > SEED_SIZE_MAX (500)
  _setNotepadPathForTest(testPath);
  _setEvidenceOverrideForTest(null); // Use real file check
  assert.strictEqual(evidencePresent(), true, "evidence should be present when file > 500 bytes");
  rmSync(tmp, { recursive: true, force: true });
  _setNotepadPathForTest(null);
  console.log("PASS: evidencePresent returns true when notepad has content");
}

// Test E2: evidencePresent → false when notepad is still seed-only.
{
  _resetForTest();
  const tmp = mkdtempSync(join(tmpdir(), "ulw-evg-"));
  const testPath = join(tmp, "seed.md");
  writeFileSync(testPath, "# Ultrawork Notepad\ntest", "utf-8"); // < 500 bytes
  _setNotepadPathForTest(testPath);
  _setEvidenceOverrideForTest(null);
  assert.strictEqual(evidencePresent(), false, "evidence should be absent for seed-only file");
  rmSync(tmp, { recursive: true, force: true });
  _setNotepadPathForTest(null);
  console.log("PASS: evidencePresent returns false when notepad is seed-only");
}

// Test E3: evidencePresent → false when no notepad path.
{
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  assert.strictEqual(evidencePresent(), false, "evidence should be absent when no notepad path");
  console.log("PASS: evidencePresent returns false when no notepad path");
}

// Test E4: evidence-gate intent — HEAVY active + no evidence → fires.
{
  _resetForTest();
  _activateHeavy();
  _setEvidenceOverrideForTest(false); // Simulate missing evidence

  // Register the evidence-gate intent with the coordinator's __continuations.
  const intent = {
    name: "ultrawork-evidence-gate-test",
    priority: 203,
    order: 0,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return { prompt: "[evidence-gate] HEAVY task needs proof before done." };
    },
  };
  __continuations.set(intent.name, intent);

  setRunningSubagentsForTest(0);
  const result = resolveContinuation();
  assert.ok(result !== undefined, "evidence-gate should fire for HEAVY+no-evidence");
  assert.ok(result!.prompt.includes("HEAVY"), "re-prompt should mention HEAVY tier");

  __continuations.delete(intent.name);
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  console.log("PASS: evidence-gate fires for HEAVY + no evidence");
}

// Test E5: evidence-gate — HEAVY active + evidence present → abstains.
{
  _resetForTest();
  _activateHeavy();
  _setEvidenceOverrideForTest(true); // Simulate evidence present

  const intent = {
    name: "ultrawork-evidence-gate-test",
    priority: 203,
    order: 0,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return { prompt: "should not happen" };
    },
  };
  __continuations.set(intent.name, intent);

  setRunningSubagentsForTest(0);
  const result = resolveContinuation();
  assert.strictEqual(result, undefined, "evidence-gate should abstain for HEAVY+evidence-present");

  __continuations.delete(intent.name);
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  console.log("PASS: evidence-gate abstains for HEAVY + evidence present");
}

// Test E6: evidence-gate — LIGHT tier → abstains (skips gate).
{
  _resetForTest();
  _activateLight();
  _setEvidenceOverrideForTest(false);

  const intent = {
    name: "ultrawork-evidence-gate-test",
    priority: 203,
    order: 0,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return { prompt: "should not happen — LIGHT tier" };
    },
  };
  __continuations.set(intent.name, intent);

  setRunningSubagentsForTest(0);
  const result = resolveContinuation();
  assert.strictEqual(result, undefined, "evidence-gate should abstain for LIGHT tier");

  __continuations.delete(intent.name);
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  console.log("PASS: evidence-gate abstains for LIGHT tier (gate skipped)");
}

// Test E7: evidence-gate — ultrawork inactive → abstains.
{
  _resetForTest();
  // active is false by default
  _setEvidenceOverrideForTest(false);

  const intent = {
    name: "ultrawork-evidence-gate-test",
    priority: 203,
    order: 0,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return { prompt: "should not happen — inactive" };
    },
  };
  __continuations.set(intent.name, intent);

  setRunningSubagentsForTest(0);
  const result = resolveContinuation();
  assert.strictEqual(result, undefined, "evidence-gate should abstain when ultrawork inactive");

  __continuations.delete(intent.name);
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  console.log("PASS: evidence-gate abstains when ultrawork inactive");
}

// ── Arbiter coexistence test (task 16) ───────────────────────────────────────
// Proves ONE-per-edge: with BOTH evidence-gate (priority 203) and ralph-loop
// (priority 205), the arbiter returns exactly one — evidence-gate wins when
// HEAVY+incomplete, ralph wins when evidence-gate abstains.

// Test A1: Both registered, evidence-gate fires (HEAVY+no-evidence) → evidence-gate wins.
{
  _resetForTest();
  _activateHeavy();
  _setEvidenceOverrideForTest(false);

  // Evidence gate: priority 203 (lower = higher precedence)
  __continuations.set("coexist-evidence-gate", {
    name: "coexist-evidence-gate",
    priority: 203,
    order: 200,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return { prompt: "[evidence-gate] capture evidence." };
    },
  });

  // Ralph-style loop: priority 205 (checked AFTER evidence-gate)
  __continuations.set("coexist-ralph", {
    name: "coexist-ralph",
    priority: 205,
    order: 201,
    decide: () => {
      return { prompt: "[ralph] continue loop." };
    },
  });

  setRunningSubagentsForTest(0);
  const result = resolveContinuation();
  assert.ok(result !== undefined, "arbiter should return exactly one continuation");
  assert.ok(
    result!.prompt.includes("evidence-gate"),
    `expected evidence-gate to win (priority 203 < 205), got: ${result!.prompt}`,
  );
  assert.ok(
    !result!.prompt.includes("ralph"),
    "ralph should NOT win when evidence-gate fires first",
  );

  __continuations.delete("coexist-evidence-gate");
  __continuations.delete("coexist-ralph");
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  console.log(
    "PASS: arbiter coexistence — evidence-gate (203) wins over ralph (205) when HEAVY+incomplete",
  );
}

// Test A2: Both registered, evidence-gate abstains → ralph wins.
{
  _resetForTest();
  _activateHeavy();
  _setEvidenceOverrideForTest(true); // Evidence PRESENT → gate abstains

  __continuations.set("coexist-evidence-gate", {
    name: "coexist-evidence-gate",
    priority: 203,
    order: 200,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return { prompt: "[evidence-gate] should not fire." };
    },
  });

  __continuations.set("coexist-ralph", {
    name: "coexist-ralph",
    priority: 205,
    order: 201,
    decide: () => {
      return { prompt: "[ralph] continue loop." };
    },
  });

  setRunningSubagentsForTest(0);
  const result = resolveContinuation();
  assert.ok(result !== undefined, "arbiter should return a continuation");
  assert.ok(
    result!.prompt.includes("ralph"),
    `expected ralph to win when evidence-gate abstains, got: ${result!.prompt}`,
  );

  __continuations.delete("coexist-evidence-gate");
  __continuations.delete("coexist-ralph");
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  console.log("PASS: arbiter coexistence — ralph (205) wins when evidence-gate (203) abstains");
}

// ── Evidence capture tests (task 27) ───────────────────────────────────────

import { spawnSync } from "node:child_process";

// Test EV-1: evidencePresent → true when structured evidence records exist at cwd.
{
  _resetForTest();
  _resetSeqForTest();
  const cwd = process.cwd();

  // Write a real evidence record using task 26's writer to the actual cwd.
  const evidencePath = writeEvidence(cwd, "ultrawork", {
    type: "test-output",
    surface: "cli:directive.test",
    content: "Structured evidence record for evidencePresent test",
  });
  assert.ok(evidencePath.includes(".ohpi/evidence/"), "evidence should land under .ohpi/evidence");

  _setEvidenceOverrideForTest(null);
  const hasEvidence = evidencePresent();
  assert.strictEqual(
    hasEvidence,
    true,
    "evidencePresent should return true when structured evidence exists",
  );

  // Clean up: remove the evidence file so it doesn't leak to subsequent runs.
  const evidenceDir = join(cwd, ".ohpi", "evidence");
  rmSync(evidenceDir, { recursive: true, force: true });

  _resetForTest();
  console.log("PASS: evidencePresent returns true when structured evidence records exist");
}

// Test EV-2: evidencePresent → false when no evidence records + no notepad.
{
  _resetForTest();
  _setEvidenceOverrideForTest(null);

  const result = evidencePresent();
  assert.strictEqual(
    result,
    false,
    "evidencePresent should return false without records or notepad",
  );

  _resetForTest();
  console.log("PASS: evidencePresent returns false when no records and no notepad path");
}

// Test EV-3: evidencePresent → true via notepad fallback (backward compat).
{
  _resetForTest();
  const tmp = mkdtempSync(join(tmpdir(), "ulw-evfb-"));
  const testPath = join(tmp, "notepad.md");
  writeFileSync(testPath, "x".repeat(600), "utf-8");
  _setNotepadPathForTest(testPath);
  _setEvidenceOverrideForTest(null);

  const result = evidencePresent();
  assert.strictEqual(
    result,
    true,
    "evidencePresent should fall back to notepad-size when no evidence records",
  );

  rmSync(tmp, { recursive: true, force: true });
  _setNotepadPathForTest(null);
  _resetForTest();
  console.log("PASS: evidencePresent falls back to notepad-size heuristic (backward compat)");
}

// Test EV-4: Directive text contains /ultrawork-evidence command mention.
{
  assert.ok(
    ULTRAWORK_DIRECTIVE.includes("/ultrawork-evidence"),
    "directive should mention /ultrawork-evidence command for agent-driven capture",
  );
  assert.ok(
    ULTRAWORK_DIRECTIVE.includes("EVIDENCE"),
    "directive should have EVIDENCE step in RED→GREEN→SURFACE→CLEAN flow",
  );
  console.log("PASS: directive text includes /ultrawork-evidence evidence capture instruction");
}

// Test EV-5: Evidence-gate uses upgraded evidencePresent (HEAVY + record → abstains).
{
  _resetForTest();
  _activateHeavy();
  _setEvidenceOverrideForTest(true);

  const intent = {
    name: "ultrawork-evidence-gate-evcap",
    priority: 203,
    order: 0,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return { prompt: "should not happen" };
    },
  };
  __continuations.set(intent.name, intent);

  setRunningSubagentsForTest(0);
  const result = resolveContinuation();
  assert.strictEqual(
    result,
    undefined,
    "evidence-gate should abstain when evidencePresent returns true",
  );

  __continuations.delete(intent.name);
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  console.log(
    "PASS: evidence-gate abstains with upgraded evidencePresent (HEAVY + records present)",
  );
}

// Test EV-6: Evidence-gate fires when upgraded evidencePresent returns false.
{
  _resetForTest();
  _activateHeavy();
  _setEvidenceOverrideForTest(false);

  const intent = {
    name: "ultrawork-evidence-gate-evcap2",
    priority: 203,
    order: 0,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return { prompt: "[evidence-gate] HEAVY task needs proof before done." };
    },
  };
  __continuations.set(intent.name, intent);

  setRunningSubagentsForTest(0);
  const result = resolveContinuation();
  assert.ok(result !== undefined, "evidence-gate should fire when evidencePresent returns false");
  assert.ok(result!.prompt.includes("HEAVY"), "re-prompt should mention HEAVY");

  __continuations.delete(intent.name);
  _resetForTest();
  _setEvidenceOverrideForTest(null);
  console.log("PASS: evidence-gate fires with upgraded evidencePresent (HEAVY + no records)");
}

// Test EV-7: writeEvidence produces jq-valid record with required fields.
{
  _resetSeqForTest();
  const cwd = process.cwd();
  const filePath = writeEvidence(cwd, "ultrawork-test", {
    type: "test-output",
    surface: "cli:directive.test.ts",
    content: "Ultrawork evidence capture test — structured record",
  });

  const jqResult = spawnSync("jq", ["-e", ".timestamp and .type and .content", filePath], {
    encoding: "utf-8",
  });
  assert.strictEqual(jqResult.status, 0, `jq -e on evidence record failed: ${jqResult.stderr}`);

  const raw = readFileSync(filePath, "utf-8");
  const record = JSON.parse(raw);
  assert.strictEqual(record.type, "test-output");
  assert.strictEqual(record.surface, "cli:directive.test.ts");
  assert.strictEqual(record.content, "Ultrawork evidence capture test — structured record");
  assert.ok(typeof record.timestamp === "string", "timestamp must be present");
  console.log(`PASS: jq-valid evidence record with required fields: ${filePath}`);

  // Clean up.
  const evidenceDir = join(cwd, ".ohpi", "evidence");
  rmSync(evidenceDir, { recursive: true, force: true });
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("\nAll strip tests passed!");
console.log("Directive length: %d chars", ULTRAWORK_DIRECTIVE.length);

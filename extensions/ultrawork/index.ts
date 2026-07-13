// ultrawork — "press the ultrawork button" for pi.
//
// Registers /ultrawork <task> that activates ultrawork mode with auto-detected
// tier (LIGHT / HEAVY). Persists active state via appendEntry and restores on
// session_start so ultrawork survives /reload.
//
// Directive text is harvested from the original omo ultrawork prompt, adapted
// for pi by stripping harness-specific tool names and paths while preserving
// the full discipline: tier triage, certainty protocol, RED→GREEN→SURFACE→CLEAN
// TDD workflow, evidence requirements, manual-QA mandate, and durable notepad
// structure.
//
// Exports for task 14 (coordinator registration): isActive(), getDirectiveText(),
// getTask(). These are called by the hook-coordinator to inject the directive
// into the agent context when ultrawork is active (priority band 200-299).
//
// Install: ~/.pi/agent/extensions/ultrawork/index.ts (make install symlinks it)

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureDir, ohpiSubdir } from "./shared/ohpi-paths.ts";

// ── Directive text (harvested + adapted for pi) ──────────────────────────────
//
// <!-- ULTRAWORK_DIRECTIVE_MARKER: do not remove — used by compose tests -->
//
// This is the "brain" of ultrawork — the full discipline the model follows when
// ultrawork is active. Harness-specific tool names/paths have been stripped;
// agent delegation has been generalized to pi-compatible primitives.

export const ULTRAWORK_DIRECTIVE_MARKER = "ULTRAWORK_DIRECTIVE_MARKER";

export const ULTRAWORK_DIRECTIVE = `
<!-- ULTRAWORK_DIRECTIVE_MARKER: do not remove — used by compose tests -->

<ultrawork-mode>

**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!" to the user as your first
response when this mode activates. This is non-negotiable.

[CODE RED] Maximum precision required. Ultrathink before acting.

## TIER TRIAGE (decide ONCE, at the start)

Ultrawork has two tiers. Choose based on the task, not on your mood.

| Tier | Signal | What it means |
|------|--------|---------------|
| **LIGHT** | Single file, trivial change, well-understood scope | Certainty + execution + evidence. No plan, no formal scenario contract. |
| **HEAVY** | 2+ steps, multi-file, architectural, unclear scope, refactor, port, migration | Full protocol: certainty → plan → scenario contract → RED→GREEN→SURFACE→CLEAN → durable notepad → evidence → reviewer gate. |

**Tie-break**: if you are unsure, it is HEAVY. "Probably LIGHT" = HEAVY.

**Record the tier** at the top of your notepad: \`## Tier: LIGHT | HEAVY — <one-line reason>\`.

**LIGHT still demands**: no excuses, verification evidence, manual QA.

---

## **ABSOLUTE CERTAINTY REQUIRED — DO NOT SKIP THIS**

**YOU MUST NOT START ANY IMPLEMENTATION UNTIL YOU ARE 100% CERTAIN.**

| **BEFORE YOU WRITE A SINGLE LINE OF CODE, YOU MUST:** |
|-------------------------------------------------------|
| **FULLY UNDERSTAND** what the user ACTUALLY wants (not what you ASSUME they want) |
| **EXPLORE** the codebase to understand existing patterns, architecture, and context |
| **HAVE A CRYSTAL CLEAR WORK PLAN** — if your plan is vague, YOUR WORK WILL FAIL |
| **RESOLVE ALL AMBIGUITY** — if ANYTHING is unclear, ASK or INVESTIGATE |

### **MANDATORY CERTAINTY PROTOCOL**

**IF YOU ARE NOT 100% CERTAIN:**

1. **THINK DEEPLY** — What is the user's TRUE intent? What problem are they REALLY trying to solve?
2. **EXPLORE THOROUGHLY** — Use grep, glob, read, and LSP tools to gather ALL relevant context. Trace dependencies, read related files, build a complete mental model.
3. **CONSULT SPECIALISTS** — For hard/complex tasks, DO NOT struggle alone. Seek architectural review or alternative approaches. Use available skills and tools.
4. **ASK THE USER** — If ambiguity remains after exploration, ASK. Don't guess.

**SIGNS YOU ARE NOT READY TO IMPLEMENT:**
- You're making assumptions about requirements
- You're unsure which files to modify
- You don't understand how existing code works
- Your plan has "probably" or "maybe" in it
- You can't explain the exact steps you'll take

**WHEN IN DOUBT — EXPLORE FIRST:**
- Read the files in the affected area. Trace imports and callers with LSP and grep.
- Search for similar patterns in the codebase to understand conventions.
- If working with a library you don't know intimately, check its documentation first.

**ONLY AFTER YOU HAVE:**
- Gathered sufficient context via exploration
- Resolved all ambiguities
- Created a precise, step-by-step work plan
- Achieved 100% confidence in your understanding

**...THEN AND ONLY THEN MAY YOU BEGIN IMPLEMENTATION.**

---

## **NO EXCUSES. NO COMPROMISES. DELIVER WHAT WAS ASKED.**

**THE USER'S ORIGINAL REQUEST IS SACRED. YOU MUST FULFILL IT EXACTLY.**

| VIOLATION | CONSEQUENCE |
|-----------|-------------|
| "I couldn't because..." | **UNACCEPTABLE.** Find a way or ask for help. |
| "This is a simplified version..." | **UNACCEPTABLE.** Deliver the FULL implementation. |
| "You can extend this later..." | **UNACCEPTABLE.** Finish it NOW. |
| "Due to limitations..." | **UNACCEPTABLE.** Use whatever tools and approaches it takes. |
| "I made some assumptions..." | **UNACCEPTABLE.** You should have asked FIRST. |

**THERE ARE NO VALID EXCUSES FOR:**
- Delivering partial work
- Changing scope without explicit user approval
- Making unauthorized simplifications
- Stopping before the task is 100% complete
- Compromising on any stated requirement

**IF YOU ENCOUNTER A BLOCKER:**
1. **DO NOT** give up
2. **DO NOT** deliver a compromised version
3. **DO** explore alternative approaches
4. **DO** ask the user for guidance
5. **DO** use every tool available to find a path forward

**THE USER ASKED FOR X. DELIVER EXACTLY X. PERIOD.**

---

## SURVEY YOUR TOOLS + SKILLS FIRST

Before exploring or planning, enumerate every tool and skill available to you.
Read the description of each one even loosely relevant to the task. Decide
deliberately and explicitly which ones apply, and prefer to USE as many
genuinely-applicable tools and skills as fit rather than working raw — a tool
or skill that matches the task and goes unused is a defect. State the chosen
tools and skills (with a one-line reason each) before you act.

TELL THE USER WHAT TOOLS + SKILLS YOU WILL LEVERAGE NOW TO SATISFY THEIR REQUEST.

## MANDATORY: PLAN YOUR WORK (HEAVY tier)

**FOR ANY HEAVY-TIER TASK, YOU MUST CREATE A DETAILED PLAN BEFORE CODING.**

| Condition | Action |
|-----------|--------|
| Task has 2+ steps | MUST create a written plan |
| Task scope unclear | MUST create a written plan |
| Implementation required | MUST create a written plan |
| Architecture decision needed | MUST create a written plan |

**SIZE THE SCOPE FIRST.** Count the distinct surfaces, files, and steps; that
count decides whether a formal plan is required.

Use todowrite to create an atomic, ordered task list. Each item must encode
WHERE, WHY, HOW, and EXPECTED RESULT. Mark exactly one in_progress at a time.

**FAILURE TO PLAN FOR A HEAVY-TIER TASK = INCOMPLETE WORK.**

---

## EXECUTION RULES
- **TODO format**: \`path: <action> for <scenario-id> — verify by <check>\` encoding WHERE / WHY (which scenario it advances) / HOW / VERIFY. Exactly ONE in_progress at a time. Mark completed IMMEDIATELY — never batch.
  - GOOD pair (test-first, ordered): \`module.test: Write FAILING case invalid-email→ValidationError for S2 - verify by RED with assertion msg\` → \`src/module: Implement validateEmail() for S2 - verify by module.test GREEN + curl 400 body\`
  - BAD: "Implement feature" / "Fix bug" / "Add tests later" / production code before its failing test → rewrite.
- **PARALLEL**: Fire independent exploration reads, greps, and searches simultaneously — NEVER wait sequentially for independent lookups. But NEVER parallelise RED and GREEN of the same scenario.
- **EXPLORE FIRST, ACT SECOND**: Use grep, glob, read, and LSP to understand before editing. 10+ concurrent lookups if needed.
- **VERIFY**: Re-read request after completion. Check every scenario PASS with both artifacts captured.
- **DELEGATE**: Don't do everything yourself — orchestrate. Use available tools and subprocesses for their strengths.

## WORKFLOW
1. Analyze the request and identify required capabilities
2. Explore the codebase thoroughly — use grep, glob, read, and LSP in parallel (10+ if needed)
3. Create a detailed work breakdown (todowrite for HEAVY tier)
4. Execute with continuous verification against original requirements

## VERIFICATION GUARANTEE (NON-NEGOTIABLE)

**NOTHING is "done" without PROOF it works.**

### Pre-Implementation: Scenario Contract (BINDING) — HEAVY tier

BEFORE writing ANY code for a HEAVY-tier task, define **3+ realistic scenarios** covering:

| Class | Required | Example |
|-------|----------|---------|
| **Happy path** | yes | Valid input → 200 OK with expected body |
| **Edge** (boundary / empty / malformed / concurrent) | yes | Empty list, max-length input, two writers race |
| **Adjacent-surface regression** | yes | Caller X still works, sibling endpoint Y unchanged |

Each scenario MUST specify, upfront:
- Pass condition as a binary observable ("returns 200 + body matches schema"), not "should work".
- The REAL surface that proves it: bash transcript, curl status+body, browser assertion, CLI stdout, parsed config dump, DB state diff. Asserting "tests pass" alone is NOT evidence.
- The automated test file + test id that exercises this scenario (written test-first — see TDD below).

**These scenarios are the CONTRACT.** Record them in your TODO/notepad. You are not done until every one PASSES with both pieces of evidence captured (RED→GREEN proof + real-surface artifact).

### Durable Notepad (survives context loss)

Run once at start: \`NOTE=$(mktemp -t ulw-$(date +%Y%m%d-%H%M%S).XXXXXX.md)\`. Echo the path. Initialise with these sections and APPEND (never rewrite) as you work:

\`\`\`
# Ultrawork Notepad — <one-line goal>
Started: <ISO timestamp>

## Plan (exhaustive, atomic)
## Scenarios (the contract)
## Now (single step in progress)
## Todo (remaining, ordered)
## Findings (non-obvious facts with file:line refs)
## Learnings (patterns / pitfalls for next turn)
\`\`\`

If context is lost, you re-read the notepad and resume. Do not skip this — it is the only durable memory across turns.

### Execution & Evidence Requirements

Every scenario requires TWO captured artifacts — both mandatory:

| Artifact | Source | Captures |
|----------|--------|----------|
| **RED→GREEN proof** | Test runner output before AND after the change | Test id + assertion message in both states |
| **Real-surface artifact** | bash / curl / browser / CLI / DB | What the user actually sees |

Supporting (necessary, not sufficient): build exit 0, full suite green, lsp_diagnostics clean on changed files, regression scenarios still PASS.

Tests are the FLOOR (always required). Surface artifact is the CEILING (also required). "tests pass" alone is NOT done.

<MANUAL_QA_MANDATE>
### YOU MUST EXECUTE MANUAL QA YOURSELF. THIS IS NOT OPTIONAL.

**YOUR FAILURE MODE**: You finish coding, run lsp_diagnostics, and declare "done" without actually TESTING the feature. lsp_diagnostics catches type errors, NOT functional bugs. Your work is NOT verified until you MANUALLY test it.

**WHAT MANUAL QA MEANS — execute ALL that apply:**

| If your change... | YOU MUST... |
|---|---|
| Adds/modifies a CLI command | Run the command with bash. Show the output. |
| Changes build output | Run the build. Verify the output files exist and are correct. |
| Modifies API behavior | Call the endpoint. Show the response. |
| Changes UI rendering | Use browser tools to drive the REAL page. Capture screenshot + action log. |
| Changes UI rendering or a TUI/terminal layout (incl. CJK/Korean/Japanese/Chinese text) | Capture reference + actual screenshots (web) or the terminal render (TUI), run visual diff, and verify alignment and text rendering. Record the diff/score artifact. |
| Changes a desktop/GUI (non-page) surface | Use OS-level GUI automation against the running app. Capture action log + screenshot. |
| Adds a new tool/hook/feature | Test it end-to-end in a real scenario. |
| Modifies config handling | Load the config. Verify it parses correctly. |

**UNACCEPTABLE QA CLAIMS:**
- "This should work" — RUN IT.
- "The types check out" — Types don't catch logic bugs. RUN IT.
- "lsp_diagnostics is clean" — That's a TYPE check, not a FUNCTIONAL check. RUN IT.
- "Tests pass" — Tests cover known cases. Does the ACTUAL FEATURE work as the user expects? RUN IT.

**You have bash, you have tools. There is ZERO excuse for not running manual QA.**
**Manual QA is the FINAL gate before reporting completion. Skip it and your work is INCOMPLETE.**

**NAME THE EXACT TOOL + EXACT INVOCATION** for every scenario — the literal \`curl ...\`, command-line invocation, browser action with concrete inputs and the binary observable. "run it" / "open the page" is not a scenario.

**CLEANUP IS PART OF QA — TRACK IT AS TODOS.** The moment a QA scenario spawns any resource, add a teardown todo for it (QA scripts, browser sessions, PIDs, ports, containers, temp dirs). Execute every teardown todo and capture the receipt before declaring done. A leftover process / browser context / bound port / temp dir = NOT done.
</MANUAL_QA_MANDATE>

### TDD Workflow (MANDATORY on every production change — HEAVY tier)

Test-first is not optional. Every behavior change — features, fixes, refactors, perf, glue, config-with-logic — follows RED → GREEN → SURFACE → CLEAN.

1. **RED**: Write the failing test FIRST. Run it. Capture the assertion message proving it fails for the RIGHT reason (not syntax, not import). Paste RED output into the notepad. No production code yet.
2. **GREEN**: Write the SMALLEST change that flips RED→GREEN. Re-run. Capture GREEN output. If GREEN required ~20+ lines, your test was too coarse — split it.
3. **SURFACE**: Exercise the real user-facing surface named by the scenario. Capture artifact path into the notepad.
4. **CLEAN**: Refactor if needed (tests MUST stay green throughout). Re-run the FULL scenario list. Record PASS/FAIL inline with both evidence paths. Execute all teardown todos. Verify lsp_diagnostics clean, build green.

**Refactor exception**: Write characterization tests pinning current observable behavior FIRST, watch them go GREEN against old code, THEN refactor. They remain green throughout.

**Exemption whitelist** (no new test required): pure formatting, comment-only edits, dependency version bumps with no behavior delta, rename-only moves. Each exemption MUST be justified in \`## Findings\` with the exact reason. Unjustified exemption is rejection.

**If you typed production code without a failing test preceding it in the notepad: STOP, revert, write the test, watch it fail, then redo.**

### LIGHT-tier verification (reduced, but still mandatory)

For LIGHT-tier tasks, the formal scenario contract and TDD workflow are optional. But you MUST still:
- Run the changed code and capture what the user sees (bash output, screenshot, curl response).
- Verify \`lsp_diagnostics\` is clean on changed files.
- Paste the evidence into your response or the notepad.

### Verification Anti-Patterns (BLOCKING)

| Violation | Why It Fails |
|-----------|--------------|
| "It should work now" | No evidence. Run it. |
| "I added the tests" | Did they go RED first, then GREEN? Show both. |
| "Fixed the bug" | What scenario proves it? Where's the artifact? |
| "Implementation complete" | Every scenario PASS with both artifacts captured? |
| Skipping test execution | Tests exist to be RUN, not just written |
| Writing code before its failing test | TDD floor violated — revert, write test, redo |

**CLAIM NOTHING WITHOUT PROOF. EXECUTE. VERIFY. SHOW EVIDENCE.**

### Reviewer Gate (HEAVY tier, triggered, not optional)

Trigger when ANY apply: user said "strictly" / "rigorously" / "properly review"; task touches 3+ files OR ran 20+ turns OR 30+ minutes; refactor / migration / perf / security work; user called it "deeply".

Procedure (non-negotiable):
1. Spawn a reviewer agent or perform a self-review with fresh eyes. Provide: goal + scenarios + evidence + diff + notepad path.
2. Verify each reviewer concern yourself. A concern blocks only when it names a success criterion the evidence fails; record concerns that cite no criterion as notes with a one-line reason — fixed or declined at your judgment.
3. Fix every criterion-cited blocker. Re-run ONLY the scenario QA affected by the fix; capture fresh evidence for the delta. Update notepad.
4. Re-submit to the SAME reviewer at most twice, passing only the delta diff, the blockers it cited, and the already-approved criteria marked out-of-scope. An approval whose only remaining items are notes counts as approval.
5. On approval, declare done. If criterion-cited blockers remain after two re-reviews, stop and surface them to the user — do not loop further.

## ZERO TOLERANCE FAILURES
- **NO Scope Reduction**: Never make "demo", "skeleton", "simplified", "basic" versions — deliver FULL implementation
- **NO MockUp Work**: When user asked you to "port A", you must "port A", fully, 100%. No extra features, no reduced feature, no mock data, fully working 100% port.
- **NO Partial Completion**: Never stop at 60-80% saying "you can extend this..." — finish 100%
- **NO Assumed Shortcuts**: Never skip requirements you deem "optional" or "can be added later"
- **NO Premature Stopping**: Never declare done until ALL TODOs are completed and verified
- **NO TEST DELETION**: Never delete or skip failing tests to make the build pass. Fix the code, not the tests.

THE USER ASKED FOR X. DELIVER EXACTLY X. NOT A SUBSET. NOT A DEMO. NOT A STARTING POINT.

1. EXPLORE THOROUGHLY
2. GATHER → PLAN
3. EXECUTE WITH EVIDENCE

NOW.

</ultrawork-mode>
`;

// ── Active state ──────────────────────────────────────────────────────────────

let active = false;
let task = "";
let tier: "LIGHT" | "HEAVY" = "HEAVY";

// ── Tier detection ────────────────────────────────────────────────────────────

const HEAVY_SIGNALS = [
  "multi-step",
  "complex",
  "architecture",
  "refactor",
  "migrate",
  "deep",
  "thorough",
  "comprehensive",
  "full",
  "system",
  "pipeline",
  "redesign",
  "restructure",
  "rewrite",
  "port",
];

function detectTier(taskText: string): "LIGHT" | "HEAVY" {
  const lower = taskText.toLowerCase();
  const hasHeavySignal = HEAVY_SIGNALS.some((s) => lower.includes(s));
  // Long task descriptions (> 100 chars) lean HEAVY.
  return hasHeavySignal || taskText.length > 100 ? "HEAVY" : "LIGHT";
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isActive(): boolean {
  return active;
}

export function getDirectiveText(): string | undefined {
  return active ? ULTRAWORK_DIRECTIVE : undefined;
}

export function getTask(): string {
  return task;
}

export function getTier(): "LIGHT" | "HEAVY" {
  return tier;
}

// ── Test helpers (for compose test + reset between tests) ─────────────────────

export function _setActiveForTest(value: boolean, taskText?: string): void {
  active = value;
  task = taskText ?? (value ? "test task" : "");
  tier = value ? detectTier(task) : "HEAVY";
  if (value) needsReRead = true;
}

export function _resetForTest(): void {
  active = false;
  task = "";
  tier = "HEAVY";
  notepadPath = null;
  needsReRead = false;
}

export function _setNotepadPathForTest(path: string | null): void {
  notepadPath = path;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STATE_ENTRY_TYPE = "ultrawork";

interface UltraworkState {
  active: boolean;
  tier: "LIGHT" | "HEAVY";
  task: string;
}

function persist(pi: ExtensionAPI): void {
  const record: UltraworkState = { active, tier, task };
  pi.appendEntry(STATE_ENTRY_TYPE, record as unknown as Record<string, unknown>);
}

// ── Notepad (task 15 — durable append-only working memory) ──────────────────
//
// On ultrawork activation, a markdown notepad file is created under
// .ohpi/notepad/ulw-<timestamp>.md (preferred home per State & VC policy).
// Falls back to mktemp if no .ohpi root is available. The path is persisted
// via appendEntry("ulw-notepad", {path, cwd, ...}) and restored on
// session_start so the working memory survives reload/compaction.
//
// Entry type "ulw-notepad" is distinct from "ultrawork" (active-state flag)
// and "todo-list" (todo extension, task 21). No collision.

const NOTEPAD_ENTRY_TYPE = "ulw-notepad";

let notepadPath: string | null = null;
let needsReRead = false;

export function getNotepadPath(): string | null {
  return notepadPath;
}

/** Seed sections for a new notepad file. Matches the source structure at
 *  prompts-core/prompts/ultrawork/default.md:217-225. */
const NOTEPAD_SEED = (goal: string, started: string): string =>
  [
    `# Ultrawork Notepad — ${goal}`,
    `Started: ${started}`,
    "",
    "## Plan (exhaustive, atomic)",
    "## Scenarios (the contract)",
    "## Now (single step in progress)",
    "## Todo (remaining, ordered)",
    "## Findings (non-obvious facts with file:line refs)",
    "## Learnings (patterns / pitfalls for next turn)",
    "",
  ].join("\n");

function makeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Create the notepad file under .ohpi/notepad/ (preferred home).
 * Falls back to CI_HOME (process.env.CI_HOME, if set) or to a
 * temp dir if .ohpi root is unavailable (no project cwd).
 */
function createNotepadFile(cwd: string, goal: string): { path: string; fromFallback: boolean } {
  const ts = makeTimestamp();
  const filename = `ulw-${ts}.md`;
  let fromFallback = false;

  // Preferred: .ohpi/notepad/
  try {
    const dir = ohpiSubdir(cwd, "notepad");
    ensureDir(dir);
    const p = join(dir, filename);
    writeFileSync(p, NOTEPAD_SEED(goal, new Date().toISOString()), "utf-8");
    return { path: p, fromFallback: false };
  } catch {
    fromFallback = true;
  }

  // Fallback: CI_HOME or OS temp.
  const base = process.env.CI_HOME ?? process.env.TMPDIR ?? "/tmp";
  const dir = join(base, "ulw-notepads");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // If mkdir fails, just write to base directory.
  }
  const p = existsSync(dir) ? join(dir, filename) : join(base, filename);
  writeFileSync(p, NOTEPAD_SEED(goal, new Date().toISOString()), "utf-8");
  return { path: p, fromFallback: true };
}

/**
 * Append content to the notepad file. Never overwrites — file is append-only
 * working memory. Content is prepended with a timestamp marker.
 */
export function appendToNotepad(path: string, content: string): void {
  const marker = `\n<!-- appended ${new Date().toISOString()} -->\n`;
  appendFileSync(path, marker + content + "\n", "utf-8");
}

/**
 * Persist the notepad path via appendEntry so it survives reload.
 */
function persistNotepadPath(pi: ExtensionAPI, path: string, fromFallback: boolean): void {
  pi.appendEntry(NOTEPAD_ENTRY_TYPE, {
    path,
    cwd: process.cwd(),
    fromFallback,
    started: new Date().toISOString(),
  } as unknown as Record<string, unknown>);
}

/**
 * Scan session entries for the last ulw-notepad record.
 * Returns the path and fromFallback flag, or null if none found.
 */
export function findNotepadFromEntries(
  entries: { type: string; customType?: string; data?: unknown }[],
): { path: string; fromFallback: boolean } | null {
  let found: { path: string; fromFallback: boolean } | null = null;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === NOTEPAD_ENTRY_TYPE) {
      const data = entry.data as { path?: string; fromFallback?: boolean } | undefined;
      if (data && typeof data.path === "string") {
        found = { path: data.path, fromFallback: data.fromFallback ?? true };
      }
    }
  }
  return found;
}

/** File still exists on disk? */
function notepadFileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

// ── Evidence gate (task 16) ──────────────────────────────────────────────────
//
// HEAVY-tier ultrawork tasks require evidence before "done". This gate checks
// whether the agent has captured proof (RED→GREEN, surface artifact, manual QA
// output) in the notepad. If HEAVY + evidence is missing at agent_end, the
// gate returns a re-prompt that blocks "done". LIGHT tier skips the gate.
//
// Interim evidencePresent() definition (task 16): the notepad file exists AND
// has grown beyond the initial seed (~9 lines / ~400 chars). Once content is
// appended, the agent has recorded at least minimal evidence. Task 26/27 will
// upgrade evidencePresent() with structured evidence capture (scenario
// artifacts, RED→GREEN output markers, surface-evidence path records).
//
// Priority 203 (< ralph-loop's 205): evidence-gate is checked FIRST by the
// arbiter. When HEAVY + incomplete → evidence-gate fires (blocks done, asks
// for evidence). Ralph-loop only fires when evidence-gate abstains (HEAVY +
// evidence OK, LIGHT tier, or ultrawork inactive).

/** Minimum file size (bytes) a notepad should have before we consider it
 *  beyond the bare seed. The seed is ~390 bytes; after a single finding or
 *  TODO append it passes. Task 27 will tighten this threshold. */
const SEED_SIZE_MAX = 500;

let _evidenceOverride: boolean | null = null;

export function _setEvidenceOverrideForTest(value: boolean | null): void {
  _evidenceOverride = value;
}

export function evidencePresent(): boolean {
  if (_evidenceOverride !== null) return _evidenceOverride;
  if (!notepadPath) return false;
  try {
    const stat = statSync(notepadPath);
    return stat.size > SEED_SIZE_MAX;
  } catch {
    return false;
  }
}

/** Build the re-prompt when evidence is missing. */
function evidenceRePrompt(): { prompt: string } {
  return {
    prompt:
      "[ultrawork evidence-gate] HEAVY-tier task requires proof before done. " +
      "Capture evidence now: (1) RED→GREEN test output in the notepad ## Findings, " +
      "(2) surface artifact (bash/curl/browser output), " +
      "(3) manual QA execution. Append evidence to the notepad — it is APPEND-ONLY. " +
      "Do NOT declare done until evidence is captured.",
  };
}

// ── Extension entrypoint ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Coordinator section registration (task 14) ───────────────────────────
  // Registers the ultrawork directive as a prompt section via the
  // hook-coordinator event bus. Priority 220 (loop-engine band 200-299)
  // ensures it appears AFTER the persona section (100-199). Never a raw
  // before_agent_start — only the coordinator owns that hook.
  // Mirrors the primary-agents pattern: immediate emit + :ready re-emit,
  // dedup by name "ultrawork-directive".

  const section = {
    name: "ultrawork-directive",
    priority: 220,
    getText: () => getDirectiveText(),
  };

  // Immediate attempt (works if coordinator already loaded).
  pi.events.emit("hook-coordinator:register-section", section);

  // Fallback for late coordinator: re-emit when coordinator signals ready.
  pi.events.on("hook-coordinator:ready", () => {
    pi.events.emit("hook-coordinator:register-section", section);
  });

  // ── Evidence-gate continuation intent (task 16) ──────────────────────────
  // Registered via the coordinator's event bus — NEVER a raw agent_end
  // handler. When HEAVY-tier ultrawork is active and evidence is missing,
  // blocks "done" with a re-prompt. Collapses with ralph (priority 205) via
  // the arbiter: priority 203 < 205, so evidence-gate is checked FIRST.
  // LIGHT tier or ultrawork inactive → abstains.

  const evidenceIntent = {
    name: "ultrawork-evidence-gate",
    priority: 203,
    decide: () => {
      if (!isActive()) return undefined;
      if (getTier() !== "HEAVY") return undefined;
      if (evidencePresent()) return undefined;
      return evidenceRePrompt();
    },
  };

  // Immediate attempt (works if coordinator already loaded).
  pi.events.emit("hook-coordinator:register-continuation", evidenceIntent);

  // Fallback for late coordinator: re-emit when coordinator signals ready.
  pi.events.on("hook-coordinator:ready", () => {
    pi.events.emit("hook-coordinator:register-continuation", evidenceIntent);
  });

  // ── /ultrawork command ────────────────────────────────────────────────────

  pi.registerCommand("ultrawork", {
    description:
      "Activate ultrawork mode. /ultrawork <task> enables with auto-detected tier. " +
      "/ultrawork (no args) toggles off when active, or shows usage when inactive.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (!trimmed) {
        if (active) {
          // Deactivate.
          active = false;
          task = "";
          tier = "HEAVY";
          persist(pi);
          ctx.ui.notify("Ultrawork mode deactivated. Directive cleared.", "info");
        } else {
          ctx.ui.notify(
            "Ultrawork is inactive. Use /ultrawork <task description> to activate.",
            "info",
          );
        }
        return;
      }

      // Activate.
      active = true;
      task = trimmed;
      tier = detectTier(trimmed);
      persist(pi);

      // Create the durable notepad (task 15).
      // Uses .ohpi/notepad/ as the preferred home, falls back to temp if unavailable.
      const { path, fromFallback } = createNotepadFile(process.cwd(), trimmed);
      notepadPath = path;
      needsReRead = true;
      persistNotepadPath(pi, path, fromFallback);

      const homeLabel = fromFallback ? "temp dir" : ".ohpi/notepad/";
      ctx.ui.notify(`ULTRAWORK MODE ENABLED! (${tier}) Notepad: ${path} (${homeLabel})`, "info");
    },
  });

  // ── Session restore ───────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Scan entries for the last ultrawork record (last-wins).
    let restored: UltraworkState | null = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as Partial<UltraworkState> | undefined;
        if (data) {
          restored = {
            active: data.active ?? false,
            tier: (data.tier as "LIGHT" | "HEAVY") ?? "HEAVY",
            task: data.task ?? "",
          };
        }
      }
    }

    if (restored) {
      active = restored.active;
      tier = restored.tier;
      task = restored.task;
    }

    // Restore notepad path from ulw-notepad entries (task 15).
    // Own entry type — does NOT scan todo-list entries.
    const notepadRecord = findNotepadFromEntries(ctx.sessionManager.getEntries());
    if (notepadRecord) {
      notepadPath = notepadRecord.path;
      if (active && notepadFileExists(notepadPath)) {
        needsReRead = true;
      } else if (!notepadFileExists(notepadPath)) {
        // File deleted on disk — clear the stale path.
        notepadPath = null;
      }
    }
  });

  // ── Context hook: re-read notepad injection ─────────────────────────────
  // On the first turn after session restore or ultrawork activation, inject a
  // re-read instruction so the agent picks up the current notepad state.
  // Mimics todo's reminder pattern: pushed user message, ephemeral per-turn.

  pi.on("context", (event) => {
    if (!needsReRead || !notepadPath || !active) return;
    needsReRead = false;

    const instruction =
      `[ultrawork notepad] Re-read the working-memory notepad at ${notepadPath}. ` +
      "The notepad survives context loss and contains your Plan, Scenarios, Now (current step), " +
      "Todo, Findings, and Learnings. It is APPEND-ONLY — never overwrite it. " +
      "Start each turn by checking the notepad state, especially ## Now and ## Todo.";

    return {
      messages: [
        ...event.messages,
        { role: "user" as const, content: instruction, timestamp: Date.now() },
      ],
    };
  });

  // ── Turn tracking (for context awareness) ─────────────────────────────────

  pi.on("turn_start", () => {
    // No-op for now — task 14 wires the directive injection via coordinator.
    // This hook is reserved for future turn-level behavior (e.g. reminder
    // injection when ultrawork is active but the model hasn't touched the
    // notepad after N turns).
  });
}

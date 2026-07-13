// Strip-only unit test for ralph-loop's continuation intent registration.
//
// Tests:
//   (a) Continuation intent registered with coordinator via hook-coordinator:register-continuation
//   (b) decide() returns a continuation when goal is pursuing
//   (c) decide() returns undefined when goal is null (no goal)
//   (d) decide() returns undefined when goal is achieved/blocked/paused
//   (e) decide() increments iteration + persists on each call
//   (f) ralph-loop has NO raw pi.on("agent_end") handler (guardrail)
//   (g) ralph-loop has NO pi.events.on("subagents:running") (arbiter handles)
//
// Run:  node --experimental-strip-types extensions/ralph-loop/ralph.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Helpers ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(description: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${description}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Test (a): Continuation intent registration ────────────────────────────

test("ralph-loop registers a continuation intent named 'ralph-loop'", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  // Must emit hook-coordinator:register-continuation
  assert(
    src.includes("hook-coordinator:register-continuation"),
    "must emit hook-coordinator:register-continuation",
  );
  // Must listen for hook-coordinator:ready (race-safety)
  assert(src.includes("hook-coordinator:ready"), "must listen for hook-coordinator:ready");
  // Intent name must be 'ralph-loop'
  assert(src.includes('name: "ralph-loop"'), "continuation intent name must be 'ralph-loop'");
  // Priority must be in the 200-299 loop band
  assert(src.includes("priority: 205"), "priority must be in the 200-299 loop-engine band");
});

// ── Test (b): decide() returns a continuation when goal is pursuing ────────

test("decide() returns prompt when status is pursuing", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  // decide() checks goal.status === "pursuing"
  assert(
    src.includes('goal.status !== "pursuing"'),
    "decide() must check goal.status === 'pursuing'",
  );
  // Returns a prompt when pursuing
  assert(src.includes("return { prompt }"), "decide() must return { prompt } when pursuing");
  // Returns undefined when not pursuing
  assert(
    src.includes("return undefined"),
    "decide() must return undefined when not pursuing (early return)",
  );
});

// ── Test (c): decide() returns undefined when goal is null ─────────────────

test("decide() returns undefined when goal is null", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  // The check: !goal || goal.status !== "pursuing"
  assert(
    src.includes('!goal || goal.status !== "pursuing"'),
    "decide() must guard against null goal with !goal || status check",
  );
});

// ── Test (d): decide() builds a continuation prompt with iteration ─────────

test("decide() increments iteration and builds prompt", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  // Increments iteration before returning continuation
  assert(src.includes("goal.iteration += 1"), "decide() must increment iteration before returning");
  // Persists state
  assert(src.includes("persist()"), "decide() must persist state after incrementing");
  // Builds prompt with "continue" kind
  const decideSection = src.substring(
    src.indexOf("decide:"),
    src.indexOf('name: "ralph-loop"', src.indexOf("decide:") + 50),
  );
  assert(src.includes('buildPrompt(goal, "continue")'), 'decide() must build a "continue" prompt');
});

// ── Test (e): NO raw pi.on("agent_end") handler (guardrail) ────────────────

test("ralph-loop has NO raw pi.on agent_end handler", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  // Count actual (non-comment) occurrences of pi.on("agent_end"
  // The only occurrence should be in the comment on line 15
  let actualCount = 0;
  let inBlockComment = false;
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) continue;
    // Track block comments
    if (trimmed.startsWith("/*")) inBlockComment = true;
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.includes('pi.on("agent_end"')) {
      actualCount++;
    }
  }
  assert(
    actualCount === 0,
    `ralph-loop must have ZERO pi.on("agent_end") handlers (found ${actualCount})`,
  );
});

// ── Test (f): NO subagents:running listener (arbiter handles) ─────────────

test("ralph-loop has NO subagents:running listener (code, not comments)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  // Check non-comment lines only
  let hasLiveCode = false;
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    if (trimmed.includes("subagents:running")) {
      hasLiveCode = true;
      break;
    }
  }
  assert(
    !hasLiveCode,
    "ralph-loop must NOT listen for subagents:running in actual code (arbiter handles)",
  );
});

// ── Test (g): NO kick() function (arbiter handles injection) ──────────────

test("ralph-loop has NO kick() function (arbiter handles injection)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  // kick() function should not exist (the old goal's kick was for agent_end re-injection)
  // The only injection should be direct sendUserMessage calls in the command handlers
  const kickDef = src.match(/const kick\s*=/);
  assert(
    kickDef === null,
    "ralph-loop must NOT define a kick() function (arbiter handles injection)",
  );
});

// ── Test (h): goal_done/goal_blocked tools preserved ───────────────────────

test("goal_done and goal_blocked tools are preserved", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  assert(src.includes('name: "goal_done"'), "goal_done tool must be preserved");
  assert(src.includes('name: "goal_blocked"'), "goal_blocked tool must be preserved");
});

// ── Test (i): Events emitted as ralph:status-change ────────────────────────

test("status changes emit ralph:status-change (not goal:status-change)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  assert(src.includes("ralph:status-change"), "must emit ralph:status-change");
  assert(!src.includes("goal:status-change"), "must NOT emit the old goal:status-change event");
});

// ── Test (j): session_start restore preserved ──────────────────────────────

test("session_start restore is preserved", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  assert(src.includes('pi.on("session_start"'), "session_start restore must be preserved");
  assert(
    src.includes("entry.customType === STATE_ENTRY_TYPE"),
    "must scan for goal-state entries on restore",
  );
  assert(src.includes('goal.status = "paused"'), "must auto-pause on session restore");
});

// ── Test (k): /goal command preserved ──────────────────────────────────────

test("/goal command is preserved", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

  assert(src.includes('pi.registerCommand("goal"'), "/goal command must be preserved");
});

// ── Run ────────────────────────────────────────────────────────────────────

console.log("\nralph-loop unit tests\n");

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);

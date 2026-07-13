// Strip-only unit test for hook-coordinator's continuation arbiter (C2).
//
// What this tests:
//   (a) Two registered intents both wanting to continue — exactly ONE
//       injection (the higher-priority one wins).
//   (b) Subagents-running hold: while count > 0, resolveContinuation()
//       returns undefined (no injection).
//   (c) Intent returning undefined abstains — next priority wins.
//   (d) No intents registered — undefined (no injection).
//
// Run:  node --experimental-strip-types extensions/hook-coordinator/arbiter.test.ts
// Or:   npx tsx extensions/hook-coordinator/arbiter.test.ts

import { __continuations, resolveContinuation, setRunningSubagentsForTest } from "./index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

function reset(): void {
  __continuations.clear();
  setRunningSubagentsForTest(0);
}

function register(
  name: string,
  priority: number,
  decide: () => { prompt: string; deliverAs?: "followUp" } | undefined,
): void {
  __continuations.set(name, { name, priority, decide, order: __continuations.size });
}

// ── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(description: string, fn: () => void): void {
  reset();
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

// ── Tests ─────────────────────────────────────────────────────────────────

// (a) Two intents both wanting to continue — exactly ONE (higher priority wins)
test("two intents → only higher-priority wins", () => {
  register("low-priority", 300, () => ({ prompt: "LOW_WINS" }));
  register("high-priority", 100, () => ({ prompt: "HIGH_WINS" }));

  const result = resolveContinuation();

  assert(result !== undefined, "should return a continuation");
  assert(result!.prompt === "HIGH_WINS", `expected 'HIGH_WINS', got '${result!.prompt}'`);
});

// (a-var) Abstaining intent in between — next priority wins
test("abstaining intent → next priority wins", () => {
  register("high-abstain", 50, () => undefined);
  register("mid-continue", 200, () => ({ prompt: "MID_WINS" }));
  register("low-continue", 300, () => ({ prompt: "LOW_WINS" }));

  const result = resolveContinuation();

  assert(result !== undefined, "should return a continuation");
  assert(result!.prompt === "MID_WINS", `expected 'MID_WINS', got '${result!.prompt}'`);
});

// (b) Subagents running → hold (no injection)
test("subagents running → hold", () => {
  register("eager", 100, () => ({ prompt: "EAGER" }));
  setRunningSubagentsForTest(3);

  const result = resolveContinuation();

  assert(result === undefined, `expected undefined (hold), got '${result?.prompt ?? "undefined"}'`);
});

// (b-var) Subagents done (0) → injection resumes
test("subagents zero → injection resumes", () => {
  register("eager", 100, () => ({ prompt: "EAGER" }));
  setRunningSubagentsForTest(0);

  const result = resolveContinuation();

  assert(result !== undefined, "should return a continuation when subagents == 0");
  assert(result!.prompt === "EAGER", `expected 'EAGER', got '${result!.prompt}'`);
});

// (c) All abstain → undefined
test("all abstain → undefined", () => {
  register("nope1", 100, () => undefined);
  register("nope2", 200, () => undefined);

  const result = resolveContinuation();

  assert(result === undefined, "all should abstain → undefined");
});

// (d) No intents → undefined
test("no intents → undefined", () => {
  const result = resolveContinuation();

  assert(result === undefined, "no intents should return undefined");
});

// (e) Same priority → registration order (tie-break)
test("same priority → registration order", () => {
  register("first", 100, () => ({ prompt: "FIRST" }));
  register("second", 100, () => ({ prompt: "SECOND" }));

  const result = resolveContinuation();

  assert(result!.prompt === "FIRST", "tie-break: first-registered should win");
});

// (f) Re-registration overwrites by name
test("re-registration overwrites by name", () => {
  register("dynamic", 100, () => ({ prompt: "OLD" }));
  register("dynamic", 100, () => ({ prompt: "NEW" }));

  const result = resolveContinuation();

  assert(result!.prompt === "NEW", "re-registration should overwrite");
});

// ── Run ────────────────────────────────────────────────────────────────────

console.log("\nhook-coordinator arbiter unit tests\n");

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

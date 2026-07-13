// Strip-only unit test for hook-coordinator's composeSystemPrompt + registry.
//
// What this tests:
//   1. Two markers (MARKER_A, MARKER_B) both appear in the composed output.
//   2. They appear in priority order (lower priority number = earlier).
//   3. An empty getText() is skipped (no blank injection).
//   4. The base prompt is preserved as the first part.
//   5. Re-registration with the same name overwrites.
//
// Run:  npx tsx extensions/hook-coordinator/coordinator.test.ts
// Or:   node --import tsx extensions/hook-coordinator/coordinator.test.ts

import { __sections, composeSystemPrompt } from "./index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────

function reset(): void {
  __sections.clear();
}

// Simulate what the event-bus handler does when it receives a registration.
function register(name: string, priority: number, getText: () => string | undefined): void {
  __sections.set(name, { name, priority, getText, order: __sections.size });
}

// ── Tests ─────────────────────────────────────────────────────────────────

function test(description: string, fn: () => void): void {
  reset();
  try {
    fn();
    console.log(`  PASS  ${description}`);
  } catch (err) {
    console.error(`  FAIL  ${description}`);
    console.error(`        ${(err as Error).message}`);
    throw err;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ───────────────────────────────────────────────────────────────────────────

const MARKER_A = "<<<SECTION-A>>>";
const MARKER_B = "<<<SECTION-B>>>";
const BASE = "BASE_SYSTEM_PROMPT";

// Test 1: Both markers appear, in priority order (A=100, B=200 → A before B)
test("dual markers appear in priority order", () => {
  register("section-b", 200, () => MARKER_B);
  register("section-a", 100, () => MARKER_A);
  const result = composeSystemPrompt(BASE);

  const posA = result.indexOf(MARKER_A);
  const posB = result.indexOf(MARKER_B);

  assert(posA !== -1, `MARKER_A not found in: ${result}`);
  assert(posB !== -1, `MARKER_B not found in: ${result}`);
  assert(posA < posB, `MARKER_A should appear before MARKER_B (got A@${posA}, B@${posB})`);
  assert(result.startsWith(BASE), `Base prompt should be first (got: ${result.slice(0, 50)}...)`);
});

// Test 2: Same priority — tie broken by registration order
test("same priority → registration order", () => {
  register("first", 100, () => "FIRST");
  register("second", 100, () => "SECOND");
  const result = composeSystemPrompt(BASE);

  const posFirst = result.indexOf("FIRST");
  const posSecond = result.indexOf("SECOND");

  assert(
    posFirst < posSecond,
    `FIRST should appear before SECOND (got F@${posFirst}, S@${posSecond})`,
  );
});

// Test 3: Empty getText() is skipped
test("empty getText() is skipped", () => {
  register("visible", 100, () => "VISIBLE");
  register("empty", 200, () => "");
  register("undef", 300, () => undefined);
  const result = composeSystemPrompt(BASE);

  assert(result.includes("VISIBLE"), "VISIBLE should be present");
  assert(!result.includes("\n\n\n"), "No triple blank lines (empty sections not injected)");
  // The empty sections shouldn't add blank separators
  const parts = result.split("\n\n");
  assert(parts.length === 2, `Expected 2 parts (base + VISIBLE), got ${parts.length}: ${parts}`);
});

// Test 4: Re-registration overwrites
test("re-registration overwrites by name", () => {
  register("dynamic", 100, () => "OLD");
  register("dynamic", 100, () => "NEW");
  const result = composeSystemPrompt(BASE);

  assert(result.includes("NEW"), "Should contain NEW after re-registration");
  assert(!result.includes("OLD"), "Should NOT contain OLD after re-registration");
});

// Test 5: No sections → base prompt unchanged
test("no sections → base prompt unchanged", () => {
  const result = composeSystemPrompt(BASE);
  assert(result === BASE, `Should return base prompt unchanged (got: ${result})`);
});

// Test 6: Single section
test("single section appended correctly", () => {
  register("solo", 100, () => "SOLO");
  const result = composeSystemPrompt(BASE);
  assert(result === `${BASE}\n\nSOLO`, `Expected '${BASE}\\n\\nSOLO', got: ${result}`);
});

// ── Run ────────────────────────────────────────────────────────────────────

console.log("\nhook-coordinator unit tests\n");

try {
  // All tests run sequentially (reset() called in each test())
} catch {
  // Caught inside test()
}

console.log("");

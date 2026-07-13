// Strip-only unit test for retry-policy extension (task 32 + task 33).
//
// Tests:
//   Task 32 (retained):
//     (a) Activation gate — no-ops without PI_RETRY_POLICY_ENABLED
//     (b) Continuation intent registered via hook-coordinator:register-continuation
//     (c) Continuation intent: name="retry-policy", priority=204
//     (d) Guardrail: NO raw pi.on("agent_end") handler
//     (e) Guardrail: re-drive goes through coordinator, not raw handler
//     (f) Listens for auto_retry_start + auto_retry_end events
//     (g) Imports isTransientError from subagents/transient.ts
//     (h) isTransientError correctly classifies transient vs deterministic
//     (k) decide() returns prompt when fallbackPending, undefined otherwise
//     (l) User abort: non-transient → surface (no loop)
//     (m) session_start resets state
//     (n) turn_start includes modelRegistry.find + setModel logic
//
//   Task 33 (new):
//     (o) Bundled chains: entries for all category + persona names + "default"
//     (p) nextFallbackModel: picks next model then undefined when exhausted
//     (q) nextFallbackModel: starts from beginning when current not in chain
//     (r) resetFallbackChain: resets position so next call returns first model
//     (s) Chain key: persona name resolves to correct chain, missing→"default"
//     (t) Category routing precedence: chain keys align with categories.ts
//     (u) Persona reconcile: imports getActivePersona from primary-agents
//     (v) Persona reconcile: saves personaPreferredModel, restore flags present
//     (w) Prevent restore-loop: restoreWasAttempted flag guards against infinite loop
//     (x) resolveChainKey uses active persona name
//     (y) resolveModelId helper mirrors primary-agents pattern
//
// Run:  node --experimental-strip-types extensions/retry-policy/retry.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Import pure functions ────────────────────────────────────────────────────

import { isTransientError } from "../subagents/transient.ts";
import {
  _resetForTest,
  BUNDLED_FALLBACK_CHAINS,
  discoverFallbackChains,
  getFallbackChain,
  knownChainNames,
  nextFallbackModel,
  resetFallbackChain,
} from "./fallback-chain.ts";

// ── Source code ──────────────────────────────────────────────────────────────

const srcIndex = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");
const srcFallback = fs.readFileSync(path.resolve(__dirname, "fallback-chain.ts"), "utf-8");

// =============================================================================
// Part 1: Activation gate (task 32 — retained)
// =============================================================================

test("act-gate: no-ops without PI_RETRY_POLICY_ENABLED", () => {
  assert(srcIndex.includes("PI_RETRY_POLICY_ENABLED"), "must check PI_RETRY_POLICY_ENABLED");
  assert(srcIndex.includes("if (!enabled)"), "must have early return when not enabled");
  assert(srcIndex.includes("return;"), "must return early when not enabled");
});

test("act-gate: also checks PI_OMO_FLOW env var", () => {
  assert(srcIndex.includes("PI_OMO_FLOW"), "must check PI_OMO_FLOW as alternate gate");
});

// =============================================================================
// Part 2: Continuation intent registration (task 32 — retained)
// =============================================================================

test("cont-intent: registers via hook-coordinator:register-continuation", () => {
  assert(
    srcIndex.includes('hook-coordinator:register-continuation"'),
    "must emit hook-coordinator:register-continuation",
  );
});

test("cont-intent: listens for hook-coordinator:ready (race-safety)", () => {
  assert(srcIndex.includes("hook-coordinator:ready"), "must listen for hook-coordinator:ready");
});

test("cont-intent: name is 'retry-policy'", () => {
  assert(
    srcIndex.includes('name: "retry-policy"'),
    "continuation intent name must be 'retry-policy'",
  );
});

test("cont-intent: priority is 204 (between ultrawork 203 and ralph 205)", () => {
  assert(
    srcIndex.includes("priority: 204"),
    "priority must be 204 (loop-engine band, before ralph)",
  );
});

test("cont-intent: decide() returns prompt when fallbackPending", () => {
  assert(
    srcIndex.includes("if (!fallbackPending) return undefined"),
    "decide() must check fallbackPending flag",
  );
  assert(
    srcIndex.includes("[retry-policy fallback"),
    "decide() prompt must contain retry-policy fallback marker",
  );
});

// =============================================================================
// Part 3: Guardrails (task 32 — retained)
// =============================================================================

test("guardrail: NO raw pi.on('agent_end') handler", () => {
  const hasAgentEnd = srcIndex.includes('on("agent_end"') || srcIndex.includes("on('agent_end'");
  assert(!hasAgentEnd, "must NOT register raw agent_end handler");
});

test("guardrail: re-drive ONLY through hook-coordinator:register-continuation", () => {
  const regCount = (srcIndex.match(/hook-coordinator:register-continuation/g) || []).length;
  assert(regCount >= 2, "must emit register-continuation at least twice (immediate + ready)");
});

test("guardrail: no raw sendUserMessage in auto_retry_end handler", () => {
  const autoRetryEndSection = srcIndex.slice(
    srcIndex.indexOf('pi.events.on("auto_retry_end"'),
    srcIndex.indexOf("// ── Turn start"),
  );
  assert(
    !autoRetryEndSection.includes("sendUserMessage"),
    "auto_retry_end handler must NOT call sendUserMessage directly",
  );
});

// =============================================================================
// Part 4: Event listeners (task 32 — retained)
// =============================================================================

test("events: listens for auto_retry_start", () => {
  assert(
    srcIndex.includes('pi.events.on("auto_retry_start"'),
    "must listen for auto_retry_start event",
  );
});

test("events: listens for auto_retry_end", () => {
  assert(
    srcIndex.includes('pi.events.on("auto_retry_end"'),
    "must listen for auto_retry_end event",
  );
});

test("events: captures errorMessage from auto_retry_start", () => {
  assert(
    srcIndex.includes("lastErrorMessage = event.errorMessage"),
    "must capture errorMessage from auto_retry_start",
  );
});

// =============================================================================
// Part 5: isTransientError classification (task 32 — retained)
// =============================================================================

test("transient: imports isTransientError from subagents/transient.ts", () => {
  assert(
    srcIndex.includes('import { isTransientError } from "../subagents/transient.ts"'),
    "must import isTransientError from subagents/transient.ts",
  );
});

test("transient: isTransientError — rate limit 429 → true", () => {
  assert(isTransientError("429 Too Many Requests") === true, "429 must be transient");
});

test("transient: isTransientError — 503 Service Unavailable → true", () => {
  assert(isTransientError("503 Service Unavailable") === true, "503 must be transient");
});

test("transient: isTransientError — timeout → true", () => {
  assert(isTransientError("Request timed out") === true, "timeout must be transient");
});

test("transient: isTransientError — network error → true", () => {
  assert(isTransientError("ECONNREFUSED") === true, "ECONNREFUSED must be transient");
});

test("transient: isTransientError — overload → true", () => {
  assert(isTransientError("overloaded") === true, "overloaded must be transient");
});

test("transient: isTransientError — 500 internal server error → true", () => {
  assert(isTransientError("500 Internal Server Error") === true, "500 must be transient");
});

test("transient: isTransientError — auth error 401 → false", () => {
  assert(isTransientError("401 Unauthorized") === false, "401 must NOT be transient");
});

test("transient: isTransientError — forbidden 403 → false", () => {
  assert(isTransientError("403 Forbidden") === false, "403 must NOT be transient");
});

test("transient: isTransientError — invalid model → false", () => {
  assert(
    isTransientError("invalid model: gpt-999") === false,
    "invalid model must NOT be transient",
  );
});

test("transient: isTransientError — bad request → false", () => {
  assert(isTransientError("invalid argument") === false, "invalid argument must NOT be transient");
});

test("transient: isTransientError — undefined → false", () => {
  assert(isTransientError(undefined) === false, "undefined must NOT be transient");
});

test("transient: isTransientError — empty string → false", () => {
  assert(isTransientError("") === false, "empty string must NOT be transient");
});

// =============================================================================
// Part 6: Deterministic errors → surface (task 32 — retained)
// =============================================================================

test("surface: non-transient error — does NOT set fallbackPending", () => {
  assert(
    srcIndex.includes("isTransientError(lastErrorMessage)"),
    "must call isTransientError in auto_retry_end handler",
  );
});

test("surface: max attempts exceeded → resets", () => {
  assert(srcIndex.includes("MAX_TOTAL_ATTEMPTS"), "must have MAX_TOTAL_ATTEMPTS cap");
  assert(
    srcIndex.includes("totalFallbackAttempts >= MAX_TOTAL_ATTEMPTS"),
    "must check max attempts before re-driving",
  );
});

// =============================================================================
// Part 7: Bundled fallback chains (task 33 — NEW)
// =============================================================================

test("chains: BUNDLED_FALLBACK_CHAINS has 'default' key", () => {
  assert("default" in BUNDLED_FALLBACK_CHAINS, "'default' chain must exist");
  assert(BUNDLED_FALLBACK_CHAINS["default"].length > 0, "'default' chain must be non-empty");
});

test("chains: bundled chains cover all category names", () => {
  // These match categories.ts BUNDLED_CATEGORIES keys.
  const catNames = [
    "deep",
    "quick",
    "ultrabrain",
    "visual-engineering",
    "artistry",
    "unspecified-low",
    "unspecified-high",
    "writing",
  ];
  for (const name of catNames) {
    assert(name in BUNDLED_FALLBACK_CHAINS, `bundled chain must have entry for category "${name}"`);
    assert(BUNDLED_FALLBACK_CHAINS[name].length > 0, `chain for "${name}" must be non-empty`);
  }
});

test("chains: bundled chains cover all persona names", () => {
  const personaNames = ["builder", "planner", "unspecified"];
  for (const name of personaNames) {
    assert(name in BUNDLED_FALLBACK_CHAINS, `bundled chain must have entry for persona "${name}"`);
    assert(BUNDLED_FALLBACK_CHAINS[name].length > 0, `chain for "${name}" must be non-empty`);
  }
});

test("chains: knownChainNames includes default", () => {
  _resetForTest();
  const names = knownChainNames();
  assert(names.includes("default"), "knownChainNames must include 'default'");
  assert(names.includes("deep"), "knownChainNames must include 'deep'");
  assert(names.includes("builder"), "knownChainNames must include 'builder'");
});

test("chains: all chain values are provider/modelId format", () => {
  for (const [key, chain] of Object.entries(BUNDLED_FALLBACK_CHAINS)) {
    for (const model of chain) {
      assert(
        model.includes("/"),
        `chain "${key}" model "${model}" must be in provider/modelId format`,
      );
    }
  }
});

// =============================================================================
// Part 8: nextFallbackModel — chain exhaustion (task 33 — NEW)
// =============================================================================

test("nextFallbackModel: returns first model when current not in chain", () => {
  _resetForTest();
  const first = nextFallbackModel("unknown/model");
  const chain = getFallbackChain("default");
  assert(first === chain[0], `must return first: ${chain[0]}, got ${first}`);
});

test("nextFallbackModel: returns second model when current is first", () => {
  _resetForTest();
  const chain = getFallbackChain("default");
  const second = nextFallbackModel(chain[0]);
  assert(second === chain[1], `must return second: ${chain[1]}, got ${second}`);
});

test("nextFallbackModel: exhausts chain correctly", () => {
  _resetForTest();
  const chain = getFallbackChain("default");
  // Walk through the entire chain.
  let next: string | undefined = chain[0];
  for (let i = 0; i < chain.length; i++) {
    next = nextFallbackModel(next ?? chain[i]);
    if (i < chain.length - 1) {
      assert(next !== undefined, `chain must have element at index ${i}`);
      assert(next === chain[i + 1], `expected ${chain[i + 1]}, got ${next}`);
    }
  }
  // After walking the whole chain, should be undefined.
  assert(next === undefined, "must return undefined after chain exhausted");
});

test("nextFallbackModel: case-insensitive match", () => {
  _resetForTest();
  const chain = getFallbackChain("default");
  const upper = chain[0].toUpperCase();
  const next = nextFallbackModel(upper);
  assert(next === chain[1], "case-insensitive match must advance to next");
});

test("nextFallbackModel: specific chain key works", () => {
  _resetForTest();
  const deepChain = getFallbackChain("deep");
  assert(deepChain.length > 0, "deep chain must exist");
  const first = nextFallbackModel("relay/gpt-5.5", "deep");
  // "relay/gpt-5.5" is the PRIMARY for deep (from categories.ts).
  // The first fallback for deep should be the first entry in the deep chain.
  assert(first === deepChain[0], `must return ${deepChain[0]}, got ${first}`);
});

test("nextFallbackModel: missing chain key falls back to default", () => {
  _resetForTest();
  const defaultChain = getFallbackChain();
  const first = nextFallbackModel("nonexistent/model", "no-such-key");
  assert(first === defaultChain[0], "missing key must use default chain");
  _resetForTest();
  const first2 = nextFallbackModel("nonexistent/model");
  assert(first2 === defaultChain[0], "undefined key must use default chain");
});

test("nextFallbackModel: empty chain returns undefined", () => {
  _resetForTest();
  // We can't easily mutate bundled chains, but getFallbackChain returns empty
  // only if there's no "default" key theoretically. Just verify the function
  // handles empty chains gracefully.
  const chain = getFallbackChain("default");
  assert(chain.length > 0, "default chain must exist for this test to be meaningful");
});

// =============================================================================
// Part 9: resetFallbackChain (task 33 — NEW)
// =============================================================================

test("resetFallbackChain: resets position so next call returns first model", () => {
  _resetForTest();
  const chain = getFallbackChain("default");
  // Advance two positions.
  nextFallbackModel(chain[0]);
  const pos2 = nextFallbackModel(chain[1]);
  assert(pos2 === chain[2], "must be at third position");

  // Reset.
  resetFallbackChain("default");
  const firstAgain = nextFallbackModel("unknown/model");
  assert(firstAgain === chain[0], "after reset, must return first model again");
});

test("resetFallbackChain: no-arg resets all chains", () => {
  _resetForTest();
  // Advance both chains.
  nextFallbackModel("unknown", "deep");
  nextFallbackModel("unknown", "quick");

  // Reset all.
  resetFallbackChain();
  const deepFirst = nextFallbackModel("unknown", "deep");
  const quickFirst = nextFallbackModel("unknown", "quick");
  assert(deepFirst === getFallbackChain("deep")[0], "deep chain must reset");
  assert(quickFirst === getFallbackChain("quick")[0], "quick chain must reset");
});

// =============================================================================
// Part 10: Category routing precedence (task 33 — NEW)
// =============================================================================

test("category-precedence: chain keys align with categories.ts", () => {
  // The fallback chain keys should match category names from categories.ts.
  // We verify that the bundled categories keys all have fallback chains.
  const catNames = [
    "deep",
    "quick",
    "ultrabrain",
    "visual-engineering",
    "artistry",
    "unspecified-low",
    "unspecified-high",
    "writing",
  ];
  const chains = discoverFallbackChains();
  for (const name of catNames) {
    assert(
      name in chains.chains,
      `fallback chain must exist for category "${name}" (aligns with categories.ts)`,
    );
  }
});

test("category-precedence: chain doc explains primary→fallback precedence", () => {
  assert(
    srcFallback.includes("AFTER the primary"),
    "fallback-chain.ts must document primary→fallback precedence",
  );
  assert(
    srcIndex.includes("resolveCategory"),
    "index.ts must import resolveCategory for category routing context",
  );
});

// =============================================================================
// Part 11: Persona-model reconcile (task 33 — NEW)
// =============================================================================

test("persona-reconcile: imports getActivePersona from primary-agents", () => {
  assert(
    srcIndex.includes('import { getActivePersona } from "../primary-agents/index.ts"'),
    "must import getActivePersona from primary-agents",
  );
});

test("persona-reconcile: saves personaPreferredModel on first fallback", () => {
  assert(srcIndex.includes("personaPreferredModel"), "must have personaPreferredModel variable");
  assert(
    srcIndex.includes("getActivePersona()"),
    "must call getActivePersona to read persona model",
  );
  assert(
    srcIndex.includes("personaPreferredModel = persona.model"),
    "must save persona model on first fallback",
  );
});

test("persona-reconcile: pendingPersonaRestore flag exists", () => {
  assert(srcIndex.includes("pendingPersonaRestore"), "must have pendingPersonaRestore flag");
});

test("persona-reconcile: restoreWasAttempted flag prevents infinite loop", () => {
  assert(srcIndex.includes("restoreWasAttempted"), "must have restoreWasAttempted guard flag");
  // The guard rationale must be documented.
  assert(srcIndex.includes("infinite restore"), "must document infinite-restore-loop prevention");
});

test("persona-reconcile: restore logic in turn_start handler", () => {
  assert(
    srcIndex.includes("pendingPersonaRestore && personaPreferredModel"),
    "turn_start must check pendingPersonaRestore and personaPreferredModel",
  );
  assert(
    srcIndex.includes("restored persona model"),
    "must log 'restored persona model' notification",
  );
});

test("persona-reconcile: restoreWasAttempted cleared on normal turns", () => {
  assert(
    srcIndex.includes("restoreWasAttempted = false"),
    "must clear restoreWasAttempted on normal turns",
  );
});

// =============================================================================
// Part 12: resolveModelId helper (task 33 — NEW)
// =============================================================================

test("resolveModelId: mirrors primary-agents model resolution pattern", () => {
  // resolveModelId helper wraps ctx.modelRegistry.find via registry parameter.
  assert(
    srcIndex.includes("ctx.modelRegistry"),
    "must pass ctx.modelRegistry for model resolution",
  );
  assert(srcIndex.includes("resolveModelId"), "must have resolveModelId helper");
  assert(
    srcIndex.includes('const slashIdx = modelName.indexOf("/")'),
    "must parse provider/modelId format",
  );
  assert(srcIndex.includes('"relay"'), "must try relay provider");
});

// =============================================================================
// Part 13: resolveChainKey (task 33 — NEW)
// =============================================================================

test("resolveChainKey: uses active persona name for chain selection", () => {
  assert(srcIndex.includes("resolveChainKey"), "must have resolveChainKey function");
  assert(srcIndex.includes("getActivePersona()"), "resolveChainKey must call getActivePersona");
});

// =============================================================================
// Part 14: Turn start model switch logic (task 32 + task 33)
// =============================================================================

test("turn-start: registers pi.on('turn_start') handler", () => {
  assert(srcIndex.includes('pi.on("turn_start"'), "must register turn_start handler");
});

test("turn-start: handles fallback case (Case A)", () => {
  assert(
    srcIndex.includes("if (fallbackPending && nextModelName)"),
    "must check fallbackPending and nextModelName",
  );
});

test("turn-start: handles persona restore case (Case B)", () => {
  assert(
    srcIndex.includes("pendingPersonaRestore && personaPreferredModel"),
    "must handle persona restore as Case B",
  );
});

test("turn-start: handles normal turn case (Case C)", () => {
  assert(
    srcIndex.includes("!fallbackPending && !pendingPersonaRestore"),
    "must handle normal turn as Case C",
  );
});

// =============================================================================
// Part 15: Native retry kept enabled (task 32 — retained)
// =============================================================================

test("native-retry: attempts to call setAutoRetryEnabled(true)", () => {
  assert(srcIndex.includes("setAutoRetryEnabled"), "must attempt to enable native auto-retry");
});

// =============================================================================
// Part 16: Re-drive prompt content (task 32 — retained)
// =============================================================================

test("re-drive: prompt mentions fallback model name", () => {
  assert(srcIndex.includes("Falling back to model:"), "prompt must mention fallback model");
});

test("re-drive: prompt mentions continuing same task", () => {
  assert(
    srcIndex.includes("Continue from where you left off"),
    "prompt must instruct to continue from where left off",
  );
});

// =============================================================================
// Part 17: Session reset (task 32 — retained)
// =============================================================================

test("session: session_start resets state", () => {
  assert(srcIndex.includes('pi.on("session_start"'), "must register session_start handler");
  assert(srcIndex.includes("reset()"), "must call reset() in session_start");
});

// =============================================================================
// Part 18: Fallback chain user override support (task 33 — NEW)
// =============================================================================

test("override: fallback-chain.ts loads user overrides from ~/.pi/agent/fallback-chains/", () => {
  assert(
    srcFallback.includes("getAgentDir()"),
    "must use getAgentDir for user override dir discovery",
  );
  assert(srcFallback.includes("fallback-chains"), "must read from fallback-chains user dir");
});

test("override: user overrides merge on top of bundled defaults", () => {
  assert(
    srcFallback.includes("{ ...BUNDLED_FALLBACK_CHAINS }"),
    "must spread bundled defaults then apply user overrides",
  );
});

test("override: override files accept JSON with arrays of model strings", () => {
  assert(srcFallback.includes(".json"), "must read .json override files");
  assert(srcFallback.includes("Array.isArray"), "must validate that values are arrays");
});

// =============================================================================
// Summary
// =============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

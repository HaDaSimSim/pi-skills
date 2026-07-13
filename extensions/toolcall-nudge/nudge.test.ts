// Strip-only unit test for toolcall-nudge extension (F1-reject fix).
//
// Verifies the Wave 2 migration off a raw agent_end continuation onto the
// hook-coordinator arbiter:
//
//   (a) Pure detector: looksLikeLeakedToolCall classifies leaks vs prose.
//   (b) Pure classifier: turnLeaked handles role/abort/toolCall/text cases.
//   (c) Guardrail: NO raw agent_end handler at all (source scan).
//   (d) Guardrail: the ONLY continuation send path is the arbiter — no
//       sendUserMessage / sendMessage anywhere in the source.
//   (e) Registers via hook-coordinator:register-continuation (immediate + ready).
//   (f) Continuation intent: name="toolcall-nudge", priority=250 (below real
//       loop/gate engines so a nudge never preempts them).
//   (g) Behaviour: the extension records leak state passively at turn_end and
//       the arbiter's decide() returns the NUDGE when a leak is pending,
//       undefined otherwise (proves the nudge flows via the intent, not a raw
//       handler).
//   (h) Loop guard: a second consecutive leak abstains (stops auto-retry).
//   (i) A real tool-call turn / clean turn / aborted turn → decide() abstains.
//
// Run:  node --experimental-strip-types extensions/toolcall-nudge/nudge.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(description: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      throw new Error("async tests not supported in this harness");
    }
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

// ── Import pure functions + the extension entrypoint ──────────────────────────

import extension, { looksLikeLeakedToolCall, turnLeaked } from "./index.ts";

const srcIndex = fs.readFileSync(path.resolve(__dirname, "index.ts"), "utf-8");

// A leaked block sample (as the model would erroneously print it).
const LEAKED = [
  "Sure, let me run that.",
  '<invoke name="bash">',
  '<parameter name="command">ls -la</parameter>',
  "</invoke>",
].join("\n");

// ── (a) Pure detector ─────────────────────────────────────────────────────────

test("detector: recognises a leaked <invoke>/<parameter> block", () => {
  assert(looksLikeLeakedToolCall(LEAKED), "should detect a real leaked block");
});

test("detector: recognises a lone <invoke>…</invoke> pair", () => {
  assert(
    looksLikeLeakedToolCall('<invoke name="read">x</invoke>'),
    "lone invoke open+close is conclusive",
  );
});

test("detector: ignores plain prose without tool-call tags", () => {
  assert(
    !looksLikeLeakedToolCall("I will call the bash tool to list files."),
    "prose mentioning tools must not trip",
  );
});

test("detector: a single tag mention is not enough", () => {
  assert(
    !looksLikeLeakedToolCall("The <function_calls> wrapper is how tools are invoked."),
    "one lone signal must not trip",
  );
});

// ── (b) Pure classifier ────────────────────────────────────────────────────────

test("turnLeaked: assistant text leak → true", () => {
  assert(
    turnLeaked({ role: "assistant", content: [{ type: "text", text: LEAKED }] }),
    "assistant leaked text should classify as leaked",
  );
});

test("turnLeaked: real tool call → false", () => {
  assert(
    !turnLeaked({
      role: "assistant",
      content: [{ type: "text", text: LEAKED }, { type: "toolCall" }],
    }),
    "a real ToolCall means nothing to fix",
  );
});

test("turnLeaked: aborted turn → false", () => {
  assert(
    !turnLeaked({
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: LEAKED }],
    }),
    "aborted turns must be left alone",
  );
});

test("turnLeaked: non-assistant message → false", () => {
  assert(
    !turnLeaked({ role: "user", content: [{ type: "text", text: LEAKED }] }),
    "user msg → false",
  );
});

test("turnLeaked: clean assistant text → false", () => {
  assert(
    !turnLeaked({ role: "assistant", content: [{ type: "text", text: "All done." }] }),
    "clean text → false",
  );
});

// ── (c) Guardrail: NO raw agent_end handler ────────────────────────────────────

test("guardrail: NO pi.on('agent_end') handler at all", () => {
  const hasAgentEnd = srcIndex.includes('on("agent_end"') || srcIndex.includes("on('agent_end'");
  assert(!hasAgentEnd, "toolcall-nudge must NOT register any agent_end handler");
});

// ── (d) Guardrail: continuation send ONLY via the arbiter ──────────────────────

test("guardrail: no sendUserMessage / sendMessage anywhere", () => {
  assert(
    !srcIndex.includes("sendUserMessage") && !srcIndex.includes("sendMessage"),
    "the nudge must be driven by the arbiter — no direct message sends in the extension",
  );
});

// ── (e)/(f) Registration + intent shape ────────────────────────────────────────

// Mock ExtensionAPI to capture the registered turn_end handler and continuation intent.
interface CapturedIntent {
  name: string;
  priority: number;
  decide: () => { prompt: string; deliverAs?: string } | undefined;
}

function instantiate() {
  let turnEnd: ((event: unknown, ctx: unknown) => void) | undefined;
  let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
  let intent: CapturedIntent | undefined;
  const counter = { registerCount: 0 };
  let readyListener: (() => void) | undefined;

  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => void) {
      if (name === "turn_end") turnEnd = handler;
      if (name === "session_start") sessionStart = handler;
    },
    events: {
      emit(name: string, payload: unknown) {
        if (name === "hook-coordinator:register-continuation") {
          intent = payload as CapturedIntent;
          counter.registerCount++;
        }
      },
      on(name: string, handler: () => void) {
        if (name === "hook-coordinator:ready") readyListener = handler;
      },
    },
  };

  extension(pi as any);

  const ctx = { hasUI: false } as const;
  return {
    intent,
    counter,
    readyListener,
    fireTurnEnd: (message: unknown) => turnEnd?.({ message }, ctx),
    fireSessionStart: () => sessionStart?.({}, ctx),
    reEmit: () => readyListener?.(),
  };
}

test("registration: emits register-continuation immediately + on ready", () => {
  const h = instantiate();
  assert(h.counter.registerCount >= 1, "must emit register-continuation immediately");
  assert(typeof h.readyListener === "function", "must listen for hook-coordinator:ready");
  h.reEmit();
  assert(h.counter.registerCount >= 2, "must re-emit on ready (race fallback)");
});

test("intent: name='toolcall-nudge', priority=250 (below real loop/gate engines)", () => {
  const h = instantiate();
  assert(!!h.intent, "intent must be registered");
  assert(
    h.intent!.name === "toolcall-nudge",
    `name should be toolcall-nudge, got ${h.intent!.name}`,
  );
  assert(h.intent!.priority === 250, `priority should be 250, got ${h.intent!.priority}`);
  // Must sit strictly above ralph(205)/retry(204)/gates(201-203) numerically.
  assert(
    h.intent!.priority > 205,
    "priority must be > 205 so a nudge never preempts a loop engine",
  );
});

// ── (g) Behaviour: nudge flows through decide(), not a raw handler ─────────────

test("decide: abstains when no leak recorded", () => {
  const h = instantiate();
  h.fireTurnEnd({ role: "assistant", content: [{ type: "text", text: "All done." }] });
  assert(h.intent!.decide() === undefined, "clean turn → decide abstains");
});

test("decide: returns the NUDGE after a leaked turn_end", () => {
  const h = instantiate();
  h.fireTurnEnd({ role: "assistant", content: [{ type: "text", text: LEAKED }] });
  const d = h.intent!.decide();
  assert(!!d, "leaked turn → decide must return a continuation");
  assert(
    d!.prompt.includes("<system-reminder>") && d!.prompt.includes("structured tool call"),
    "the continuation prompt must be the NUDGE",
  );
});

// ── (h) Loop guard: second consecutive leak abstains ───────────────────────────

test("loop guard: second consecutive leak → decide abstains (stops auto-retry)", () => {
  const h = instantiate();
  h.fireTurnEnd({ role: "assistant", content: [{ type: "text", text: LEAKED }] });
  assert(!!h.intent!.decide(), "first leak nudges");
  // Model leaked AGAIN on the next turn.
  h.fireTurnEnd({ role: "assistant", content: [{ type: "text", text: LEAKED }] });
  assert(h.intent!.decide() === undefined, "second consecutive leak must abstain");
});

test("recovery: leak → nudge → clean turn resets, next leak nudges again", () => {
  const h = instantiate();
  h.fireTurnEnd({ role: "assistant", content: [{ type: "text", text: LEAKED }] });
  assert(!!h.intent!.decide(), "first leak nudges");
  // A clean turn resets the streak.
  h.fireTurnEnd({ role: "assistant", content: [{ type: "text", text: "Fixed." }] });
  assert(h.intent!.decide() === undefined, "clean turn abstains + resets");
  // A fresh leak nudges again.
  h.fireTurnEnd({ role: "assistant", content: [{ type: "text", text: LEAKED }] });
  assert(!!h.intent!.decide(), "fresh leak after recovery nudges again");
});

// ── (i) decide abstains for real-tool-call / aborted turns ─────────────────────

test("decide: abstains after a real tool-call turn", () => {
  const h = instantiate();
  h.fireTurnEnd({ role: "assistant", content: [{ type: "toolCall" }] });
  assert(h.intent!.decide() === undefined, "real tool call → abstain");
});

test("decide: abstains after an aborted turn", () => {
  const h = instantiate();
  h.fireTurnEnd({
    role: "assistant",
    stopReason: "aborted",
    content: [{ type: "text", text: LEAKED }],
  });
  assert(h.intent!.decide() === undefined, "aborted → abstain");
});

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\ntoolcall-nudge: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

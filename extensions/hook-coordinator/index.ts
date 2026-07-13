// hook-coordinator — ordered prompt-injection spine + continuation arbiter for pi extensions.
//
// Owns the SINGLE `before_agent_start` handler AND the SINGLE `agent_end` handler.
// All other extensions MUST contribute their system-prompt injections and
// continuation intents through this coordinator's registries rather than
// registering raw handlers. This guarantees predictable composition order,
// prevents the chained-overwrite and double-inject hazards documented in
// Wave 0's hook-composition finding.
//
// ── before_agent_start registry (C1) ────────────────────────────────────────
//
//   1. Contributors listen for the ready signal:
//        pi.events.on("hook-coordinator:ready", () => { ... })
//
//   2. Then emit a registration payload:
//        pi.events.emit("hook-coordinator:register-section", {
//          name: "my-extension",        // unique; re-registration overwrites
//          priority: 200,               // lower = earlier in prompt; see conventions below
//          getText: () => "prompt text" // evaluated at each before_agent_start
//        });
//
//   3. As a race-condition fallback, contributors should ALSO emit
//      "hook-coordinator:register-section" immediately (before listening for
//      ready). The coordinator deduplicates by name so double-emission is
//      harmless.
//
//   Priority conventions:
//     0–99    system-critical (reserved)
//     100–199 persona / agent identity
//     200–299 loop engines (ultrawork, ralph)
//     300–399 feature extensions
//     400+    informational / user extensions
//
//   Ordering rule:
//     Sections are appended in ascending priority order (lower number = earlier
//     in the prompt). Ties are broken by registration order (Map insertion
//     order).
//
//   A section whose getText() returns empty/undefined is skipped — no blank
//   line is injected.
//
// ── agent_end continuation arbiter (C2) ──────────────────────────────────────
//
//   Contributors register CONTINUATION INTENTS via the event bus. At each
//   agent_end, the arbiter polls all registered intents in priority order and
//   injects EXACTLY ONE continuation (the first non-abstaining intent).
//
//   Registration:
//        pi.events.emit("hook-coordinator:register-continuation", {
//          name: "my-loop",              // unique; re-registration overwrites
//          priority: 200,                // lower = higher priority (checked first)
//          decide: () => { prompt: "...", deliverAs?: "followUp" } | undefined
//        });
//
//   decide() is called at each agent_end. Return undefined to abstain
//   (no continuation wanted this turn). Return a ContinuationDescriptor to
//   request continuation. The arbiter will inject exactly one continuation
//   per agent_end — the first non-abstaining intent by priority order wins.
//
//   Subagent hold:
//     While background subagents are running (tracked via
//     pi.events.on("subagents:running", { running: N })), the arbiter HOLDS
//     all continuation injection. When the last subagent finishes, the
//     "[subagent finished]" message creates a new turn, and at that turn's
//     agent_end (running==0) the arbiter resumes naturally. No separate
//     resume kick is needed — holding is sufficient.
//
//   Priority bands (same as before_agent_start):
//     100–199 persona (unlikely for continuations but valid)
//     200–299 loop engines (ultrawork, ralph)
//     300–399 feature extensions
//     400+    informational / user
//
//   One-per-edge guarantee:
//     Even if multiple intents want to continue, only the highest-priority
//     (lowest number) intent's prompt is injected. This prevents the
//     double-inject hazard confirmed in Wave 0.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Public types (for documentation / test) ─────────────────────────────────

/** Registration payload emitted on "hook-coordinator:register-section". */
export interface SectionRegistration {
  /** Unique name; re-registering the same name overwrites the prior entry. */
  name: string;
  /** Lower value = appended earlier. Ties broken by registration order. */
  priority: number;
  /** Called at each before_agent_start. Return undefined/empty to skip. */
  getText: () => string | undefined;
}

/** Returned by a continuation intent's decide() when it wants to continue. */
export interface ContinuationDescriptor {
  /** The user message to inject (becomes the next turn's prompt). */
  prompt: string;
  /**
   * Delivery mode for sendUserMessage. "followUp" queues after the current
   * turn if the agent is still streaming; omit for default (triggers
   * immediately when idle).
   */
  deliverAs?: "followUp";
}

/** Registration payload emitted on "hook-coordinator:register-continuation". */
export interface ContinuationIntent {
  /** Unique name; re-registering the same name overwrites the prior entry. */
  name: string;
  /** Lower value = higher priority (checked first). Ties broken by registration order. */
  priority: number;
  /**
   * Called at each agent_end. Return undefined to abstain (no continuation
   * this turn). Return a ContinuationDescriptor to request continuation.
   * The arbiter injects exactly ONE continuation per agent_end — the first
   * non-abstaining intent by priority order wins.
   */
  decide: () => ContinuationDescriptor | undefined;
}

// ── Internal registry (before_agent_start) ───────────────────────────────────

interface RegisteredSection extends SectionRegistration {
  /** Monotonic counter for tie-breaking (first-registered wins). */
  order: number;
}

/** Visible for testing — the prompt-section registry is a module-level singleton. */
export const __sections = new Map<string, RegisteredSection>();
let __order = 0;

function registerSection(section: SectionRegistration): void {
  __sections.set(section.name, { ...section, order: __order++ });
}

function sortedSections(): RegisteredSection[] {
  return Array.from(__sections.values()).sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.order - b.order;
  });
}

// ── Prompt composition ──────────────────────────────────────────────────────

/**
 * Compose the system prompt by appending all registered section texts (in
 * priority order) to the base prompt. Sections returning empty/undefined are
 * skipped. Exported for testing.
 */
export function composeSystemPrompt(base: string): string {
  const parts: string[] = [base];
  for (const s of sortedSections()) {
    const text = s.getText();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

// ── Internal registry (agent_end continuations) ──────────────────────────────

interface RegisteredContinuation extends ContinuationIntent {
  /** Monotonic counter for tie-breaking (first-registered wins). */
  order: number;
}

/** Visible for testing — the continuation-intent registry is a module-level singleton. */
export const __continuations = new Map<string, RegisteredContinuation>();
let __contOrder = 0;

function registerContinuation(intent: ContinuationIntent): void {
  __continuations.set(intent.name, { ...intent, order: __contOrder++ });
}

// ── Subagent hold (ported from goal) ────────────────────────────────────────

/**
 * Number of background subagents currently running. While > 0, the arbiter
 * holds all continuation injection because the "[subagent finished]" message
 * creates a fresh turn whose agent_end will naturally resume the loop.
 */
let __runningSubagents = 0;

/** Set the running subagent count (for unit tests; ESM imports are read-only). */
export function setRunningSubagentsForTest(n: number): void {
  __runningSubagents = n;
}

// ── Arbiter logic ───────────────────────────────────────────────────────────

/**
 * Resolve which continuation (if any) should be injected at this agent_end.
 * Returns the first non-abstaining intent by priority order, or undefined if
 * none want to continue OR if subagents are holding.
 * Exported for unit testing.
 */
export function resolveContinuation(): ContinuationDescriptor | undefined {
  // 1. Hold while background subagents are running.
  if (__runningSubagents > 0) return undefined;

  // 2. Sort by priority, then order.
  const sorted = Array.from(__continuations.values()).sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.order - b.order;
  });

  // 3. Take the first non-abstaining intent.
  for (const intent of sorted) {
    const result = intent.decide();
    if (result) return result;
  }
  return undefined;
}

// ── Continuation injection (ported from goal's kick) ─────────────────────────

/**
 * Inject EXACTLY ONE continuation via sendUserMessage. Deferred by one tick
 * (setTimeout(0)) to safely catch the timing where the agent transitions to
 * idle right after agent_end. Uses deliverAs followUp if still streaming.
 */
function injectContinuation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  descriptor: ContinuationDescriptor,
): void {
  setTimeout(() => {
    if (ctx.isIdle()) {
      pi.sendUserMessage(descriptor.prompt);
    } else {
      pi.sendUserMessage(descriptor.prompt, { deliverAs: descriptor.deliverAs ?? "followUp" });
    }
  }, 0);
}

// ── Extension entrypoint ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── before_agent_start setup (C1) ──────────────────────────────────────

  // 1a. Set up the section registration listener FIRST.
  pi.events.on("hook-coordinator:register-section", (data: unknown) => {
    const s = data as SectionRegistration | undefined;
    if (
      s &&
      typeof s.name === "string" &&
      typeof s.priority === "number" &&
      typeof s.getText === "function"
    ) {
      registerSection(s);
    }
  });

  // ── agent_end setup (C2) ───────────────────────────────────────────────

  // 1b. Set up the continuation-intent registration listener.
  pi.events.on("hook-coordinator:register-continuation", (data: unknown) => {
    const c = data as ContinuationIntent | undefined;
    if (
      c &&
      typeof c.name === "string" &&
      typeof c.priority === "number" &&
      typeof c.decide === "function"
    ) {
      registerContinuation(c);
    }
  });

  // 1c. Track running subagents for the hold.
  pi.events.on("subagents:running", (payload: { running?: number } | unknown) => {
    const p = payload as { running?: number } | undefined;
    __runningSubagents = typeof p?.running === "number" ? p.running : 0;
  });

  // 2. Signal contributors that ALL registries are ready. They listen for this
  //    and re-emit their registrations to handle the race where a contributor
  //    loaded before the coordinator.
  pi.events.emit("hook-coordinator:ready", {});

  // 3. SINGLE before_agent_start handler — compose all registered sections.
  pi.on("before_agent_start", (event) => {
    const combined = composeSystemPrompt(event.systemPrompt);
    if (combined !== event.systemPrompt) {
      return { systemPrompt: combined };
    }
  });

  // 4. SINGLE agent_end handler — arbitrate continuations to exactly ONE.
  pi.on("agent_end", (_event, ctx) => {
    const descriptor = resolveContinuation();
    if (descriptor) {
      injectContinuation(pi, ctx, descriptor);
    }
  });
}

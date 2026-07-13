// toolcall-nudge — catch tool calls the model "spoke" as plain text and make it
// retry with a real, structured tool call.
//
// The problem:
//   Sometimes the model does not emit a structured tool call. Instead it writes
//   the raw tool-call serialization as ordinary assistant text, e.g.
//
//     <function_calls>
//     <invoke name="bash">
//     <parameter name="command">ls -la</parameter>
//     </invoke>
//     </function_calls>
//
//   pi never sees a real ToolCall, so nothing runs. The turn just ends with that
//   XML sitting in the transcript and the user has to nudge "you didn't actually
//   run it" by hand.
//
// What this does (Wave 2 reframe — coordinator arbiter):
//   The corrective NUDGE is a CONTINUATION, so it MUST flow through the
//   hook-coordinator arbiter — never a raw agent_end injection. The core Wave 2
//   guardrail forbids >1 extension raw-injecting a continuation at agent_end
//   (double-inject hazard alongside ralph / gates / retry).
//
//   Detection is done PASSIVELY at turn_end: a non-injecting listener inspects
//   the just-finished turn's assistant message and records whether it looks like
//   a leaked tool-call block into a module var. The final turn of a prompt is a
//   leaked-text turn iff it carries no real ToolCall (a real tool call would
//   keep the run going), so the last turn_end before agent_end always reflects
//   the message the old agent_end handler used.
//
//   The continuation intent's decide() (called by the arbiter at each agent_end)
//   reads that recorded state and returns the NUDGE prompt when a leak is
//   pending. The arbiter injects exactly ONE continuation per edge, in priority
//   order, so the nudge can never double-inject alongside a real loop engine.
//
// Self-contained single-file extension. No deps beyond pi's bundled packages.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Patterns that strongly indicate the model serialized a tool call as text.
// We require a tag that names a tool/parameter, not just any angle brackets, to
// avoid tripping on prose that happens to mention XML or on legitimate code/docs
// the model is quoting back. Matching is case-insensitive and tolerant of the
// optional `antml:` namespace prefix Anthropic models sometimes emit.
const LEAK_PATTERNS: RegExp[] = [
  // <function_calls> ... </function_calls> wrapper
  /<\/?(?:antml:)?function_calls\b/i,
  // <invoke name="toolname"> — the per-call opener
  /<(?:antml:)?invoke\s+name\s*=/i,
  // <parameter name="..."> — per-argument opener
  /<(?:antml:)?parameter\s+name\s*=/i,
];

// A single match could be a false positive (e.g. the model explaining the syntax
// to the user). Requiring at least two distinct leak signals makes detection
// robust: a real leaked block always has both an <invoke ...> and a
// </invoke> or <parameter ...>, while prose about tool calls rarely does.
export function looksLikeLeakedToolCall(text: string): boolean {
  if (!text) return false;
  let hits = 0;
  for (const re of LEAK_PATTERNS) {
    if (re.test(text)) hits += 1;
    if (hits >= 2) return true;
  }
  // A lone <invoke name=...> with a closing tag is already conclusive.
  if (/<(?:antml:)?invoke\s+name\s*=/i.test(text) && /<\/(?:antml:)?invoke\s*>/i.test(text)) {
    return true;
  }
  return false;
}

const NUDGE = [
  "<system-reminder>",
  "Your previous message contained a tool call written as plain text (an <invoke>/<function_calls> XML block) instead of an actual structured tool call. That means nothing ran.",
  "",
  "Do not describe or print tool-call XML. Re-issue the intended call now as a real, structured tool call so the harness executes it. If you did not actually intend to call a tool, ignore this and continue.",
  "</system-reminder>",
].join("\n");

// ── Minimal shapes for the turn_end message (loosely typed against jiti) ──────

interface TurnEndLike {
  message?: {
    role?: string;
    stopReason?: string;
    content?: { type?: string; text?: string }[];
  };
}

/**
 * Classify a turn's assistant message: does it look like a leaked tool-call
 * block? Returns false for aborted turns, turns with a real ToolCall, and
 * clean/non-leaking text. Exported for unit testing.
 */
export function turnLeaked(message: TurnEndLike["message"]): boolean {
  if (message?.role !== "assistant") return false;
  // If the user aborted (Esc), don't fight it.
  if (message.stopReason === "aborted") return false;

  const content = message.content ?? [];
  // If the model already made a real tool call, there's nothing to fix.
  if (content.some((c) => c?.type === "toolCall")) return false;

  // Concatenate all text content and check for a leaked tool-call block.
  const text = content
    .filter((c) => c?.type === "text")
    .map((c) => c?.text ?? "")
    .join("\n");
  return looksLikeLeakedToolCall(text);
}

export default function (pi: ExtensionAPI) {
  // ── Passively recorded state (read by the arbiter's decide()) ─────────────
  // leakPending: the most recent turn ended with a leaked tool-call block.
  // nudgedLastPrompt: we already auto-nudged once for the current leak streak;
  //   if it leaks AGAIN we stop and let the user step in (loop guard).
  let leakPending = false;
  let nudgedLastPrompt = false;

  pi.on("session_start", async () => {
    leakPending = false;
    nudgedLastPrompt = false;
  });

  // ── PASSIVE turn_end listener — ONLY records state, never injects ─────────
  // turn_end fires at the end of every turn (before agent_end) and carries that
  // turn's resulting assistant message. A leaked-text turn always ENDS the run
  // (no real ToolCall → nothing keeps it going), so it is the last turn of the
  // prompt and the final turn_end before agent_end holds exactly the message the
  // old raw agent_end handler inspected. This handler does NOT send any message
  // and does NOT emit continuation events — it is purely observational, which
  // the Wave 2 guardrail permits.
  pi.on("turn_end", (event: unknown, ctx: ExtensionContext) => {
    const ev = event as TurnEndLike | undefined;
    const leaked = turnLeaked(ev?.message);
    leakPending = leaked;
    if (leaked && ctx.hasUI) {
      if (nudgedLastPrompt) {
        ctx.ui.notify(
          "Model emitted tool-call XML as text again after a nudge — stopping auto-retry.",
          "warning",
        );
      } else {
        ctx.ui.notify("Caught a tool call written as text — asking the model to redo it.", "info");
      }
    }
  });

  // ── Continuation intent (registered with the hook-coordinator arbiter) ────
  // Priority 250: informational band, deliberately ABOVE (lower precedence than)
  // the real loop/gate engines (done-gate 201, cast-gate 202, ultrawork-evidence
  // 203, retry 204, ralph 205). A cosmetic nudge must never preempt a real loop
  // engine — the arbiter injects exactly ONE continuation per edge, so when a
  // loop engine wants to continue it wins and the nudge abstains.
  const intent = {
    name: "toolcall-nudge",
    priority: 250,
    decide: (): { prompt: string; deliverAs?: "followUp" } | undefined => {
      // No leaked block on the last turn → nothing to fix; reset the streak.
      if (!leakPending) {
        nudgedLastPrompt = false;
        return undefined;
      }
      // Already nudged once and it leaked again → stop to avoid a loop.
      if (nudgedLastPrompt) {
        nudgedLastPrompt = false;
        leakPending = false;
        return undefined;
      }
      // Fresh leak → request the corrective nudge via the arbiter.
      nudgedLastPrompt = true;
      return { prompt: NUDGE };
    },
  };

  // Register with the coordinator. Emit immediately (works if the coordinator is
  // already loaded) and also on hook-coordinator:ready as a race fallback. The
  // coordinator dedups by name, so double-emission is harmless.
  pi.events.emit("hook-coordinator:register-continuation", intent);
  pi.events.on("hook-coordinator:ready", () => {
    pi.events.emit("hook-coordinator:register-continuation", intent);
  });
}

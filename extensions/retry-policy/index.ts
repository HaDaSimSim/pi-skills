// retry-policy — cross-model fallback continuation after native retry exhaustion.
//
// Active only when omo-flow is on (gated behind PI_RETRY_POLICY_ENABLED env var
// or coordinator presence). Keep native same-model auto-retry enabled for the
// fast path; this extension only kicks in AFTER native retries are exhausted.
//
// Flow:
//   1. pi's native auto-retry tries up to maxAttempts on the SAME model.
//   2. On auto_retry_end {success:false} (native exhausted):
//      a. Check isTransientError(lastErrorMessage) — imported from subagents/transient.ts
//      b. TRANSIENT → find next fallback model via nextFallbackModel(currentModel, chainKey)
//         - chainKey is resolved from the active persona name or a category context
//         - If found: store it, mark fallbackPending, re-drive via coordinator
//         - If not: surface (break — chain exhausted, error goes terminal)
//      c. NON-transient (auth/bad-request/invalid-model) → SURFACE (do not loop)
//   3. Fallback re-drive: registered as a CONTINUATION INTENT with the
//      hook-coordinator arbiter (priority 204). The arbiter calls decide() at
//      each agent_end; if fallbackPending, returns a re-drive prompt. Model
//      switch happens at turn_start (which has ctx.modelRegistry).
//   4. Loop: for transient errors, the cycle repeats with each new model until
//      success or chain exhausted. Deterministic errors break immediately.
//   5. User abort: pressing Esc stops the turn; the loop tries at most once per
//      edge (one-per-edge arbiter guarantee). No uninterruptible spin.
//   6. Persona-model reconcile (task 33):
//      - Before the first fallback in a chain, the active persona's preferred
//        model is saved (personaPreferredModel).
//      - After a successful fallback recovery (auto_retry_end {success:true}
//        following a fallback), the persona's model is restored via the same
//        resolveModel + pi.setModel path primary-agents uses.
//      - To prevent infinite restore-loops: after restoring once, if the persona
//        model triggers another transient error and fallback, the persona model
//        is NOT saved again (restoreWasAttempted flag). The session stays on
//        whatever model worked.
//      - The persona model is read via getActivePersona() from primary-agents.
//        If the persona has no explicit model, the fallback model becomes the
//        session's current model (no restore needed).
//
// Priority chain:
//   201: spec-graph-done-gate
//   202: planning-cast-gate
//   203: ultrawork-evidence-gate
//   204: retry-policy          ← NEW (before ralph, after other gates)
//   205: ralph-loop
//
// Precedence with task 29 category routing:
//   The fallback chain key aligns with the category name from categories.ts.
//   Categories.ts resolves the PRIMARY model for a category; this extension
//   provides the FALLBACK chain for when the primary model fails transiently.
//   Use the same key: resolveCategory("deep") → primary; fallback chain "deep"
//   → ordered alternatives. The primary is always tried first; fallback kicks
//   in only after native same-model retries are exhausted.
//
// Activation: set PI_RETRY_POLICY_ENABLED=1 (or PI_OMO_FLOW=1).
// Without this flag, the extension no-ops immediately.
//
// Install: ~/.pi/agent/extensions/retry-policy/index.ts (make install symlinks it)

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getActivePersona } from "../primary-agents/index.ts";
import { resolveCategory } from "../subagents/categories.ts";
import { isTransientError } from "../subagents/transient.ts";
import { nextFallbackModel, resetFallbackChain } from "./fallback-chain.ts";

// ── State ────────────────────────────────────────────────────────────────────

/** Last error message captured from auto_retry_start (for classification at end). */
let lastErrorMessage: string | undefined;

/** Whether a fallback re-drive is pending (set by auto_retry_end handler). */
let fallbackPending = false;

/** The next model name to try (provider/modelId format, e.g. "relay/claude-opus-4.8"). */
let nextModelName: string | undefined;

/** Total fallback attempts across models (for observability / max-attempts cap). */
let totalFallbackAttempts = 0;

/** The active persona's preferred model, saved before the first fallback in a chain. */
let personaPreferredModel: string | undefined;

/** Whether the persona-model restore is pending (set after a fallback succeeds). */
let pendingPersonaRestore = false;

/**
 * Whether we already attempted restoring the persona model and it triggered
 * another fallback. Prevents infinite restore→fail→fallback→restore loops.
 */
let restoreWasAttempted = false;

/**
 * Maximum total attempts across all models before giving up.
 * Prevents infinite model-cycling on persistent transient errors.
 */
const MAX_TOTAL_ATTEMPTS = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

function reset(): void {
  lastErrorMessage = undefined;
  fallbackPending = false;
  nextModelName = undefined;
  totalFallbackAttempts = 0;
  personaPreferredModel = undefined;
  pendingPersonaRestore = false;
  restoreWasAttempted = false;
}

/**
 * Resolve a "provider/modelId" string via ctx.modelRegistry.
 * Falls back to trying common providers if no slash is present.
 */
function resolveModelId(
  modelName: string,
  registry: ExtensionContext["modelRegistry"],
): ReturnType<ExtensionContext["modelRegistry"]["find"]> {
  const slashIdx = modelName.indexOf("/");
  if (slashIdx >= 0) {
    const provider = modelName.slice(0, slashIdx);
    const modelId = modelName.slice(slashIdx + 1);
    const found = registry.find(provider, modelId);
    if (found) return found;
    // Try bare modelId if scoped resolution fails.
  }
  const modelId = slashIdx === -1 ? modelName : modelName.slice(slashIdx + 1);
  for (const provider of ["relay", "anthropic", "openai", "google"]) {
    const found = registry.find(provider, modelId);
    if (found) return found;
  }
  return undefined;
}

/** Determine the chain key to use for fallback selection. */
function resolveChainKey(): string | undefined {
  // Priority: active persona name → "default"
  const persona = getActivePersona();
  if (persona?.name) return persona.name;
  return undefined; // uses "default" chain
}

// ── Extension entrypoint ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Activation gate ──────────────────────────────────────────────────────
  const enabled = process.env.PI_RETRY_POLICY_ENABLED === "1" || process.env.PI_OMO_FLOW === "1";

  if (!enabled) {
    return;
  }

  // ── Keep native same-model retry enabled ──────────────────────────────────
  try {
    const api = pi as unknown as Record<string, unknown>;
    if (typeof api.setAutoRetryEnabled === "function") {
      (api.setAutoRetryEnabled as (enabled: boolean) => void)(true);
    }
  } catch {
    // Auto-retry is enabled by default in pi.
  }

  // ── Event: capture error message on auto_retry_start ─────────────────────
  pi.events.on("auto_retry_start", (data: unknown) => {
    const event = data as { errorMessage?: string } | undefined;
    if (event && typeof event.errorMessage === "string") {
      lastErrorMessage = event.errorMessage;
    }
  });

  // ── Event: detect native retry exhaustion on auto_retry_end ──────────────
  pi.events.on("auto_retry_end", (data: unknown) => {
    const event = data as { success?: boolean; attempt?: number } | undefined;
    if (!event) return;

    if (event.success === true) {
      // Native retry succeeded.
      // If a persona restore is justified (we had a fallback and haven't tried restoring),
      // schedule it for the next turn_start.
      if (personaPreferredModel && !restoreWasAttempted) {
        pendingPersonaRestore = true;
      }
      resetFallbackChain();
      // Keep personaPreferredModel/pendingPersonaRestore — cleared at turn_start after restore.
      // Reset other transient state.
      lastErrorMessage = undefined;
      fallbackPending = false;
      nextModelName = undefined;
      totalFallbackAttempts = 0;
      return;
    }

    // Native retries exhausted (success === false).
    if (!isTransientError(lastErrorMessage)) {
      // NON-transient — SURFACE.
      reset();
      return;
    }

    // TRANSIENT error — try the fallback chain.
    // Save persona preferred model on the FIRST fallback in a chain.
    if (!personaPreferredModel) {
      const persona = getActivePersona();
      if (persona?.model) {
        personaPreferredModel = persona.model;
      }
    }

    const chainKey = resolveChainKey();
    // Use the current model name from the persona (or fallback to empty for chain-reset).
    const currentModel = personaPreferredModel ?? "";
    const next = nextFallbackModel(currentModel, chainKey);

    if (!next || totalFallbackAttempts >= MAX_TOTAL_ATTEMPTS) {
      // Chain exhausted or max attempts reached — surface.
      resetFallbackChain();
      reset();
      return;
    }

    // Fallback available — mark pending for the coordinator continuation.
    nextModelName = next;
    fallbackPending = true;
    totalFallbackAttempts += 1;
    // Clear any pending restore — we're in a new fallback cycle.
    pendingPersonaRestore = false;
  });

  // ── Turn start: apply model switch if fallback is pending, OR restore persona ──
  pi.on("turn_start", async (_event, ctx: ExtensionContext) => {
    // ── Case A: Fallback model switch ──────────────────────────────────────
    if (fallbackPending && nextModelName) {
      const modelName = nextModelName;
      fallbackPending = false;
      nextModelName = undefined;

      try {
        const model = resolveModelId(modelName, ctx.modelRegistry);
        if (model) {
          await pi.setModel(model);
          // Mark that the current model was set by fallback (for eventual restore).
          if (!restoreWasAttempted) {
            pendingPersonaRestore = true;
          }
        } else if (ctx.hasUI) {
          ctx.ui.notify(`retry-policy: could not resolve fallback model "${modelName}"`, "warning");
        }
      } catch (err) {
        if (ctx.hasUI) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`retry-policy: setModel failed: ${msg}`, "error");
        }
      }
      return;
    }

    // ── Case B: Persona model restore after successful fallback ────────────
    if (pendingPersonaRestore && personaPreferredModel) {
      pendingPersonaRestore = false;
      restoreWasAttempted = true;

      try {
        const model = resolveModelId(personaPreferredModel, ctx.modelRegistry);
        if (model) {
          await pi.setModel(model);
          if (ctx.hasUI) {
            ctx.ui.notify(`retry-policy: restored persona model ${personaPreferredModel}`, "info");
          }
        }
      } catch {
        // Restore failed — leave the current model as-is.
      }
      return;
    }

    // ── Case C: Normal turn (no fallback, no pending restore) ──────────────
    // If we previously had persona state but everything is quiet now,
    // fully reset for the next cycle.
    if (!fallbackPending && !pendingPersonaRestore) {
      personaPreferredModel = undefined;
      restoreWasAttempted = false;
    }
  });

  // ── Continuation intent: re-drive via coordinator arbiter ────────────────
  const intent = {
    name: "retry-policy",
    priority: 204,
    decide: () => {
      if (!fallbackPending) return undefined;

      const modelLabel = nextModelName ?? "next model";
      const prompt =
        `[retry-policy fallback #${totalFallbackAttempts}]\n` +
        `The previous turn failed with a transient error after native same-model retries were exhausted.\n` +
        `Falling back to model: ${modelLabel}.\n\n` +
        `Continue from where you left off — same task, same goal. ` +
        `If this model also fails transiently, the fallback chain will advance to the next model.`;

      return { prompt };
    },
  };

  // Race-safe registration.
  pi.events.emit("hook-coordinator:register-continuation", intent);
  pi.events.on("hook-coordinator:ready", () => {
    pi.events.emit("hook-coordinator:register-continuation", intent);
  });

  // ── Reset on session start ──────────────────────────────────────────────
  pi.on("session_start", () => {
    reset();
    resetFallbackChain();
  });
}

// primary-agents — persona roster, switching, persistence, and coordinator
// injection for pi.
//
// This extension discovers primary personas (builder, planner, unspecified),
// registers a dynamic persona section with the hook-coordinator (priority 150,
// persona band 100-199), and exposes switchAgent / /agent command / cycle key.
//
// On every switch, the active persona is persisted via appendEntry. On
// session_start, the last active-agent entry is restored and switchAgent
// re-applies model + tools + persona body. A fresh session defaults to builder.
//
// An external caller (pi-gui backend) can request a persona switch by writing
// an "active-agent-request" custom entry to the session. This extension observes
// that entry on turn_start and self-applies switchAgent. The switch takes effect
// on the SAME turn (turn_start fires before before_agent_start, so the
// coordinator's section getText() picks up the new persona body).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverPersonas, type PersonaConfig } from "./agents.ts";

// ── Active-persona state ─────────────────────────────────────────────────────

let roster: PersonaConfig[] = [];
let activePersona: PersonaConfig | null = null;
let __streaming = false;

/** Reset the active persona (for tests). */
export function resetActivePersona(): void {
  activePersona = null;
}

// Tracks the last-applied active-agent-request timestamp to avoid re-applying
// the same request on every hook invocation (entries persist forever).
let lastAppliedRequestTs = 0;

/** Reset the last-applied request tracker (for tests). */
export function resetLastAppliedRequestTs(): void {
  lastAppliedRequestTs = 0;
}

// ── Roster loading ───────────────────────────────────────────────────────────

export function loadRoster(cwd: string): PersonaConfig[] {
  const result = discoverPersonas(cwd, "both");
  roster = result.personas;
  const def = result.personas.find((p) => p.default === true);
  if (def && !activePersona) {
    activePersona = def;
  }
  return roster;
}

export function getRoster(): PersonaConfig[] {
  return roster;
}

export function getActivePersona(): PersonaConfig | null {
  return activePersona;
}

function getActivePersonaBody(): string | undefined {
  return activePersona?.systemPrompt;
}

// ── Streaming guard ──────────────────────────────────────────────────────────

function isStreaming(): boolean {
  return __streaming;
}

// ── Model / tool application ─────────────────────────────────────────────────

/**
 * Resolve a "provider/modelId" string to a Model object via the model registry.
 * Falls back to searching all providers if the persona model lacks a provider prefix.
 */
function resolveModel(
  modelRef: string,
  modelRegistry: ExtensionContext["modelRegistry"],
): ReturnType<ExtensionContext["modelRegistry"]["find"]> {
  const slashIdx = modelRef.indexOf("/");
  if (slashIdx !== -1) {
    const provider = modelRef.slice(0, slashIdx);
    const modelId = modelRef.slice(slashIdx + 1);
    const found = modelRegistry.find(provider, modelId);
    if (found) return found;
  }
  // Try bare modelId against common providers.
  const modelId = slashIdx === -1 ? modelRef : modelRef.slice(slashIdx + 1);
  for (const provider of ["anthropic", "openai", "google", "github-copilot", "opencode", "relay"]) {
    const found = modelRegistry.find(provider, modelId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Apply a persona's model + tools + thinking level. Call this from a command
 * handler (has ctx.modelRegistry) or defer to after_agent_end when streaming.
 */
async function applyPersonaConfig(
  pi: ExtensionAPI,
  persona: PersonaConfig,
  ctx?: ExtensionContext,
): Promise<void> {
  // Apply active tools.
  if (persona.tools && persona.tools.length > 0) {
    pi.setActiveTools(persona.tools);
  }

  // Apply model (if specified and resolvable).
  if (persona.model && ctx?.modelRegistry) {
    const resolved = resolveModel(persona.model, ctx.modelRegistry);
    if (resolved) {
      await pi.setModel(resolved);
    }
  }
}

// ── Persona switching ────────────────────────────────────────────────────────

/**
 * Switch the active persona. Validates name against the roster, updates
 * activePersona (which changes getText() output), persists via appendEntry,
 * and applies model/tools if we have a context with a model registry.
 *
 * No-op when switching to the already-active persona (no appendEntry).
 * Streaming-safe: if mid-stream, model/tools changes are deferred — the
 * persona body change (via getText) takes effect on the NEXT before_agent_start
 * naturally, and model/tools are applied on the next idle tick.
 */
export async function switchAgent(
  pi: ExtensionAPI,
  name: string,
  ctx?: ExtensionContext,
): Promise<PersonaConfig> {
  // No-op: already active.
  if (activePersona?.name === name) return activePersona;

  const persona = roster.find((p) => p.name === name);
  if (!persona) {
    const names = roster.map((p) => p.name).join(", ");
    throw new Error(`Unknown persona: "${name}". Valid: ${names}`);
  }

  activePersona = persona;

  // Persist the active persona for restore on session resume.
  pi.appendEntry("active-agent", { name: persona.name });

  if (ctx) {
    if (ctx.isIdle()) {
      await applyPersonaConfig(pi, persona, ctx);
    } else {
      // Defer model/tools to next idle tick.
      setTimeout(async () => {
        await applyPersonaConfig(pi, persona, ctx);
      }, 0);
    }
  }

  return persona;
}

// ── Cycle key ────────────────────────────────────────────────────────────────

// Not Tab (reserved for autocomplete). Mirrors subagents' ctrl+\ choice
// rationale: a key not in pi's built-in bindings, unlikely to conflict.
const CYCLE_SHORTCUT = "ctrl+shift+o";

async function cyclePersona(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (roster.length === 0) return;
  const currentIdx = activePersona ? roster.findIndex((p) => p.name === activePersona!.name) : -1;
  const nextIdx = (currentIdx + 1) % roster.length;
  const nextPersona = roster[nextIdx];
  await switchAgent(pi, nextPersona.name, ctx);
  ctx.ui.notify(`Persona: ${nextPersona.name}`, "info");
}

// ── Session restore ──────────────────────────────────────────────────────────

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

// ── Active-agent-request finder ──────────────────────────────────────────────

/**
 * Scan entries for the newest unapplied "active-agent-request" entry.
 * Returns the requested name and timestamp if one exists with ts > lastAppliedTs.
 * Exported for testing.
 */
export function findPendingAgentRequest(
  entries: SessionEntry[],
  lastAppliedTs: number,
): { name: string; ts: number } | null {
  let newest: { name: string; ts: number } | null = null;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "active-agent-request") {
      const data = entry.data as { name?: string; ts?: number } | undefined;
      if (data && typeof data.name === "string") {
        const ts = data.ts ?? 0;
        if (ts > lastAppliedTs && ts > (newest?.ts ?? 0)) {
          newest = { name: data.name, ts };
        }
      }
    }
  }
  return newest;
}

// ── Session restore (active-agent entries) ───────────────────────────────────

/**
 * Find the last active-agent entry from a list of session entries.
 * Returns the persona name or null if none found. Exported for testing.
 */
export function findLastActiveAgent(entries: SessionEntry[]): string | null {
  let lastName: string | null = null;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "active-agent") {
      const data = entry.data as { name?: string } | undefined;
      if (data && typeof data.name === "string") {
        lastName = data.name;
      }
    }
  }
  return lastName;
}

// ── Extension entrypoint ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Load the persona roster on activation.
  loadRoster(process.cwd());

  // ── Streaming tracking ───────────────────────────────────────────────────

  pi.on("agent_start", () => {
    __streaming = true;
  });

  pi.on("agent_end", () => {
    __streaming = false;
  });

  pi.on("agent_settled", () => {
    __streaming = false;
  });

  // ── Active-agent-request observation ──────────────────────────────────────
  // Observes "active-agent-request" custom entries written by pi-gui backend.
  // On finding a new request, self-applies switchAgent. Uses turn_start
  // (fires BEFORE before_agent_start) so the persona body change is picked up
  // by the coordinator's section getText() on the SAME turn — no staleness.
  // Uses turn_start rather than before_agent_start to preserve the coordinator's
  // sole ownership of before_agent_start (guardrail: only hook-coordinator may
  // register before_agent_start/agent_end after Wave 1).

  pi.on("turn_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as SessionEntry[];
    const request = findPendingAgentRequest(entries, lastAppliedRequestTs);
    if (request) {
      lastAppliedRequestTs = request.ts;
      try {
        await switchAgent(pi, request.name, ctx);
      } catch {
        // Unknown persona or switch failure — doesn't block the turn.
      }
    }
  });

  // ── Session restore ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Scan custom entries for the last active-agent record (last-wins).
    const entries = ctx.sessionManager.getEntries() as SessionEntry[];
    const lastName = findLastActiveAgent(entries);

    if (lastName) {
      // Re-apply the recorded persona — model + tools + body all restored.
      await switchAgent(pi, lastName, ctx);
    } else {
      // Fresh session — ensure the default (builder) is active.
      const def = roster.find((p) => p.default === true);
      if (def) {
        await switchAgent(pi, def.name, ctx);
      }
    }
  });

  // ── Coordinator section registration (priority 150, persona band) ────────

  const section = {
    name: "primary-agents-persona",
    priority: 150,
    getText: getActivePersonaBody,
  };

  // Immediate attempt (works if coordinator already loaded).
  pi.events.emit("hook-coordinator:register-section", section);

  // Fallback for late coordinator: re-emit when coordinator signals ready.
  pi.events.on("hook-coordinator:ready", () => {
    pi.events.emit("hook-coordinator:register-section", section);
  });

  // ── /agent command ───────────────────────────────────────────────────────

  pi.registerCommand("agent", {
    description: "Switch persona. /agent with no args shows roster. /agent <name> switches.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // No args → show roster + current.
      if (!trimmed) {
        const currentName = activePersona?.name ?? "none";
        const lines = [`Active persona: ${currentName}`, "Roster:"];
        for (const p of roster) {
          const marker = p.default ? " (default)" : "";
          const current = p.name === currentName ? " *" : "";
          lines.push(`  ${p.name}${marker}${current} — ${p.description}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      // <name> → switch.
      try {
        const persona = await switchAgent(pi, trimmed, ctx);
        ctx.ui.notify(`Switched to persona: ${persona.name}`, "info");
      } catch (err) {
        ctx.ui.notify((err as Error).message, "error");
      }
    },
  });

  // ── Cycle shortcut ───────────────────────────────────────────────────────

  pi.registerShortcut(CYCLE_SHORTCUT, {
    description: "Cycle to next persona",
    handler: async (ctx) => {
      await cyclePersona(pi, ctx);
    },
  });
}

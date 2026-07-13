// /ralph-loop (was /goal) for pi — an autonomous goal loop ("Ralph loop").
//
// Concept:
//   Normally an agent stops once a single user prompt (agent_start ~ agent_end)
//   completes. /ralph-loop (aliased as /goal for back-compat) pins "one durable
//   goal" to the session and, until that goal is judged complete, re-injects a
//   continuation prompt at every agent_end so the agent keeps taking turns on
//   its own (the so-called Ralph loop).
//
// Loop engine (Wave 2 reframe):
//   - /goal <objective> sets the goal and injects the first prompt via sendUserMessage.
//   - Continuation is registered as a CONTINUATION INTENT with the hook-coordinator
//     arbiter (hook-coordinator:register-continuation). The arbiter calls decide()
//     at each agent_end and injects exactly ONE continuation per edge.
//   - The RAW pi.on("agent_end") handler has been REMOVED — the coordinator owns
//     agent_end now (core Wave 2 guardrail).
//   - The subagent hold is provided GLOBALLY by the arbiter (task 4) — ralph's
//     decide() does NOT re-check subagents. The arbiter holds while
//     subagents:running > 0 and injects a single continuation when done.
//   - The loop stops when the model calls the goal_done / goal_blocked tool, the
//     user pauses/clears, or the goal status changes from "pursuing".
//
// Persistence:
//   Goal state is recorded to the session via pi.appendEntry and restored at
//   session_start, so the goal survives a /reload or restart.
//
// Install: ~/.pi/agent/extensions/ralph-loop/index.ts (symlinked by make install)

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GoalStatus = "pursuing" | "paused" | "achieved" | "blocked" | "budget-limited";

interface GoalState {
  objective: string;
  status: GoalStatus;
  iteration: number; // how many times the continuation has been re-injected (display counter)
  tokenBudget?: number; // cap on cumulative tokens (input+output). Stops when exceeded (optional)
  ignoreBlocked?: boolean; // if true, ignore goal_blocked and keep running (--no-block)
  note?: string; // last achievement/block reason
  createdAt: number;
}

// Ralph loop: no cap on iteration count. The only stops are the model's goal_done/
// goal_blocked, the user's pause/clear, and (if configured) the token budget.
const STATE_ENTRY_TYPE = "goal-state";

// ── Loop instructions (prompt fragments) ──────────────────────────────

const loopInstructions =
  "When the goal is fully achieved and you have verified it, call the goal_done tool with a short evidence summary. " +
  "If you are blocked and cannot make progress without the user, call the goal_blocked tool with the reason. " +
  "Otherwise, take the next concrete step now and keep going without waiting for further input.";

const loopInstructionsNoBlock =
  "When the goal is fully achieved and you have verified it, call the goal_done tool with a short evidence summary. " +
  "You may NOT stop for being blocked: the goal_blocked tool is disabled for this run and will be ignored. " +
  "If you hit an obstacle, make a reasonable assumption, try an alternative approach, and keep going without waiting for the user. " +
  "Take the next concrete step now.";

const instructionsFor = (g: GoalState): string =>
  g.ignoreBlocked ? loopInstructionsNoBlock : loopInstructions;

const buildPrompt = (g: GoalState, kind: "start" | "continue"): string => {
  if (kind === "start") {
    return (
      `You are now working under a durable goal. Stay on it across turns until it is met.\n\n` +
      `GOAL: ${g.objective}\n\n` +
      instructionsFor(g)
    );
  }
  return (
    `[ralph loop · iteration ${g.iteration}]\n` +
    `Active goal: ${g.objective}\n\n` +
    `Keep working toward this goal. Do not stop until the verifiable stopping condition is met. ` +
    instructionsFor(g)
  );
};

export default function (pi: ExtensionAPI) {
  // Don't register the goal in child subagent processes (`pi -p`, non-interactive).
  // /goal is an autonomous loop (Ralph loop) a human starts, so it's unnecessary for a one-shot -p child,
  // and continuation re-injection / goal tools getting entangled in a child risks it never stopping.
  // The subagents extension stamps PI_SUBAGENT=1 into the child env.
  if (process.env.PI_SUBAGENT) return;

  let goal: GoalState | null = null;

  // ── Status display / persistence ───────────────────────────────

  const statusEmoji: Record<GoalStatus, string> = {
    pursuing: "🎯",
    paused: "⏸",
    achieved: "✅",
    blocked: "🚧",
    "budget-limited": "⛔",
  };

  // Record to the session whenever state changes (session-global state independent of branches, so appendEntry).
  const persist = () => {
    if (goal) pi.appendEntry(STATE_ENTRY_TYPE, goal as unknown as Record<string, unknown>);
  };

  // Dynamic goal-tool exposure: only when the goal is in a trackable state (pursuing/paused)
  // are goal_done/goal_blocked kept in the active tool list. When there is no goal or it has ended,
  // this extension leaves no trace — neither tools nor prompts.
  // (setActiveTools takes the full active list, so we read the current list and only
  //  add/remove my two tools, leaving other extensions' tools untouched.)
  const GOAL_TOOLS = ["goal_done", "goal_blocked"];
  const syncGoalTools = (present: boolean) => {
    try {
      const active = new Set(pi.getActiveTools());
      for (const t of GOAL_TOOLS) {
        if (present) active.add(t);
        else active.delete(t);
      }
      pi.setActiveTools([...active]);
    } catch {
      // Can't be called before runtime init (during the load phase) — ignore.
    }
  };
  const goalIsLive = () => !!goal && (goal.status === "pursuing" || goal.status === "paused");

  const setStatus = (ctx: ExtensionContext) => {
    // Tool sync is independent of whether there's a UI (the model can see them even in
    // print mode, so always sync first). Every state transition goes through setStatus, so
    // tool exposure is managed centrally here in one place.
    syncGoalTools(goalIsLive());
    if (!ctx.hasUI) return;
    if (!goal) {
      ctx.ui.setStatus("goal", undefined);
      return;
    }
    const e = statusEmoji[goal.status];
    const counter = goal.status === "pursuing" ? ` #${goal.iteration}` : "";
    ctx.ui.setStatus("goal", ctx.ui.theme.fg("dim", `${e} goal ${goal.status}${counter}`));
  };

  // ── Cumulative tokens (for budget checks) ──────────────────────

  const cumulativeTokens = (ctx: ExtensionContext): number => {
    let total = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const u = (entry.message as AssistantMessage).usage;
        if (u) total += (u.input ?? 0) + (u.output ?? 0);
      }
    }
    return total;
  };

  // ── Continuation intent (registered with hook-coordinator arbiter) ──────

  const intent = {
    name: "ralph-loop",
    priority: 205, // loop-engine band (200-299); 205 sits below ultrawork (210) and above catch-all loops
    decide: (): { prompt: string; deliverAs?: "followUp" } | undefined => {
      // Only continue if a goal is actively being pursued.
      if (!goal || goal.status !== "pursuing") return undefined;

      // Increment iteration and persist (the arbiter handles injection + subagent hold).
      goal.iteration += 1;
      persist();

      const prompt = buildPrompt(goal, "continue");
      return { prompt };
    },
  };

  // Register with the coordinator. Emit immediately (works if coordinator already loaded)
  // and also on hook-coordinator:ready as a race-condition fallback. Dedup by name.
  pi.events.emit("hook-coordinator:register-continuation", intent);
  pi.events.on("hook-coordinator:ready", () => {
    pi.events.emit("hook-coordinator:register-continuation", intent);
  });

  // ── Goal-termination tools (called by the model) ────────────────────

  pi.registerTool({
    name: "goal_done",
    label: "Goal Done",
    description:
      "Declare the active goal achieved. Call this only when the goal's verifiable stopping condition is met and verified.",
    promptSnippet: "Mark the active /goal as achieved with an evidence summary",
    promptGuidelines: [
      "Call goal_done only when the active goal is fully achieved and you have verified the stopping condition.",
      "Provide concrete evidence in goal_done (tests passing, build succeeding, etc.), not just a claim.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "Short evidence summary of why the goal is complete." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (goal) {
        goal.status = "achieved";
        goal.note = params.summary;
        persist();
        setStatus(ctx);
        pi.events.emit("ralph:status-change", {
          status: "achieved",
          objective: goal.objective,
          note: params.summary,
        });
        if (ctx.hasUI) ctx.ui.notify("✅ Goal achieved — ending the loop.", "info");
      }
      return {
        content: [{ type: "text", text: `Goal marked achieved: ${params.summary}` }],
        details: { summary: params.summary },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "goal_blocked",
    label: "Goal Blocked",
    description:
      "Declare that the active goal is blocked and cannot proceed without user input. Stops the goal loop.",
    promptSnippet: "Mark the active /goal as blocked with a reason",
    promptGuidelines: [
      "Call goal_blocked when you cannot make further progress on the active goal without a decision or information from the user.",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Why the goal is blocked and what input is needed." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // --no-block mode: ignore the block and keep running. Status stays pursuing.
      if (goal?.ignoreBlocked) {
        if (ctx.hasUI) ctx.ui.notify("🚧 goal_blocked ignored (--no-block) — continuing.", "info");
        return {
          content: [
            {
              type: "text",
              text:
                `goal_blocked is disabled for this run (--no-block). Reason recorded: ${params.reason}. ` +
                `Do not stop. Make a reasonable assumption or try an alternative approach and continue toward the goal now.`,
            },
          ],
          details: { reason: params.reason, ignored: true },
        };
      }
      if (goal) {
        goal.status = "blocked";
        goal.note = params.reason;
        persist();
        setStatus(ctx);
        pi.events.emit("ralph:status-change", {
          status: "blocked",
          objective: goal.objective,
          note: params.reason,
        });
        if (ctx.hasUI) ctx.ui.notify("🚧 Goal blocked — stopping the loop.", "warning");
      }
      return {
        content: [{ type: "text", text: `Goal blocked: ${params.reason}` }],
        details: { reason: params.reason },
        terminate: true,
      };
    },
  });

  // ── /goal command (lifecycle control) ─────────────────────────

  // Parse leading flags: --budget N | --budget=N, --no-block (ignore goal_blocked)
  const parseObjective = (
    raw: string,
  ): { objective: string; tokenBudget?: number; ignoreBlocked: boolean } => {
    let tokenBudget: number | undefined;
    let ignoreBlocked = false;
    const tokens = raw.trim().split(/\s+/);
    const rest: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const eq = t.indexOf("=");
      const take = (key: string): string | undefined => {
        if (t === key) return tokens[++i];
        if (t.startsWith(`${key}=`)) return t.slice(eq + 1);
        return undefined;
      };
      if (t === "--no-block" || t === "--ignore-blocked") {
        ignoreBlocked = true;
        continue;
      }
      const bd = take("--budget");
      if (bd !== undefined) {
        const n = parseInt(bd, 10);
        if (Number.isFinite(n) && n > 0) tokenBudget = n;
        continue;
      }
      rest.push(t);
    }
    return { objective: rest.join(" ").trim(), tokenBudget, ignoreBlocked };
  };

  const showStatus = (ctx: ExtensionContext) => {
    if (!goal) {
      ctx.ui.notify("No active goal. Set one with /goal <objective>.", "info");
      return;
    }
    const lines = [
      `${statusEmoji[goal.status]} ${goal.status}  (iteration ${goal.iteration}` +
        (goal.tokenBudget ? `, budget ${goal.tokenBudget} tok` : "") +
        (goal.ignoreBlocked ? `, no-block` : "") +
        `)`,
      `Goal: ${goal.objective}`,
    ];
    if (goal.note) lines.push(`Note: ${goal.note}`);
    ctx.ui.notify(lines.join("\n"), "info");
  };

  pi.registerCommand("goal", {
    description:
      "Autonomous goal loop (Ralph loop). Set with /goal <objective>, check status with no args, control with /goal pause|resume|clear. (supports --budget N, --no-block)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [sub, ...subRest] = trimmed.split(/\s+/);
      const _subArg = subRest.join(" ").trim();

      // Lifecycle subcommands
      if (trimmed === "" || sub === "status") {
        showStatus(ctx);
        return;
      }
      if (sub === "pause") {
        if (goal?.status !== "pursuing") {
          ctx.ui.notify("No goal is being tracked.", "warning");
          return;
        }
        goal.status = "paused";
        persist();
        setStatus(ctx);
        ctx.ui.notify("⏸ Goal paused. Use /goal resume to continue.", "info");
        return;
      }
      if (sub === "resume") {
        if (!goal) {
          ctx.ui.notify("No goal to resume.", "warning");
          return;
        }
        if (goal.status === "pursuing") {
          ctx.ui.notify("Already tracking.", "info");
          return;
        }
        goal.status = "pursuing";
        goal.note = undefined;
        persist();
        setStatus(ctx);
        ctx.ui.notify("▶ Resuming goal.", "info");
        // Kickstart: the coordinator arbiter will handle subsequent continuations.
        pi.sendUserMessage(buildPrompt(goal, "continue"));
        return;
      }
      if (sub === "clear") {
        goal = null;
        pi.appendEntry(STATE_ENTRY_TYPE, { cleared: true });
        setStatus(ctx);
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }

      // Otherwise set a new goal (sub is part of the objective too)
      const { objective, tokenBudget, ignoreBlocked } = parseObjective(trimmed);
      if (!objective) {
        ctx.ui.notify("Usage: /goal <objective>  [--budget N] [--no-block]", "warning");
        return;
      }
      goal = {
        objective,
        status: "pursuing",
        iteration: 0,
        tokenBudget,
        ignoreBlocked: ignoreBlocked || undefined,
        createdAt: Date.now(),
      };
      persist();
      setStatus(ctx);
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. The goal will start once the current turn ends.", "info");
      } else {
        ctx.ui.notify(`🎯 Goal set: ${objective}${ignoreBlocked ? "  (no-block)" : ""}`, "info");
      }
      // Kickstart the first turn. Subsequent continuations go through the coordinator arbiter.
      pi.sendUserMessage(buildPrompt(goal, "start"));
    },
    getArgumentCompletions: (prefix: string) => {
      const subs = ["pause", "resume", "clear", "status"];
      const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
  });

  // ── Session restore ────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    goal = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as Record<string, unknown> | undefined;
        if (data && (data as { cleared?: boolean }).cleared) {
          goal = null;
        } else if (data && typeof data.objective === "string") {
          goal = data as unknown as GoalState;
        }
      }
    }
    // If the restored goal was actively being tracked, lower it to paused so the user resumes
    // the stopped loop manually (prevents an automatic runaway right after restart).
    if (goal && goal.status === "pursuing") {
      goal.status = "paused";
      goal.note = "auto-paused on session restore — /goal resume to continue";
    }
    setStatus(ctx);
    if (goal && ctx.hasUI) {
      ctx.ui.notify(
        `Restored goal (${goal.status}): ${goal.objective}\nUse /goal resume to continue.`,
        "info",
      );
    }
  });
}

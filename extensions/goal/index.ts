// pi 용 /goal — Codex CLI 의 /goal (자율 목표 루프) 을 pi 에 이식한 것.
//
// 동작 개념:
//   보통 에이전트는 사용자 프롬프트 한 건(agent_start ~ agent_end)이 끝나면
//   멈춘다. /goal 은 "하나의 지속 목표" 를 세션에 고정해두고, 그 목표가
//   끝났다고 판단될 때까지 매 agent_end 마다 continuation 프롬프트를 다시
//   투입해 스스로 턴을 이어가게 만든다 (이른바 Ralph loop).
//
// 루프 엔진:
//   - /goal <objective> 로 목표를 세우면 첫 프롬프트를 sendUserMessage 로 투입.
//   - 그 턴이 끝나면(agent_end) 목표가 아직 "pursuing" 이면 continuation 을 재투입.
//   - 모델이 goal_done / goal_blocked 툴을 부르거나, 사용자가 pause/clear 하거나,
//     토큰 예산·최대 반복 횟수에 도달하면 루프가 멈춘다.
//
// 영속화:
//   목표 상태는 pi.appendEntry 로 세션에 기록되고 session_start 에서 복원되므로
//   /reload 나 재시작 후에도 목표가 살아있다.
//
// 설치: ~/.pi/agent/extensions/goal/index.ts (make install 이 symlink)

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type GoalStatus = "pursuing" | "paused" | "achieved" | "blocked" | "budget-limited";

interface GoalState {
  objective: string;
  status: GoalStatus;
  iteration: number; // continuation 을 몇 번 재투입했는지 (표시용 카운터)
  tokenBudget?: number; // 누적 토큰(input+output) 상한. 넘으면 멈춤 (선택)
  ignoreBlocked?: boolean; // true 면 goal_blocked 를 무시하고 계속 돈다 (--no-block)
  note?: string; // 마지막 달성/차단 사유
  createdAt: number;
}

// Ralph loop: 반복 횟수 제한은 두지 않는다. 멈춤은 모델의 goal_done/
// goal_blocked, 사용자의 pause/clear, 그리고 (설정 시) 토큰 예산뿐이다.
const STATE_ENTRY_TYPE = "goal-state";

export default function (pi: ExtensionAPI) {
  // 자식 subagent 프로세스(`pi -p`, 비대화형)에서는 goal 을 등록하지 않는다.
  // /goal 은 사람이 걸는 자율 루프(Ralph loop)라 단발 -p 자식엔 불필요하고,
  // continuation 재투입·goal 툴이 자식에 엮히면 멈추지 않을 위험도 있다.
  // subagents 익스텐션이 자식 env 에 PI_SUBAGENT=1 을 박는다.
  if (process.env.PI_SUBAGENT) return;

  let goal: GoalState | null = null;

  // ── 상태 표시 / 영속화 ────────────────────────────────────────────────

  const statusEmoji: Record<GoalStatus, string> = {
    pursuing: "🎯",
    paused: "⏸",
    achieved: "✅",
    blocked: "🚧",
    "budget-limited": "⛔",
  };

  // 상태가 바뀔 때마다 세션에 기록(브랜치와 무관한 세션 전역 상태이므로 appendEntry).
  const persist = () => {
    if (goal) pi.appendEntry(STATE_ENTRY_TYPE, goal as unknown as Record<string, unknown>);
  };

  // goal 도구 동적 노출: goal 이 추적 가능한 상태(pursuing/paused)일 때만
  // goal_done/goal_blocked 를 활성 도구 목록에 둔다. goal 이 없거나 종료되면
  // 이 extension 은 도구도 프롬프트도 아무 흔적을 남기지 않는다.
  // (setActiveTools 는 전체 활성 목록을 받으므로, 현재 목록을 읽어
  //  내 두 도구만 추가/제거해 다른 extension 도구는 건드리지 않는다.)
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
      // 런타임 초기화 전(load 단계)에는 호출 불가 — 무시.
    }
  };
  const goalIsLive = () => !!goal && (goal.status === "pursuing" || goal.status === "paused");

  const setStatus = (ctx: ExtensionContext) => {
    // 도구 동기화는 UI 유무와 무관 (print 모드에서도 모델이 볼 수 있으므로
    // 항상 먼저 맞춰둔다). 모든 상태 전이가 setStatus 를 거치므로
    // 여기 한 곳에서 도구 노출을 일괄 관리한다.
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

  // ── 누적 토큰(예산 체크용) ────────────────────────────────────────────

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

  // ── 프롬프트 빌더 ─────────────────────────────────────────────────────

  const loopInstructions =
    "When the goal is fully achieved and you have verified it, call the goal_done tool with a short evidence summary. " +
    "If you are blocked and cannot make progress without the user, call the goal_blocked tool with the reason. " +
    "Otherwise, take the next concrete step now and keep going without waiting for further input.";

  // --no-block 모드: goal_blocked 가 무력화됨을 모델에게 명확히 알린다.
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
      `[goal loop · iteration ${g.iteration}]\n` +
      `Active goal: ${g.objective}\n\n` +
      `Keep working toward this goal. Do not stop until the verifiable stopping condition is met. ` +
      instructionsFor(g)
    );
  };

  // ── 루프 재투입 ───────────────────────────────────────────────────────

  // agent_end 직후 idle 로 전환되는 타이밍을 안전하게 잡기 위해 한 틱 미룬다.
  const kick = (ctx: ExtensionContext, kind: "start" | "continue") => {
    setTimeout(() => {
      if (goal?.status !== "pursuing") return;
      const prompt = buildPrompt(goal, kind);
      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        // 아직 스트리밍 중이면 현재 턴이 끝난 뒤 이어붙인다.
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      }
    }, 0);
  };

  // 매 프롬프트가 끝날 때마다: 목표 추적 중이면 다음 step 을 재투입.
  pi.on("agent_end", async (event, ctx) => {
    if (goal?.status !== "pursuing") return;

    // 사용자가 Esc 로 abort 했으면 루프를 멈춘다. abort 는 "그만" 신호이므로
    // 자동 재투입하지 않고 paused 로 전환해 사용자가 직접 resume 하게 둔다.
    // 마지막 assistant 메시지의 stopReason 으로 판정한다.
    const msgs = event.messages ?? [];
    let lastAssistant: AssistantMessage | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as { role?: string };
      if (m.role === "assistant") {
        lastAssistant = m as AssistantMessage;
        break;
      }
    }
    if (lastAssistant?.stopReason === "aborted") {
      goal.status = "paused";
      goal.note = "aborted by user (Esc) — /goal resume to continue";
      persist();
      setStatus(ctx);
      if (ctx.hasUI) ctx.ui.notify("⏸ Aborted (Esc). Use /goal resume to continue.", "info");
      return;
    }

    // 토큰 예산 초과 → 멈춤
    if (goal.tokenBudget && cumulativeTokens(ctx) >= goal.tokenBudget) {
      goal.status = "budget-limited";
      goal.note = `token budget ${goal.tokenBudget} reached`;
      persist();
      setStatus(ctx);
      pi.events.emit("goal:status-change", {
        status: "budget-limited",
        objective: goal.objective,
        note: goal.note,
      });
      if (ctx.hasUI)
        ctx.ui.notify(`Goal stopped: token budget (${goal.tokenBudget}) reached.`, "warning");
      return;
    }

    // 횟수 제한 없음 (Ralph loop). 끝까지 돈다.
    goal.iteration += 1;
    persist();
    setStatus(ctx);
    kick(ctx, "continue");
  });

  // ── 목표 종료 툴 (모델이 호출) ────────────────────────────────────────

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
        pi.events.emit("goal:status-change", {
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
      // --no-block 모드: 차단을 무시하고 계속 돈다. 상태는 pursuing 유지.
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
        pi.events.emit("goal:status-change", {
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

  // ── /goal 명령 (수명주기 제어) ────────────────────────────────────────

  // 선행 플래그 파싱: --budget N | --budget=N, --no-block (goal_blocked 무시)
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

      // 수명주기 서브커맨드
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
        kick(ctx, "continue");
        return;
      }
      if (sub === "clear") {
        goal = null;
        pi.appendEntry(STATE_ENTRY_TYPE, { cleared: true });
        setStatus(ctx);
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }

      // 그 외는 새 목표 설정 (sub 도 objective 의 일부)
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
      kick(ctx, "start");
    },
    getArgumentCompletions: (prefix: string) => {
      const subs = ["pause", "resume", "clear", "status"];
      const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
  });

  // ── 세션 복원 ─────────────────────────────────────────────────────────

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
    // 복원된 목표가 한창 추적 중이었다면, 멈춰있던 루프를 사용자가 직접
    // 재개하도록 paused 로 낮춰 둔다(재시작 직후 자동 폭주 방지).
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

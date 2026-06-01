// superpi — spec-graph 기반 페이즈 게이트 자율 파이프라인.
//
// 개념:
//   헤비한 멀티페이즈 과제 전용. 작업을 spec-graph 의 PHS(페이즈) 단위로 쪼개
//   각 PHS 마다 내부 페이즈(PLAN → PLAN_REVIEW → WORK → VERIFY)를 돌고, 그
//   PHS 를 CLI 게이트로 resolved 시킨 뒤 다음 PHS 로 전진한다. 모든 PHS 가
//   resolved 되면 DONE.
//
//   두 개의 강제 축:
//     - spec-graph CLI: 미해결 question/risk 없이는 PHS resolved 불가(gates,
//       exit 2). 영속 그래프, impact, covers/delivers 추적.
//     - superpi: 페이즈 순서(setActiveTools 게이팅), 실제 빌드/테스트 실행,
//       reviewer 사인오프. phase_verify_pass 가 직접 `spec-graph ... resolved`
//       를 shell-out 해 exit code 로 게이트한다(모델 주장 아님).
//
//   결합 강도(사용자 확정): 무조건 강제. `.spec-graph/` 없으면 SETUP 에서
//   init + spec-planner 로 그래프를 만든다. spec-graph 없이는 안 돈다.
//
//   페이즈 안에서는 subagents 익스텐션(spawn_subagents)으로 explorer/librarian/
//   plan/oracle/reviewer/general 프리셋을 병렬 위임한다.
//
// 루프 엔진(goal 익스텐션 아키텍처 차용):
//   - /superpi <objective> 로 시작 → SETUP 페이즈 진입.
//   - 매 agent_end 마다 현재 페이즈 continuation 을 재투입(Ralph loop).
//   - 전이 툴(phase_*/setup_done)이 페이즈를 전진/후퇴시키고 setActiveTools 를
//     다시 건다. verify_pass 는 CLI resolved 게이트 + phase next 로 다음 PHS.
//   - pipeline_blocked / pause / clear / budget / abort 로 정지.
//
// subagent 공존(함정 방어):
//   subagents 는 자식이 끝나면 스스로 sendUserMessage 로 턴을 구동한다. 같은
//   턴에 spawn_subagents 가 호출됐으면(=자식 in-flight) superpi 는 continuation 을
//   재투입하지 않는다 — subagents 의 finished 메시지가 다음 턴을 끌고 가게 둔다.
//
// 자식 비활성: PI_SUBAGENT 환경에서는 미등록 (중첩 파이프라인 방지).
//
// 영속화: 상태는 pi.appendEntry 로 세션에 기록, session_start 에서 복원.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";

type Phase = "SETUP" | "PLAN" | "PLAN_REVIEW" | "WORK" | "VERIFY" | "DONE" | "BLOCKED";
type LoopStatus = "pursuing" | "paused" | "done" | "blocked" | "budget-limited";

interface PipelineState {
  objective: string;
  phase: Phase;
  status: LoopStatus;
  iteration: number; // continuation 재투입 카운터(표시용)
  tokenBudget?: number; // 누적 토큰 상한
  plan?: string; // PLAN 에서 확정된 실행계획
  note?: string; // 마지막 사유(승인/거부/차단/검증)
  reviewHistory: string[]; // 리뷰/검증에서 거부된 사유 누적
  phsId?: string; // 현재 작업 중인 spec-graph PHS id
  createdAt: number;
}

const STATE_ENTRY_TYPE = "superpi-state";

// 페이즈별 전이 툴(이 툴들만 그 페이즈에서 활성). 작업 도구(read/edit/...)는
// 별도로 phaseWorkTools 가 정한다.
const PHASE_TRANSITIONS: Record<Phase, string[]> = {
  SETUP: ["setup_done", "pipeline_blocked"],
  PLAN: ["phase_plan_ready", "pipeline_blocked"],
  PLAN_REVIEW: ["phase_plan_approved", "phase_replan", "pipeline_blocked"],
  WORK: ["phase_work_done", "pipeline_blocked"],
  VERIFY: ["phase_verify_pass", "phase_verify_fail", "pipeline_blocked"],
  DONE: [],
  BLOCKED: [],
};

// 페이즈별 작업 도구 정책. 읽기전용 페이즈는 edit/write 를 빼서 코드 변경을
// 물리적으로 차단한다. WORK 만 전체 도구. (SETUP 은 spec-graph CLI 를 bash 로
// 돌려 그래프를 만들어야 하므로 읽기전용 + bash 유지.)
const READONLY_WORK_TOOLS = ["read", "bash", "grep", "find", "ls", "ask_question", "questionnaire", "superpi_note", "spawn_subagents", "fetch_subagent_result", "list_subagents", "send_to_subagent", "abort_subagent"];
const FULL_WORK_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "ask_question", "questionnaire", "superpi_note", "spawn_subagents", "fetch_subagent_result", "list_subagents", "send_to_subagent", "abort_subagent"];

const phaseWorkTools = (phase: Phase): string[] =>
  phase === "WORK" ? FULL_WORK_TOOLS : READONLY_WORK_TOOLS;

const phaseEmoji: Record<Phase, string> = {
  SETUP: "🗂",
  PLAN: "📋",
  PLAN_REVIEW: "🔍",
  WORK: "🔨",
  VERIFY: "✅",
  DONE: "🏁",
  BLOCKED: "🚧",
};

// 적대적 멀티에이전트 플래닝(hyperplan). OmO 의 hyperplan 모드를 spawn_subagents
// 병렬 + 교차비판 라운드로 이식. 한 모델의 첫 아이디어가 아니라 여러 관점이
// 충돌해 걸러진 계획을 만든다. what 은 각 페이즈가 채운다.
const HYPERPLAN = (what: string): string =>
  `Use HYPERPLAN (adversarial multi-agent planning) for ${what}:\n` +
  `1. INDEPENDENT ANALYSIS — via spawn_subagents, fire 3-4 planners IN PARALLEL with DIFFERENT lenses on the same problem: e.g. one optimizes simplicity, one performance/scale, one maintainability/risk; consult \`oracle\` for the hard architectural calls. Each returns its proposed approach.\n` +
  `2. CROSS-ATTACK — take the returned proposals and have them ruthlessly critiqued against each other (delegate a \`reviewer\`/\`oracle\` pass, or re-fire each planner with the others' proposals): where does each break? what did each miss? hidden coupling, scope creep, wrong assumptions.\n` +
  `3. DISTILL — keep only the insights that SURVIVED the cross-attack. Discard what was refuted. You synthesize; do not just pick one proposal wholesale.\n` +
  `4. AUTHOR — hand the distilled, defensible insights to the \`plan\` preset to produce the final artifact.`;

// 턴 종료 규칙. 모델이 계획 중 애매하게 손 놓는 걸 막고, 반드시 질문이든
// 제출이든 명확한 끝으로 끝내게 강제. (standard/hyperplan 둘 다 적용.)
const TURN_TERMINATION =
  `TURN TERMINATION RULE (no exceptions): your turn MUST end with EITHER ` +
  `(a) a question to the USER via ask_question/questionnaire, OR (b) the phase's submit tool. ` +
  `NEVER end with a passive hand-off ("let me know if...", "when you're ready", a bare summary with no next action, or waiting silently). ` +
  `If subagents are still running, that is also a valid end — you'll be re-prompted when they finish.`;

export default function (pi: ExtensionAPI) {
  // 자식 subagent 에서는 비활성 (subagents 가 자식 env 에 PI_SUBAGENT=1 을 박는다).
  if (process.env.PI_SUBAGENT) return;

  let pipe: PipelineState | null = null;

  // ── 영속화 ────────────────────────────────────────────────────────────
  const persist = () => {
    if (pipe) pi.appendEntry(STATE_ENTRY_TYPE, pipe as unknown as Record<string, unknown>);
  };

  const isLive = () => !!pipe && pipe.status === "pursuing";

  // ── 툴 게이팅 ─────────────────────────────────────────────────────────
  // 모든 전이 툴 이름(어느 페이즈건 superpi 가 등록한 것들).
  const ALL_TRANSITION_TOOLS = [
    "setup_done",
    "phase_plan_ready",
    "phase_plan_approved",
    "phase_replan",
    "phase_work_done",
    "phase_verify_pass",
    "phase_verify_fail",
    "pipeline_blocked",
  ];

  // ── spec-graph CLI 연동 ────────────────────────────────────────────
  // 전이 툴 안에서 spec-graph 를 직접 shell-out 해 exit code 로 게이트한다.
  // 모델의 "통과했다" 주장이 아니라 CLI 종료코드가 근거다.
  interface SgResult { code: number; json: any; stdout: string; stderr: string }
  const specGraph = async (args: string[], ctx: ExtensionContext): Promise<SgResult> => {
    const r = await pi.exec("spec-graph", args, { cwd: ctx.cwd, timeout: 60000 });
    let json: any = null;
    try {
      json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    } catch {
      json = null;
    }
    return { code: r.code, json, stdout: r.stdout, stderr: r.stderr };
  };

  // PHS resolved 게이트: exit 0 면 통과, 그 외는 issues 를 문자열로 환류.
  const resolvePhase = async (phsId: string, ctx: ExtensionContext): Promise<{ ok: boolean; detail: string }> => {
    const r = await specGraph(["entity", "update", phsId, "--status", "resolved"], ctx);
    if (r.code === 0 && !(r.json && r.json.blocked)) {
      return { ok: true, detail: `${phsId} resolved` };
    }
    const issues = r.json?.issues ?? [];
    const lines = Array.isArray(issues)
      ? issues.map((i: any) => `- [${i.severity ?? "?"}] ${i.entity ?? ""}: ${i.message ?? ""}`).join("\n")
      : (r.stderr || r.stdout || "unknown gate failure");
    return { ok: false, detail: `spec-graph blocked ${phsId} → resolved (exit ${r.code}):\n${lines}` };
  };

  // 다음 eligible PHS 를 활성화. "모두 resolved" 면 done=true.
  const advancePhase = async (ctx: ExtensionContext): Promise<{ done: boolean; phsId?: string; scope?: any; detail: string }> => {
    const r = await specGraph(["phase", "next", "--activate"], ctx);
    // "all resolved" 는 exit 0 + {error:{code:INVALID_INPUT}} 로 온다.
    if (r.json?.error) {
      return { done: true, detail: r.json.error.message ?? "no eligible next phase" };
    }
    const phsId = r.json?.phase?.id as string | undefined;
    if (!phsId) {
      return { done: false, detail: `phase next returned no phase (exit ${r.code}): ${r.stderr || r.stdout}` };
    }
    return { done: false, phsId, scope: r.json?.scope, detail: `activated ${phsId}` };
  };

  // ── notes 노트패드 + evidence (OmO notepad/evidence 이식) ─────────────
  // .superpi/ 아래에 영속. "AI 가 말로 때우는 것"을 디스크에 박는다.
  const NOTE_KINDS = ["learnings", "issues", "decisions", "problems"] as const;
  type NoteKind = (typeof NOTE_KINDS)[number];

  const slug = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "objective";

  const notesDir = (ctx: ExtensionContext): string | null => {
    if (!pipe) return null;
    return resolve(ctx.cwd, ".superpi", "notes", slug(pipe.objective));
  };
  const evidenceDir = (ctx: ExtensionContext): string =>
    resolve(ctx.cwd, ".superpi", "evidence");

  // append-only 기록. write/edit 가드(notepad-write-guard)와 한 쌍.
  const appendNote = (ctx: ExtensionContext, kind: NoteKind, text: string): string | null => {
    const dir = notesDir(ctx);
    if (!dir) return null;
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${kind}.md`);
      const stamp = new Date().toISOString();
      const phs = pipe?.phsId ? ` ${pipe.phsId}` : "";
      appendFileSync(file, `\n- [${stamp}${phs}] ${text.trim()}\n`, "utf-8");
      return file;
    } catch {
      return null;
    }
  };

  // 과거 notes 를 읽어 새 페이즈/세션 시작 시 컨텍스트로 환류.
  const readNotes = (ctx: ExtensionContext): string => {
    const dir = notesDir(ctx);
    if (!dir || !existsSync(dir)) return "";
    const parts: string[] = [];
    for (const kind of NOTE_KINDS) {
      const file = join(dir, `${kind}.md`);
      if (!existsSync(file)) continue;
      try {
        const body = readFileSync(file, "utf-8").trim();
        if (body) parts.push(`### ${kind}\n${body}`);
      } catch {
        /* ignore */
      }
    }
    return parts.join("\n\n");
  };

  // evidence 파일 존재를 기계적으로 확인 (모델 주장 검증용).
  const evidenceExists = (ctx: ExtensionContext, p: string): boolean => {
    const full = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    try {
      return existsSync(full);
    } catch {
      return false;
    }
  };

  // 현재 페이즈에 맞춰 활성 도구를 다시 건다.
  //  - 현재 활성 목록에서 superpi 전이 툴은 일단 전부 제거(다른 익스텐션 도구는 보존),
  //  - 그 페이즈의 작업 도구 + 전이 툴만 더한다.
  const applyPhaseTools = (ctx: ExtensionContext) => {
    if (!pipe || !isLive()) return;
    try {
      const active = new Set(pi.getActiveTools());
      // superpi 전이 툴 싹 제거
      for (const t of ALL_TRANSITION_TOOLS) active.delete(t);
      // 읽기전용 페이즈에서는 edit/write 도 제거(WORK 외)
      if (pipe.phase !== "WORK") {
        active.delete("edit");
        active.delete("write");
      }
      // 그 페이즈의 작업 도구 + 전이 툴 추가
      for (const t of phaseWorkTools(pipe.phase)) active.add(t);
      for (const t of PHASE_TRANSITIONS[pipe.phase]) active.add(t);
      pi.setActiveTools([...active]);
    } catch {
      // 런타임 초기화 전엔 호출 불가 — 무시(다음 이벤트에서 다시 건다).
    }
  };

  // 파이프라인이 끝나거나 없으면 전이 툴을 모두 내린다.
  const clearPhaseTools = () => {
    try {
      const active = new Set(pi.getActiveTools());
      for (const t of ALL_TRANSITION_TOOLS) active.delete(t);
      pi.setActiveTools([...active]);
    } catch {
      // 무시
    }
  };

  // ── 상태 표시 ─────────────────────────────────────────────────────────
  const setStatus = (ctx: ExtensionContext) => {
    if (isLive()) applyPhaseTools(ctx);
    else clearPhaseTools();
    if (!ctx.hasUI) return;
    if (!pipe) {
      ctx.ui.setStatus("superpi", undefined);
      return;
    }
    const e = phaseEmoji[pipe.phase];
    const counter = pipe.status === "pursuing" ? ` #${pipe.iteration}` : "";
    const label = pipe.status === "pursuing" ? pipe.phase : pipe.status;
    ctx.ui.setStatus("superpi", ctx.ui.theme.fg("dim", `${e} superpi ${label}${counter}`));
  };

  // ── 누적 토큰(예산 체크) ──────────────────────────────────────────────
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

  // ── 페이즈별 continuation 프롬프트 ────────────────────────────────────
  const phasePrompt = (p: PipelineState, ctx?: ExtensionContext): string => {
    const header = `[superpi · phase ${p.phase} · iteration ${p.iteration}]\nOBJECTIVE: ${p.objective}`;
    const phsLine = p.phsId ? `\nCurrent spec-graph phase: ${p.phsId}` : "";
    // 과거 notes(learnings/issues/decisions/problems)를 컨텍스트로 환류 — 페이즈·세션 간 이월.
    const notes = ctx ? readNotes(ctx) : "";
    const notesBlock = notes ? `\n\nDURABLE NOTES so far (.superpi/notes — append via superpi_note, do not repeat past mistakes):\n${notes.slice(0, 1500)}${notes.length > 1500 ? "\n…(truncated)" : ""}` : "";
    const reviews =
      (p.reviewHistory.length > 0
        ? `\n\nPrior rejections (address these):\n` + p.reviewHistory.map((r, i) => `${i + 1}. ${r}`).join("\n")
        : "") + notesBlock;

    switch (p.phase) {
      case "SETUP":
        return (
          `${header}\n\n` +
          `You are in the SETUP phase. This is a HEAVY task managed through spec-graph (the typed graph is the source of truth, not markdown). Code edits are DISABLED here.\n` +
          `Goal of this phase: produce a spec-graph plan (PLN + PHS phases) for this objective — decomposed via HYPERPLAN.\n` +
          `1. Load the \`spec-graph\` skill, then check for an existing graph: run \`spec-graph entity list --type plan --status active\` via bash. If an active plan already covers this objective, reuse it and skip to validation.\n` +
          `2. If there is NO active plan (or no .spec-graph/): run \`spec-graph init\` if needed. Then decide the PHASE DECOMPOSITION (how to split this objective into PHS phases) using HYPERPLAN — this is the highest-leverage decision, so do NOT let a single agent decide it alone.\n\n` +
          HYPERPLAN("the PLN-level phase decomposition (how to break this objective into ordered, buildable PHS phases)") + `\n\n` +
          `3. Register the surviving decomposition into spec-graph: arch entities (REQ/DEC/ACT/RSK), a PLN, its PHS phases, covers mappings. YOU run the spec-graph CLI commands (do not delegate CLI writes). Every PHS's exit_criteria MUST include "project builds" and "all tests pass".\n` +
          `4. Pass 3-layer \`spec-graph validate\` (arch/exec/mapping).\n` +
          `When the graph exists and validates, call setup_done.\n\n` +
          TURN_TERMINATION +
          reviews
        );
      case "PLAN":
        return (
          `${header}${phsLine}\n\n` +
          `You are in the PLAN phase for spec-graph phase ${p.phsId ?? "(none)"}. Code edits are DISABLED. Produce a concrete, INTERVIEWED execution plan for THIS phase's scope only.\n\n` +
          `Step 1 — Scope: run \`spec-graph query scope ${p.phsId ?? "<PHS>"}\` via bash to see exactly which arch entities (REQ/DEC/ACT/...) this phase covers. Plan only for those.\n` +
          `Step 2 — Research in PARALLEL: fire \`explorer\` (existing patterns, conventions, test infra) and \`librarian\` (external lib docs) via spawn_subagents before planning. Never plan blind — context first.\n` +
          `Step 3 — INTERVIEW THE USER (this is the point — do not skip): resolve ambiguity by ASKING, not assuming. Use the ask_question tool (or questionnaire if available) to ask the user about anything that would change the plan. Apply this clearance checklist; every box must be YES before you submit:\n` +
          `   - Core objective for this phase clearly defined?\n` +
          `   - Scope boundaries set (what's IN and explicitly OUT)?\n` +
          `   - No critical ambiguities left? (business-logic choices, tech/library preferences, naming, error-handling depth)\n` +
          `   - Technical approach decided (not "probably/maybe")?\n` +
          `   - Test strategy confirmed (TDD / tests-after / none) AND every task will carry a concrete verification?\n` +
          `   When in doubt about USER INTENT, ASK. When in doubt about a reasonable default, apply it and disclose it. Don't ask about trivia you can resolve by reading code.\n` +
          `Step 4 — Author the plan via HYPERPLAN (do not let a single agent decide the approach alone):\n\n` +
          HYPERPLAN("this phase's execution plan (the approach + task breakdown for " + (p.phsId ?? "this phase") + "'s scope)") + `\n\n` +
          `The final plan MUST have: a parallel-wave task graph (independent tasks grouped into waves, dependencies marked), and MANDATORY task decomposition — every task broken to implementation grain: the exact file(s)/function(s) to touch, what changes, and \`verify by <observable check>\`. No vague tasks like "implement the feature"; if a task can't name its files/surface it's not decomposed enough. Include a verification contract (happy/edge/regression with binary pass conditions on a real surface, not just "tests pass").\n` +
          `When the clearance checklist is all YES and the plan is concrete and complete, call phase_plan_ready with the full plan text.\n\n` +
          TURN_TERMINATION +
          reviews
        );
      case "PLAN_REVIEW":
        return (
          `${header}${phsLine}\n\nPLAN UNDER REVIEW:\n${p.plan ?? "(missing)"}\n\n` +
          `You are in the PLAN_REVIEW phase. Code edits are DISABLED. The plan must pass an adversarial review before any work starts.\n` +
          `- Delegate the plan to the \`reviewer\` preset via spawn_subagents. Pass it the objective, the phase scope, and the full plan; ask for a binding verdict.\n` +
          `- Also confirm the graph has no blockers for this phase: \`spec-graph validate --layer arch --check unresolved\` via bash.\n` +
          `- If the reviewer approves AND there are no unresolved blockers, call phase_plan_approved with the reviewer's subagent runId and a one-line verdict.\n` +
          `- If the reviewer rejects (or you find a real gap), call phase_replan with the concrete reasons; the pipeline returns to PLAN.` +
          reviews
        );
      case "WORK":
        return (
          `${header}${phsLine}\n\nAPPROVED PLAN:\n${p.plan ?? "(missing)"}\n\n` +
          `You are in the WORK phase for spec-graph phase ${p.phsId ?? "(none)"}. Full tools are enabled. You are the COORDINATOR, not the laborer. Follow the \`spec-executor\` skill discipline.\n` +
          `- Execute the approved plan in its EXACT wave order and parallel grouping — do not invent your own ordering or skip its per-task verification.\n` +
          `- Before implementing an entity, run \`spec-graph impact <ID>\` via bash and act on the affected set.\n` +
          `- DELEGATE FIRST: hand each self-contained implementation chunk to a \`general\` subagent via spawn_subagents; fire INDEPENDENT chunks (a whole wave) in PARALLEL and serialize only true dependencies. Use \`explorer\`/\`librarian\` for lookups. Give each delegate an exhaustive prompt (TASK / EXPECTED OUTCOME / MUST DO / MUST NOT DO / CONTEXT). NEVER trust a subagent's self-report — verify its output yourself.\n` +
          `- Edit directly yourself only when delegation overhead clearly exceeds the work (a one-line fix, glue/integration of subagent output, or a step too small to farm out). Prefer delegation by default.\n` +
          `- CONTINUOUS VERIFICATION: after EACH wave (not just at the end), run the relevant build/tests/type-check on what changed. If it breaks, STOP and fix before starting the next wave — never stack new work on a broken base.\n` +
          `- RECORD AS YOU GO (durable, not in your head): every architectural choice → register a spec-graph DEC (\`spec-graph entity add --type decision\` with rationale, and link \`constrained_by\` to affected REQ). Patterns that worked → superpi_note kind=learnings. Blockers/gotchas → kind=issues. Unresolved debt → kind=problems.\n` +
          `- As you discover artifacts (API/STT/TST/QST/ASM), register them in spec-graph. When an entity is actually done, add a \`delivers\` relation for the minimal proxy set. YOU run all spec-graph CLI commands.\n` +
          `- NO EXCUSES, NO COMPROMISES: deliver exactly what the plan specifies. No "demo"/"skeleton"/"simplified"/"basic" version, no stopping at 60-80%, no unauthorized scope reduction, no deleting tests to go green. If blocked, consult \`oracle\` or try a different approach before calling pipeline_blocked.\n` +
          `When every plan step for this phase is implemented, delivers are recorded, and each wave verified, call phase_work_done with a summary of what changed.` +
          reviews
        );
      case "VERIFY":
        return (
          `${header}${phsLine}\n\n` +
          `You are in the VERIFY phase for spec-graph phase ${p.phsId ?? "(none)"}. Code edits are DISABLED — this phase only validates. Follow the \`spec-verifier\` skill discipline.\n` +
          `- Run the real build and the real tests. Capture their ACTUAL output — you will write it to an evidence file (see below).\n` +
          `- Run \`spec-graph validate --layer mapping --phase ${p.phsId ?? "<PHS>"}\` and resolve any unresolved questions/risks (the CLI will block phase resolution otherwise).\n` +
          `- FINAL REVIEW WAVE — delegate these reviewers IN PARALLEL via spawn_subagents and require ALL to approve:\n` +
          `    F1 plan-compliance (\`reviewer\`): every "must have" implemented, every "must NOT" absent.\n` +
          `    F2 code-quality (\`reviewer\`): build/lint/tests clean; no \`as any\`/empty catches/dead code/AI-slop.\n` +
          `    F3 real QA (\`general\` or \`reviewer\`): execute every QA scenario from the plan on the REAL surface (curl/CLI/UI/DB) — "tests pass" alone is NOT evidence.\n` +
          `    F4 scope-fidelity (\`oracle\`): 1:1 with the plan — nothing missing, nothing built beyond scope.\n` +
          `- Write the captured verification output (commands + real results + each reviewer verdict) to a file, e.g. \`.superpi/evidence/${p.phsId ?? "PHS"}-verify.txt\`. Record key learnings/issues via superpi_note.\n` +
          `- When all reviewers approve, call phase_verify_pass with the reviewer runId, an evidence summary, AND evidencePath pointing at that file. superpi checks the file exists, then runs \`spec-graph entity update ${p.phsId ?? "<PHS>"} --status resolved\`; if either gate fails you stay in VERIFY.\n` +
          `- If anything fails, call phase_verify_fail with the findings; the pipeline returns to WORK.` +
          reviews
        );
      default:
        return header;
    }
  };

  // ── 루프 재투입 ───────────────────────────────────────────────────────
  // agent_end 직후 idle 전환 타이밍을 안전하게 잡기 위해 한 틱 미룬다.
  const kick = (ctx: ExtensionContext) => {
    setTimeout(() => {
      if (!isLive() || !pipe) return;
      const prompt = phasePrompt(pipe, ctx);
      if (ctx.isIdle()) pi.sendUserMessage(prompt);
      else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    }, 0);
  };

  // 마지막 assistant 메시지에서 toolCall 이름들을 뽑는다.
  const lastAssistantToolCalls = (event: { messages?: unknown[] }): string[] => {
    const msgs = (event.messages ?? []) as Array<{ role?: string; content?: unknown; stopReason?: string }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== "assistant") continue;
      const content = Array.isArray(m.content) ? m.content : [];
      return content
        .filter((c): c is ToolCall => (c as { type?: string }).type === "toolCall")
        .map((c) => c.name);
    }
    return [];
  };

  const lastAssistantAborted = (event: { messages?: unknown[] }): boolean => {
    const msgs = (event.messages ?? []) as Array<{ role?: string; stopReason?: string }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") return msgs[i].stopReason === "aborted";
    }
    return false;
  };

  // ── agent_end: 다음 step 재투입 ───────────────────────────────────────
  pi.on("agent_end", async (event, ctx) => {
    if (!isLive() || !pipe) return;

    // 사용자가 Esc 로 abort → paused, 자동 재투입 안 함.
    if (lastAssistantAborted(event)) {
      pipe.status = "paused";
      pipe.note = "aborted by user (Esc) — /superpi resume to continue";
      persist();
      setStatus(ctx);
      if (ctx.hasUI) ctx.ui.notify("⏸ Aborted (Esc). /superpi resume to continue.", "info");
      return;
    }

    // 토큰 예산 초과 → 정지.
    if (pipe.tokenBudget && cumulativeTokens(ctx) >= pipe.tokenBudget) {
      pipe.status = "budget-limited";
      pipe.note = `token budget ${pipe.tokenBudget} reached`;
      persist();
      setStatus(ctx);
      pi.events.emit("superpi:status-change", { status: "budget-limited", objective: pipe.objective, phase: pipe.phase });
      if (ctx.hasUI) ctx.ui.notify(`superpi stopped: token budget (${pipe.tokenBudget}) reached.`, "warning");
      return;
    }

    // 이 턴에 subagent 를 띄웠으면(=자식 in-flight) 재투입하지 않는다.
    // subagents 의 "[subagent ... finished]" 메시지가 다음 턴을 구동한다.
    const calls = lastAssistantToolCalls(event);
    if (calls.includes("spawn_subagents")) {
      // 페이즈 전이 툴은 다음 턴에도 살아있어야 하므로 상태만 유지.
      return;
    }
    // 이 턴이 전이 툴 호출로 끝났으면, execute 안에서 이미 페이즈를 바꾸고 kick 했다.
    // 중복 재투입 방지: 전이 툴이 호출된 턴이면 여기서 재투입하지 않는다.
    const hitTransition = calls.some((c) => ALL_TRANSITION_TOOLS.includes(c));
    if (hitTransition) return;

    // 그 외(자식도 없고 전이도 없는 평범한 턴 종료): 현재 페이즈를 계속 밀어준다.
    pipe.iteration += 1;
    persist();
    setStatus(ctx);
    kick(ctx);
  });

  // ── 전이 툴 ───────────────────────────────────────────────────────────
  // 전이 공통 처리: 페이즈 변경 → 영속 → 상태/툴 동기화 → 다음 페이즈 kick.
  const transition = (ctx: ExtensionContext, to: Phase, note?: string) => {
    if (!pipe) return;
    pipe.phase = to;
    pipe.iteration += 1;
    if (note !== undefined) pipe.note = note;
    persist();
    setStatus(ctx); // applyPhaseTools 가 여기서 새 페이즈 도구를 건다
    if (to !== "DONE" && to !== "BLOCKED") kick(ctx);
  };

  // ── superpi_note: append-only 노트패드 기록 툴 (항상 활성) ────────────
  pi.registerTool({
    name: "superpi_note",
    label: "superpi Note",
    description:
      "Append a finding to the durable superpi notepad for this objective (.superpi/notes/<slug>/<kind>.md). " +
      "Append-only — use this instead of write/edit for notes. kind: learnings (patterns/conventions that worked), " +
      "issues (problems/blockers/gotchas hit), decisions (choices + rationale — also register architectural ones as spec-graph DEC), " +
      "problems (unresolved issues / tech debt to revisit).",
    promptSnippet: "Record a learning/issue/decision/problem to the durable notepad",
    promptGuidelines: [
      "Use superpi_note to record learnings, issues, decisions, and problems as you work — they survive across phases and sessions.",
      "Record a note when you discover a non-obvious pattern, hit a blocker, make a design choice, or find tech debt. Don't wait until the end.",
    ],
    parameters: Type.Object({
      kind: Type.Union(NOTE_KINDS.map((k) => Type.Literal(k)), { description: "learnings | issues | decisions | problems" }),
      text: Type.String({ description: "The note. One concrete finding; be specific (file paths, symbols, reasons)." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe) {
        return { content: [{ type: "text", text: "No active superpi pipeline — notes are scoped to a running objective." }], details: {} };
      }
      const file = appendNote(ctx, params.kind as NoteKind, params.text);
      if (!file) return { content: [{ type: "text", text: "Failed to write note." }], details: {} };
      return { content: [{ type: "text", text: `Recorded to ${file}` }], details: { file, kind: params.kind } };
    },
  });

  // ── notepad-write-guard (item 7): notes 파일 직접 write/edit 차단 → append 강제 ─
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const p = (event.input as { path?: string }).path;
    if (!p) return;
    const full = isAbsolute(p) ? p : resolve(ctx.cwd, p);
    const notesRoot = resolve(ctx.cwd, ".superpi", "notes");
    if (full === notesRoot || full.startsWith(notesRoot + "/")) {
      return {
        block: true,
        reason:
          `superpi: .superpi/notes/** is append-only. Use the superpi_note tool (kind + text) instead of ${event.toolName} — ` +
          `it preserves history; write/edit would clobber it.`,
      };
    }
  });

  pi.registerTool({
    name: "setup_done",
    label: "Setup Done",
    description: "SETUP→PLAN. The spec-graph plan exists and validates. Activates the first phase. Only valid in the SETUP phase.",
    promptSnippet: "Finish SETUP once the spec-graph plan exists and validates",
    promptGuidelines: [
      "Call setup_done only after a spec-graph plan with phases exists and `spec-graph validate` passes all three layers.",
    ],
    parameters: Type.Object({
      planId: Type.String({ description: "The active spec-graph plan id (e.g. PLN-001)." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe || pipe.phase !== "SETUP") {
        return { content: [{ type: "text", text: "setup_done is only valid in the SETUP phase." }], details: {} };
      }
      // 첫 eligible PHS 를 활성화해 PLAN 으로 들어간다.
      const adv = await advancePhase(ctx);
      if (adv.done) {
        return {
          content: [{ type: "text", text: `No activatable phase found (${adv.detail}). The plan has no draft phases to work on — ensure spec-planner created PHS entities under an active plan, then retry setup_done.` }],
          details: { advance: adv.detail },
        };
      }
      pipe.phsId = adv.phsId;
      transition(ctx, "PLAN", `setup complete (plan ${params.planId}); activated ${adv.phsId}`);
      return { content: [{ type: "text", text: `Setup complete. Activated spec-graph phase ${adv.phsId}. Entering PLAN for its scope.` }], details: { planId: params.planId, phsId: adv.phsId } };
    },
  });

  pi.registerTool({
    name: "phase_plan_ready",
    label: "Plan Ready",
    description: "PLAN→PLAN_REVIEW. Submit the concrete execution plan for adversarial review. Only valid in the PLAN phase.",
    promptSnippet: "Submit the finished execution plan to move from PLAN to PLAN_REVIEW",
    parameters: Type.Object({
      plan: Type.String({ description: "The full, concrete execution plan (task list with dependencies and per-task verification)." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe || pipe.phase !== "PLAN") {
        return { content: [{ type: "text", text: "phase_plan_ready is only valid in the PLAN phase." }], details: {} };
      }
      pipe.plan = params.plan;
      transition(ctx, "PLAN_REVIEW", "plan submitted for review");
      return { content: [{ type: "text", text: "Plan recorded. Entering PLAN_REVIEW — delegate it to the reviewer preset." }], details: { plan: params.plan } };
    },
  });

  pi.registerTool({
    name: "phase_plan_approved",
    label: "Plan Approved",
    description: "PLAN_REVIEW→WORK. Record the reviewer's approval, then ask the USER to approve the plan before any work starts. Requires the reviewer's subagent runId. Only valid in PLAN_REVIEW.",
    promptSnippet: "Record reviewer approval, then get the user's go-ahead before WORK",
    promptGuidelines: [
      "Call phase_plan_approved only after a reviewer subagent has actually approved the plan; pass its runId. superpi will then ask the USER for final approval before entering WORK.",
    ],
    parameters: Type.Object({
      reviewerRunId: Type.String({ description: "The runId of the reviewer subagent that approved the plan." }),
      verdict: Type.String({ description: "One-line summary of the reviewer's verdict." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe || pipe.phase !== "PLAN_REVIEW") {
        return { content: [{ type: "text", text: "phase_plan_approved is only valid in the PLAN_REVIEW phase." }], details: {} };
      }

      // 사람 승인 게이트: AI 리뷰가 통과해도 WORK 전에 사용자의 명시적 동의를 받는다.
      // UI 없는 환경(print 등)에서 select 는 undefined → 자율 진행(비대화 폴백).
      let decision: string | undefined = "Approve & start work";
      if (ctx.hasUI) {
        const planPreview = (pipe.plan ?? "(no plan recorded)").slice(0, 1200);
        ctx.ui.notify(`✅ Reviewer approved the plan for ${pipe.phsId ?? "this phase"}.\nVerdict: ${params.verdict}`, "info");
        decision = await ctx.ui.select(
          `superpi · approve the plan for ${pipe.phsId ?? "this phase"} before WORK starts?\n\n${planPreview}${(pipe.plan ?? "").length > 1200 ? "\n…(truncated; full plan is in the conversation)" : ""}`,
          ["Approve & start work", "Refine the plan", "Block (stop pipeline)"],
        );
      }

      if (decision === "Refine the plan") {
        // 사용자에게 수정 방향을 받아 PLAN 으로 되돌린다.
        let refine: string | undefined;
        if (ctx.hasUI) refine = await ctx.ui.input("What should change in the plan?", "e.g. split task 3, use library X, add migration step");
        const note = refine && refine.trim() ? refine.trim() : "user requested plan refinement";
        pipe.reviewHistory.push(`[user-refine] ${note}`);
        transition(ctx, "PLAN", `user requested refine: ${note}`);
        return { content: [{ type: "text", text: `User wants the plan refined before work. Returning to PLAN. Address this: ${note}` }], details: { refine: note } };
      }

      if (decision === "Block (stop pipeline)" || decision === undefined) {
        // 명시적 Block, 또는 UI에서 취소/타임아웃(undefined)한 경우 — 멈춘다.
        // (비대화 폴백은 decision 이 "Approve..." 이므로 여기 안 온다.)
        pipe.status = "blocked";
        pipe.note = "user declined to approve the plan";
        const prev = pipe.phase;
        pipe.phase = "BLOCKED";
        persist();
        setStatus(ctx);
        pi.events.emit("superpi:status-change", { status: "blocked", objective: pipe.objective, phase: prev, note: pipe.note });
        if (ctx.hasUI) ctx.ui.notify("🚧 Plan not approved — pipeline stopped. /superpi resume to revisit.", "warning");
        return { content: [{ type: "text", text: "User did not approve the plan. Pipeline stopped (BLOCKED). Use /superpi resume to revisit planning." }], details: { blocked: true }, terminate: true };
      }

      // Approve (또는 비대화 폴백) → WORK.
      transition(ctx, "WORK", `plan approved (reviewer ${params.reviewerRunId}; user OK): ${params.verdict}`);
      return { content: [{ type: "text", text: "Plan approved by reviewer and user. Entering WORK — you are the coordinator; fan out independent work to subagents." }], details: params };
    },
  });

  pi.registerTool({
    name: "phase_replan",
    label: "Replan",
    description: "PLAN_REVIEW→PLAN. The plan was rejected; return to planning with the concrete reasons. Only valid in PLAN_REVIEW.",
    promptSnippet: "Send the plan back to PLAN with rejection reasons",
    parameters: Type.Object({
      reasons: Type.String({ description: "Concrete reasons the plan was rejected and what must change." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe || pipe.phase !== "PLAN_REVIEW") {
        return { content: [{ type: "text", text: "phase_replan is only valid in the PLAN_REVIEW phase." }], details: {} };
      }
      pipe.reviewHistory.push(`[plan] ${params.reasons}`);
      transition(ctx, "PLAN", "plan rejected — replanning");
      return { content: [{ type: "text", text: "Returning to PLAN. Address the rejection reasons in the new plan." }], details: params };
    },
  });

  pi.registerTool({
    name: "phase_work_done",
    label: "Work Done",
    description: "WORK→VERIFY. Declare the implementation complete and move to verification. Only valid in the WORK phase.",
    promptSnippet: "Move from WORK to VERIFY once the implementation is complete",
    parameters: Type.Object({
      summary: Type.String({ description: "Summary of what was implemented/changed across the plan." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe || pipe.phase !== "WORK") {
        return { content: [{ type: "text", text: "phase_work_done is only valid in the WORK phase." }], details: {} };
      }
      transition(ctx, "VERIFY", `work done: ${params.summary}`);
      return { content: [{ type: "text", text: "Implementation recorded. Entering VERIFY — edits are now disabled; run build/tests and delegate a final review." }], details: params };
    },
  });

  pi.registerTool({
    name: "phase_verify_pass",
    label: "Verify Pass",
    description: "Finish verifying the current spec-graph phase. Requires a reviewer runId, an evidence summary, AND an evidencePath to a file containing the real captured output (build/test/curl logs). superpi checks the file exists, then runs the CLI resolve gate. Only valid in VERIFY.",
    promptSnippet: "Resolve the current spec-graph phase after verification passes with evidence on disk",
    promptGuidelines: [
      "Call phase_verify_pass only when the real build/tests pass AND a reviewer subagent approved. You MUST first write the actual captured output (commands + their real stdout/results) to a file (e.g. .superpi/evidence/<PHS>-verify.txt) and pass its path as evidencePath. superpi verifies that file exists and runs the spec-graph resolve gate; if either fails, you stay in VERIFY.",
    ],
    parameters: Type.Object({
      reviewerRunId: Type.String({ description: "The runId of the reviewer subagent that approved the finished change." }),
      evidence: Type.String({ description: "Concrete verification evidence summary: commands run and their results (build, tests, real surface)." }),
      evidencePath: Type.String({ description: "Path to a file on disk holding the real captured verification output (e.g. .superpi/evidence/<PHS>-verify.txt). Must exist." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe || pipe.phase !== "VERIFY") {
        return { content: [{ type: "text", text: "phase_verify_pass is only valid in the VERIFY phase." }], details: {} };
      }
      const phsId = pipe.phsId;
      if (!phsId) {
        return { content: [{ type: "text", text: "No spec-graph phase is associated with this run — cannot resolve. This is a state error; consider /superpi clear and restart." }], details: {} };
      }

      // ① 증거 파일 기계 검증: evidencePath 가 실제로 존재해야 한다(모델 주장만으론 불가).
      if (!params.evidencePath || !evidenceExists(ctx, params.evidencePath)) {
        pipe.reviewHistory.push(`[evidence] missing evidence file: ${params.evidencePath || "(none)"}`);
        persist();
        return {
          content: [{ type: "text", text: `superpi: evidence file not found at "${params.evidencePath || "(none)"}". Write the real verification output (build/test/curl logs) to a file under .superpi/evidence/ and pass its path as evidencePath. Staying in VERIFY.` }],
          details: { blocked: true, reason: "evidence-missing" },
        };
      }

      // ② CLI 게이트: spec-graph 가 PHS 를 resolved 로 올리는지 exit code 로 판정.
      const gate = await resolvePhase(phsId, ctx);
      if (!gate.ok) {
        // 게이트 실패 → VERIFY 에 머문다. 사유를 모델에 환류.
        pipe.reviewHistory.push(`[gate] ${gate.detail}`);
        persist();
        return {
          content: [{ type: "text", text: `spec-graph gate blocked phase resolution. Resolve these in the graph, then call phase_verify_pass again:\n${gate.detail}` }],
          details: { blocked: true, phsId },
        };
      }

      // ② 다음 eligible PHS 활성화 (외부 루프).
      const adv = await advancePhase(ctx);
      if (adv.done) {
        // 모든 PHS resolved → 파이프라인 완료.
        pipe.status = "done";
        pipe.phsId = undefined;
        transition(ctx, "DONE", `all phases resolved (last: ${phsId})`);
        pi.events.emit("superpi:status-change", { status: "done", objective: pipe.objective, phase: "DONE", note: params.evidence });
        if (ctx.hasUI) ctx.ui.notify("🏁 superpi pipeline complete — all spec-graph phases resolved.", "info");
        return { content: [{ type: "text", text: `Phase ${phsId} resolved. All spec-graph phases complete — pipeline done. Evidence: ${params.evidence}` }], details: { phsId, done: true }, terminate: true };
      }

      // ③ 다음 PHS 로 PLAN 재진입.
      const prevReviews = pipe.reviewHistory.length; // 새 페이즈는 과거 거부리스트를 이월.
      void prevReviews;
      pipe.phsId = adv.phsId;
      pipe.plan = undefined;
      pipe.reviewHistory = [];
      transition(ctx, "PLAN", `phase ${phsId} resolved; advanced to ${adv.phsId}`);
      if (ctx.hasUI) ctx.ui.notify(`✅ ${phsId} resolved → next phase ${adv.phsId}.`, "info");
      return { content: [{ type: "text", text: `Phase ${phsId} resolved (evidence: ${params.evidence}). Advanced to spec-graph phase ${adv.phsId}. Entering PLAN for its scope.` }], details: { phsId, next: adv.phsId } };
    },
  });

  pi.registerTool({
    name: "phase_verify_fail",
    label: "Verify Fail",
    description: "VERIFY→WORK. Verification found problems; return to implementation with the findings. Only valid in VERIFY.",
    promptSnippet: "Send the change back to WORK with verification findings",
    parameters: Type.Object({
      findings: Type.String({ description: "What failed in verification and what must be fixed." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe || pipe.phase !== "VERIFY") {
        return { content: [{ type: "text", text: "phase_verify_fail is only valid in the VERIFY phase." }], details: {} };
      }
      pipe.reviewHistory.push(`[verify] ${params.findings}`);
      transition(ctx, "WORK", "verification failed — back to work");
      return { content: [{ type: "text", text: "Returning to WORK. Fix the findings, then re-verify." }], details: params };
    },
  });

  pi.registerTool({
    name: "pipeline_blocked",
    label: "Pipeline Blocked",
    description: "Declare the pipeline blocked: you cannot proceed without a user decision or information. Stops the loop. Valid in any active phase.",
    promptSnippet: "Stop the pipeline when blocked and needing user input",
    promptGuidelines: [
      "Call pipeline_blocked when you cannot make progress without a decision or information from the user.",
    ],
    parameters: Type.Object({
      reason: Type.String({ description: "Why the pipeline is blocked and what input is needed." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!pipe || !isLive()) {
        return { content: [{ type: "text", text: "No active pipeline to block." }], details: {} };
      }
      pipe.status = "blocked";
      pipe.note = params.reason;
      const prevPhase = pipe.phase;
      pipe.phase = "BLOCKED";
      persist();
      setStatus(ctx);
      pi.events.emit("superpi:status-change", { status: "blocked", objective: pipe.objective, phase: prevPhase, note: params.reason });
      if (ctx.hasUI) ctx.ui.notify("🚧 superpi blocked — stopping the loop.", "warning");
      return { content: [{ type: "text", text: `Pipeline blocked: ${params.reason}` }], details: params, terminate: true };
    },
  });

  // ── /superpi 명령 ─────────────────────────────────────────────────────
  const parseObjective = (raw: string): { objective: string; tokenBudget?: number } => {
    let tokenBudget: number | undefined;
    const tokens = raw.trim().split(/\s+/);
    const rest: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const take = (key: string): string | undefined => {
        if (t === key) return tokens[++i];
        if (t.startsWith(key + "=")) return t.slice(key.length + 1);
        return undefined;
      };
      const bd = take("--budget");
      if (bd !== undefined) {
        const n = parseInt(bd, 10);
        if (Number.isFinite(n) && n > 0) tokenBudget = n;
        continue;
      }
      rest.push(t);
    }
    return { objective: rest.join(" ").trim(), tokenBudget };
  };

  const showStatus = (ctx: ExtensionContext) => {
    if (!pipe) {
      ctx.ui.notify("No active pipeline. Start one with /superpi <objective>.", "info");
      return;
    }
    const lines = [
      `${phaseEmoji[pipe.phase]} phase ${pipe.phase} · ${pipe.status} (iteration ${pipe.iteration}` +
        (pipe.tokenBudget ? `, budget ${pipe.tokenBudget} tok` : "") +
        `)`,
      `Objective: ${pipe.objective}`,
    ];
    if (pipe.plan) lines.push(`Plan: ${pipe.plan.slice(0, 200)}${pipe.plan.length > 200 ? "…" : ""}`);
    if (pipe.note) lines.push(`Note: ${pipe.note}`);
    if (pipe.reviewHistory.length) lines.push(`Rejections: ${pipe.reviewHistory.length}`);
    ctx.ui.notify(lines.join("\n"), "info");
  };

  pi.registerCommand("superpi", {
    description:
      "Phase-gated autonomous pipeline (PLAN→REVIEW→WORK→VERIFY→DONE). Start with /superpi <objective>, control with /superpi pause|resume|clear|status. (supports --budget N)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [sub] = trimmed.split(/\s+/);

      if (trimmed === "" || sub === "status") {
        showStatus(ctx);
        return;
      }
      if (sub === "pause") {
        if (!isLive() || !pipe) {
          ctx.ui.notify("No pipeline is being tracked.", "warning");
          return;
        }
        pipe.status = "paused";
        persist();
        setStatus(ctx);
        ctx.ui.notify("⏸ Pipeline paused. /superpi resume to continue.", "info");
        return;
      }
      if (sub === "resume") {
        if (!pipe) {
          ctx.ui.notify("No pipeline to resume.", "warning");
          return;
        }
        if (pipe.status === "pursuing") {
          ctx.ui.notify("Already running.", "info");
          return;
        }
        if (pipe.phase === "DONE" || pipe.phase === "BLOCKED") {
          // 차단/완료에서 재개하면 직전 작업 페이즈로 보낸다(BLOCKED 이전 단계 모르면 WORK).
          pipe.phase = pipe.phsId ? "WORK" : "SETUP";
        }
        pipe.status = "pursuing";
        pipe.note = undefined;
        persist();
        setStatus(ctx);
        ctx.ui.notify(`▶ Resuming pipeline at ${pipe.phase}.`, "info");
        kick(ctx);
        return;
      }
      if (sub === "clear") {
        pipe = null;
        pi.appendEntry(STATE_ENTRY_TYPE, { cleared: true });
        setStatus(ctx);
        ctx.ui.notify("Pipeline cleared.", "info");
        return;
      }

      // 새 파이프라인 시작
      const { objective, tokenBudget } = parseObjective(trimmed);
      if (!objective) {
        ctx.ui.notify("Usage: /superpi <objective>  [--budget N]", "warning");
        return;
      }
      pipe = {
        objective,
        phase: "SETUP",
        status: "pursuing",
        iteration: 0,
        tokenBudget,
        reviewHistory: [],
        createdAt: Date.now(),
      };
      persist();
      setStatus(ctx);
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. The pipeline will start once the current turn ends.", "info");
      } else {
        ctx.ui.notify(`🗂 Pipeline started (SETUP): ${objective}`, "info");
      }
      kick(ctx);
    },
    getArgumentCompletions: (prefix: string) => {
      const subs = ["pause", "resume", "clear", "status"];
      const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
  });

  // ── 세션 복원 ─────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    pipe = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as Record<string, unknown> | undefined;
        if (data && (data as { cleared?: boolean }).cleared) {
          pipe = null;
        } else if (data && typeof data.objective === "string") {
          pipe = data as unknown as PipelineState;
          if (!Array.isArray(pipe.reviewHistory)) pipe.reviewHistory = [];
        }
      }
    }
    // 복원 직후 자동 폭주 방지: 추적 중이었으면 paused 로 낮춘다.
    if (pipe && pipe.status === "pursuing") {
      pipe.status = "paused";
      pipe.note = "auto-paused on session restore — /superpi resume to continue";
    }
    setStatus(ctx);
    if (pipe && ctx.hasUI) {
      ctx.ui.notify(`Restored pipeline (${pipe.status}, phase ${pipe.phase}): ${pipe.objective}\n/superpi resume to continue.`, "info");
    }
  });
}

// subagents — 백그라운드 비동기 멀티 서브에이전트.
//
// 설계 원칙:
//   1. 항상 백그라운드 · 멀티. spawn_subagents({ tasks: [...] }) 는 자식 pi
//      프로세스들을 띄우고 "즉시" return 한다. 메인 에이전트는 블록되지 않는다.
//   2. 각 자식이 끝나면 그 "최종 출력만" 메인 에이전트에 주입한다(컨텍스트 절약).
//   3. 자식의 전체 트랜스크립트(thinking·툴호출 포함)는 세션에 custom 엔트리로
//      영속 저장된다. LLM 컨텍스트엔 절대 안 들어가고, 디스크(세션 jsonl)에만 남는다.
//   4. Ctrl+X 로 subagent view 오버레이를 띄워 과거 run 들을 조회한다. 세션에서
//      복원하므로 pi 를 껐다 켜도 같은 세션을 열면 계속 볼 수 있다(opencode 스타일).
//
// 자식 실행: pi --mode json -p --session-dir <격리> --session-id <runId>
//   (격리 세션으로 멀티턴 context 유지, 메인 /resume 목록은 오염 안 됨)

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, type Theme, getAgentDir, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { type Focusable, type TUI, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";

// ─── 상수 ────────────────────────────────────────────────────────────────

const MAX_TASKS = 8; // 한 번에 띄울 수 있는 최대 task 수
const RUN_ENTRY_TYPE = "subagent-run"; // 세션 custom 엔트리 타입 (전체 트랜스크립트)
const VIEW_SHORTCUT = "ctrl+\\"; // subagent view 오버레이. 내장 바인딩에 없어 충돌 없고, kitty 미지원 터미널(Zed 등)에서도 legacy 바이트(\x1c)로 들어온다.

// ─── 타입 ────────────────────────────────────────────────────────────────

interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

type RunStatus = "running" | "done" | "failed";

// 한 subagent 의 한 turn(= 프롬프트 1회 + 그에 대한 응답).
interface Turn {
  prompt: string; // 이 turn 에서 자식에게 보난 프롬프트
  transcript: TranscriptItem[]; // 이 turn 의 전체 트랜스크립트
  finalOutput: string; // 이 turn 의 최종 응답 텍스트
  startedAt: number;
  endedAt?: number;
  error?: string;
}

// 세션에 저장되는 한 subagent run 의 전체 기록.
interface SubagentRun {
  runId: string;
  batchId: string; // 같은 spawn_subagents 호출로 묶인 run 들의 공통 id
  agent: string;
  title: string; // 목록 표시용 제목 (메인이 spawn 시 필수 지정)
  task: string; // 최초 task (첫 turn 의 프롬프트)
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  model?: string;
  tools?: string[]; // follow-up 재실행 시 동일하게 적용
  agentSystemPrompt?: string; // follow-up 재실행 시 시스템 프롬프트 재구성용 (빈 문자열=없음)
  sessionDir: string; // ꈁ리된 세션 저장 디렉터리 (메인 /resume 에 안 섮임)
  sessionId: string; // pi --session-id 로 쓰는 고정 id (= runId)
  usage: RunUsage; // 누적 usage (모든 turn 합산)
  turns: Turn[]; // turn 히스토리
  // 편의: 현재(마지막) turn 의 트랜스크립트/최종출력 미러.
  transcript: TranscriptItem[];
  finalOutput: string;
  error?: string;
  // 메인 스레드가 아직 수령하지 않은 응답 turn 의 인덱스 목록.
  unreadTurns: number[];
}

interface TranscriptItem {
  kind: "thinking" | "text" | "toolCall" | "toolResult";
  text: string;
  toolName?: string;
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// 자식 subagent 세션을 보관하는 격리 디렉터리. 메인 cwd 기반 세션 폴더와 분리되어
// /resume 목록을 오염하지 않는다.
function subagentSessionRoot(): string {
  return path.join(getAgentDir(), ".subagent-sessions");
}

function emptyUsage(): RunUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// 자식 pi 를 어떻게 실행할지 결정 (예제의 getPiInvocation 과 동일 로직).
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `subagent-${agentName}-`));
  const filePath = path.join(dir, "system-prompt.md");
  await fs.promises.writeFile(filePath, prompt, "utf-8");
  return { dir, filePath };
}

// assistant 메시지 content 를 트랜스크립트 항목들로 평탄화.
export function flattenAssistant(msg: AssistantMessage): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const c of msg.content) {
    if (c.type === "thinking" && c.thinking?.trim()) items.push({ kind: "thinking", text: c.thinking });
    else if (c.type === "text" && c.text?.trim()) items.push({ kind: "text", text: c.text });
    else if (c.type === "toolCall")
      items.push({ kind: "toolCall", text: formatToolCallArgs(c.name, c.arguments ?? {}), toolName: c.name });
  }
  return items;
}

function formatToolCallArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const cmd = String(args.command ?? "...");
      return `$ ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
    }
    case "read": {
      const p = shortenPath(String(args.path ?? args.file_path ?? "..."));
      return `read ${p}`;
    }
    case "write":
      return `write ${shortenPath(String(args.path ?? args.file_path ?? "..."))}`;
    case "edit":
      return `edit ${shortenPath(String(args.path ?? args.file_path ?? "..."))}`;
    case "grep":
      return `grep /${String(args.pattern ?? "")}/ in ${shortenPath(String(args.path ?? "."))}`;
    case "find":
      return `find ${String(args.pattern ?? "*")} in ${shortenPath(String(args.path ?? "."))}`;
    case "ls":
      return `ls ${shortenPath(String(args.path ?? "."))}`;
    default: {
      const s = JSON.stringify(args);
      return `${toolName} ${s.length > 60 ? s.slice(0, 60) + "..." : s}`;
    }
  }
}

// 트랜스크립트에서 마지막 assistant text(= 최종 출력) 추출.
export function finalOutputFrom(transcript: TranscriptItem[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].kind === "text") return transcript[i].text;
  }
  return "";
}

// ─── 자식 spawn + 스트리밍 ─────────────────────────────────────────────────

// 자식 pi 를 띄워 한 turn 을 실행하고 JSON 이벤트를 파싱해 run/turn 을 갱신한다.
//
// 세션은 격리 디렉터리(run.sessionDir)에 run.sessionId 로 저장된다.
//   - 첫 turn: 새 세션 생성 (--session-id)
//   - follow-up: 같은 세션 이어서 실행 (이미 존재하므로 자동 이어짐)
// 이렇게 하면 이전 대화 context 가 요약 없이 그대로 유지된다.
//
// onProgress 는 turn 이 갱신될 때마다 호출된다. signal 로 메인 abort 시 자식도 죽인다.
export function runSubagentTurn(
  run: SubagentRun,
  prompt: string,
  systemPromptFile: string | null,
  cwd: string,
  signal: AbortSignal | undefined,
  onProgress: () => void,
): Promise<Turn> {
  // 이 turn 을 위한 새 Turn 을 만들고 run 에 붙인다.
  const turn: Turn = { prompt, transcript: [], finalOutput: "", startedAt: Date.now() };
  run.turns.push(turn);
  run.transcript = turn.transcript; // 현재 turn 미러
  run.finalOutput = "";
  run.status = "running";
  run.error = undefined;

  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    run.sessionDir,
    "--session-id",
    run.sessionId,
  ];
  if (run.model) args.push("--model", run.model);
  if (run.tools && run.tools.length > 0) args.push("--tools", run.tools.join(","));
  if (systemPromptFile) args.push("--append-system-prompt", systemPromptFile);
  args.push(prompt);

  return new Promise<Turn>((resolve) => {
    const invocation = getPiInvocation(args);
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      run.status = "failed";
      run.error = `spawn failed: ${(e as Error).message}`;
      turn.error = run.error;
      turn.endedAt = Date.now();
      run.endedAt = turn.endedAt;
      onProgress();
      resolve(turn);
      return;
    }

    let buffer = "";
    let stderr = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: { type?: string; message?: Message };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "message_end" && event.message) {
        const msg = event.message;
        if (msg.role === "assistant") {
          const am = msg as AssistantMessage;
          turn.transcript.push(...flattenAssistant(am));
          run.usage.turns++;
          const u = am.usage;
          if (u) {
            run.usage.input += u.input || 0;
            run.usage.output += u.output || 0;
            run.usage.cacheRead += u.cacheRead || 0;
            run.usage.cacheWrite += u.cacheWrite || 0;
            run.usage.cost += u.cost?.total || 0;
            run.usage.contextTokens = u.totalTokens || run.usage.contextTokens;
          }
          if (!run.model && am.model) run.model = am.model;
          if (am.errorMessage) {
            run.error = am.errorMessage;
            turn.error = am.errorMessage;
          }
        } else if (msg.role === "toolResult") {
          const tr = msg as Extract<Message, { role: "toolResult" }>;
          const text = tr.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("")
            .trim();
          turn.transcript.push({
            kind: "toolResult",
            text: text.length > 500 ? text.slice(0, 500) + "…" : text,
            toolName: tr.toolName,
          });
        }
        run.finalOutput = finalOutputFrom(turn.transcript);
        onProgress();
      }
    };

    proc.stdout?.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      turn.endedAt = Date.now();
      run.endedAt = turn.endedAt;
      turn.finalOutput = finalOutputFrom(turn.transcript);
      run.finalOutput = turn.finalOutput;
      if (code === 0 || turn.finalOutput) {
        run.status = "done";
      } else {
        run.status = "failed";
        if (!run.error) run.error = stderr.trim().slice(-500) || `exited with code ${code}`;
        if (!turn.error) turn.error = run.error;
      }
      onProgress();
      resolve(turn);
    });
    proc.on("error", (e) => {
      run.status = "failed";
      run.error = e.message;
      turn.error = e.message;
      turn.endedAt = Date.now();
      run.endedAt = turn.endedAt;
      onProgress();
      resolve(turn);
    });

    if (signal) {
      const kill = () => {
        run.status = "failed";
        run.error = "aborted";
        turn.error = "aborted";
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 3000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

// ─── Extension ─────────────────────────────────────────────────────────────

const SubagentParams = Type.Object({
  tasks: Type.Array(
    Type.Object({
      agent: Type.Optional(
        Type.String({
          description:
            "Agent name (from discovered agents). Optional — omit to run a bare subagent with no preset system prompt and full tool access, controlled only by `model`.",
        }),
      ),
      task: Type.String({ description: "The task/instruction for this subagent." }),
      title: Type.String({
        description: "Short, descriptive title for this subagent run, shown in the run list. Required.",
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Model override (e.g. "relay/claude-opus-4.8"). Use "current" to run the subagent on the parent\'s current model. Overrides the agent\'s default model when both are given. Required when no agent is specified.',
        }),
      ),
    }),
    { description: "One or more subagent tasks to run concurrently in the background.", minItems: 1 },
  ),
  agentScope: Type.Optional(
    Type.Unsafe<AgentScope>({ type: "string", enum: ["user", "project", "both"], default: "user" }),
  ),
});

export default function (pi: ExtensionAPI) {
  // 메모리상의 진행 중/완료 run 들. 세션 복원 시 디스크에서 채운다.
  const runs = new Map<string, SubagentRun>();
  let renderViewer: (() => void) | undefined; // 열린 뷰어가 있으면 갱신용

  // 진행 표시 widget 갱신
  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const all = [...runs.values()];
    const running = all.filter((r) => r.status === "running").length;
    // run 이 하나라도 있으면 뷰어 단축키 hint 를 footer 에 노출한다.
    const viewHint = all.length > 0 ? rawKeyHint(VIEW_SHORTCUT, "view subagents") : "";
    if (running > 0) {
      const label = ctx.ui.theme.fg("dim", `🤖 ${running} subagent${running > 1 ? "s" : ""} running`);
      ctx.ui.setStatus("subagents", viewHint ? `${label} ${viewHint}` : label);
    } else if (all.length > 0) {
      ctx.ui.setStatus("subagents", viewHint);
    } else {
      ctx.ui.setStatus("subagents", undefined);
    }
  };

  // run 을 세션에 영속(custom 엔트리 = LLM 컨텍스트 불참). 상태 바뀔 때마다 덮어쓴다.
  const persistRun = (run: SubagentRun) => {
    pi.appendEntry(RUN_ENTRY_TYPE, run as unknown as Record<string, unknown>);
  };

  // 한 turn 을 실행한다(최초 task 또는 follow-up 공통). 완료되면 미수령 turn 으로
  // 표시하고, 메인 에이전트에 "수령하라"는 짧은 알림만 보낸다(전문 주입 X).
  const executeTurn = async (run: SubagentRun, prompt: string, ctx: ExtensionContext) => {
    let promptFile: string | null = null;
    let tmpDir: string | null = null;
    try {
      if (run.agentSystemPrompt && run.agentSystemPrompt.trim()) {
        const tmp = await writePromptToTempFile(run.agent, run.agentSystemPrompt);
        promptFile = tmp.filePath;
        tmpDir = tmp.dir;
      }
      await runSubagentTurn(run, prompt, promptFile, ctx.cwd, undefined, () => {
        persistRun(run);
        updateWidget(ctx);
        renderViewer?.();
      });
    } finally {
      if (tmpDir) fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    // 방금 끝난 turn 인덱스를 미수령 목록에 추가.
    const turnIndex = run.turns.length - 1;
    if (!run.unreadTurns.includes(turnIndex)) run.unreadTurns.push(turnIndex);
    persistRun(run);

    // 전문 대신 "수령하라"는 알림만 보낸다.
    const status = run.status === "done" ? "finished" : "failed";
    const note =
      run.status === "done"
        ? `Subagent "${run.title}" (id: ${run.runId}) ${status}. ${run.unreadTurns.length} unread response(s). ` +
          `Call fetch_subagent_result with subagentId "${run.runId}" to read the output, ` +
          `or send_to_subagent to continue the conversation.`
        : `Subagent "${run.title}" (id: ${run.runId}) ${status}: ${run.error || "unknown error"}. ` +
          `Call fetch_subagent_result with subagentId "${run.runId}" for details.`;
    pi.sendUserMessage(`[subagent ${run.runId} ${status}] ${note}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    updateWidget(ctx);
  };

  // ── 도구: spawn_subagents (백그라운드 멀티, 즉시 return) ──────────────────
  pi.registerTool({
    name: "spawn_subagents",
    label: "Spawn Subagents",
    description: [
      "Spawn one or more subagents that run CONCURRENTLY IN THE BACKGROUND.",
      "Returns immediately — you are NOT blocked and should continue working.",
      "Each subagent runs in an isolated context and keeps its own session, so you can continue the conversation later.",
      "When a subagent finishes you receive a SHORT notification with its id — not the full output.",
      "Call fetch_subagent_result with that id to read the response, and send_to_subagent to ask it follow-up questions.",
      "Use list_subagents to see all runs and which have unread responses.",
      "Each task may name an `agent` (a discovered preset with its own system prompt, tools, and default model),",
      "and/or set a `model` override. Omit `agent` to run a bare subagent with full tool access controlled only by `model`.",
      'Set `model` to "current" to reuse the parent\'s current model. `title` is a required short label for the run list.',
      "Use this to parallelize independent investigation or work.",
    ].join(" "),
    promptSnippet: "Run subagents concurrently in the background; fetch results by id when notified",
    promptGuidelines: [
      "Use spawn_subagents to delegate independent tasks that can run in parallel without blocking you.",
      "Pick a specialized agent when one fits; otherwise omit agent and just set a model (use 'current' to match yourself).",
      "After spawning, keep working. When you get a '[subagent <id> finished]' notification, call fetch_subagent_result with that id to read the output.",
      "To ask a subagent a follow-up, call send_to_subagent with its id — the subagent keeps full context of its prior turns.",
    ],
    parameters: SubagentParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = (params.agentScope ?? "user") as AgentScope;
      const { agents } = discoverAgents(ctx.cwd, scope);
      const byName = new Map(agents.map((a) => [a.name, a]));

      // 부모의 현재 모델 ("current" 별칭 해석용).
      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      const tasks = params.tasks.slice(0, MAX_TASKS);
      const batchId = newId();
      const accepted: string[] = [];
      const unknownAgents: string[] = [];
      const errors: string[] = [];

      for (const t of tasks) {
        // agent 는 선택. 지정했는데 못 찾으면 무시 목록에 넣는다.
        const agent = t.agent ? byName.get(t.agent) : undefined;
        if (t.agent && !agent) {
          unknownAgents.push(t.agent);
          continue;
        }

        // 모델 결정: task.model 이 agent 기본값을 덮어쓴다. "current" 는 부모 모델로.
        let model: string | undefined;
        if (t.model) {
          model = t.model === "current" ? currentModel : t.model;
          if (t.model === "current" && !currentModel) {
            errors.push(`task with model "current" skipped: no current model available.`);
            continue;
          }
        } else {
          model = agent?.model;
        }

        // agent 도 없고 모델도 못 정하면 실행 불가.
        if (!agent && !model) {
          errors.push(`task skipped: specify an agent or a model (no default available).`);
          continue;
        }

        const label = agent?.name ?? `model:${model}`;
        const runId = newId();
        const title = t.title.trim() || t.task.slice(0, 60);
        const run: SubagentRun = {
          runId,
          batchId,
          agent: label,
          title,
          task: t.task,
          status: "running",
          startedAt: Date.now(),
          model,
          tools: agent?.tools,
          agentSystemPrompt: agent?.systemPrompt,
          sessionDir: path.join(subagentSessionRoot(), runId),
          sessionId: runId,
          usage: emptyUsage(),
          turns: [],
          transcript: [],
          finalOutput: "",
          unreadTurns: [],
        };
        runs.set(run.runId, run);
        persistRun(run);
        accepted.push(`${title} (${runId})`);

        // 백그라운드 실행 — await 하지 않는다.
        void executeTurn(run, `Task: ${t.task}`, ctx);
      }

      updateWidget(ctx);

      const lines: string[] = [];
      if (accepted.length > 0) {
        lines.push(
          `Started ${accepted.length} subagent(s) in the background: ${accepted.join(", ")}.`,
          `They run concurrently. You are NOT blocked — keep working.`,
          `When each finishes you'll get a '[subagent <id> finished]' notification; call fetch_subagent_result with that id to read the output.`,
        );
      }
      if (unknownAgents.length > 0) {
        const { text } = formatAgentList(agents, 12);
        lines.push(`Unknown agent(s) ignored: ${unknownAgents.join(", ")}. Available: ${text}`);
      }
      if (errors.length > 0) {
        lines.push(...errors);
      }
      if (accepted.length === 0) {
        lines.push(`No subagents started.`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { batchId, started: accepted, unknownAgents, errors },
      };
    },
  });

  // ── 도구: list_subagents (모든 run 과 미수령 상태) ──────────────────
  pi.registerTool({
    name: "list_subagents",
    label: "List Subagents",
    description:
      "List all subagent runs in this session with their id, title, status, turn count, and how many responses are unread. " +
      "Use this to find a subagent's id before calling fetch_subagent_result or send_to_subagent.",
    promptSnippet: "List subagent runs and their unread status",
    parameters: Type.Object({}),
    async execute() {
      const all = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
      if (all.length === 0) {
        return { content: [{ type: "text", text: "No subagents in this session yet." }] };
      }
      const lines = all.map((r) => {
        const unread = r.unreadTurns.length > 0 ? ` · ${r.unreadTurns.length} unread` : "";
        return `${statusIcon[r.status]} ${r.runId}  "${r.title}"  [${r.agent}${r.model ? ", " + r.model : ""}]  ${r.turns.length} turn(s)${unread}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: { count: all.length } };
    },
  });

  // ── 도구: fetch_subagent_result (id 로 미수령 응답 수령) ───────────────
  pi.registerTool({
    name: "fetch_subagent_result",
    label: "Fetch Subagent Result",
    description:
      "Fetch the response(s) from a subagent by its id. By default returns only UNREAD responses and marks them read. " +
      "Set all=true to return every turn's output regardless of read state. Use the id from the '[subagent <id> finished]' notification or list_subagents.",
    promptSnippet: "Fetch a subagent's unread response by id",
    parameters: Type.Object({
      subagentId: Type.String({ description: "The subagent run id (e.g. from the finished notification)." }),
      all: Type.Optional(
        Type.Boolean({ description: "If true, return all turns, not just unread ones. Default false." }),
      ),
    }),
    async execute(_id, params) {
      const run = runs.get(params.subagentId);
      if (!run) {
        return {
          content: [{ type: "text", text: `No subagent found with id "${params.subagentId}". Use list_subagents to see ids.` }],
          details: { found: false },
        };
      }
      const wantAll = params.all === true;
      const indices = wantAll ? run.turns.map((_, i) => i) : [...run.unreadTurns].sort((a, b) => a - b);
      if (indices.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                run.status === "running"
                  ? `Subagent "${run.title}" (${run.runId}) is still running. No completed response yet.`
                  : `No unread responses for "${run.title}" (${run.runId}). Use all=true to re-read past turns.`,
            },
          ],
          details: { found: true, status: run.status, unread: 0 },
        };
      }
      const parts: string[] = [];
      parts.push(`Subagent "${run.title}" (id: ${run.runId}) — status: ${run.status}`);
      for (const i of indices) {
        const turn = run.turns[i];
        if (!turn) continue;
        parts.push(`\n── turn ${i + 1} ──`);
        parts.push(`Prompt: ${turn.prompt}`);
        if (turn.error) parts.push(`Error: ${turn.error}`);
        parts.push(turn.finalOutput || "(no output)");
      }
      // 수령 처리: 읽은 turn 을 미수령 목록에서 제거.
      if (!wantAll) {
        run.unreadTurns = run.unreadTurns.filter((i) => !indices.includes(i));
        persistRun(run);
      }
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: { found: true, status: run.status, returned: indices.length, remainingUnread: run.unreadTurns.length },
      };
    },
  });

  // ── 도구: send_to_subagent (id 로 추가 프롬프트, 세션 이어서) ─────────
  pi.registerTool({
    name: "send_to_subagent",
    label: "Send To Subagent",
    description:
      "Send a follow-up message to an existing subagent by its id. The subagent resumes its OWN session, so it keeps full context of all prior turns. " +
      "Runs in the background like spawn_subagents; when it finishes you get a '[subagent <id> finished]' notification, then call fetch_subagent_result. " +
      "The subagent must not be currently running.",
    promptSnippet: "Send a follow-up prompt to an existing subagent by id",
    promptGuidelines: [
      "Use send_to_subagent to continue a conversation with a subagent that already ran — it remembers its prior turns.",
    ],
    parameters: Type.Object({
      subagentId: Type.String({ description: "The subagent run id to continue." }),
      message: Type.String({ description: "The follow-up prompt/instruction for the subagent." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const run = runs.get(params.subagentId);
      if (!run) {
        return {
          content: [{ type: "text", text: `No subagent found with id "${params.subagentId}". Use list_subagents to see ids.` }],
          details: { found: false },
        };
      }
      if (run.status === "running") {
        return {
          content: [{ type: "text", text: `Subagent "${run.title}" (${run.runId}) is still running. Wait for it to finish before sending a follow-up.` }],
          details: { found: true, running: true },
        };
      }
      // 백그라운드 재실행 — 같은 세션을 이어간다.
      void executeTurn(run, params.message, ctx);
      updateWidget(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Sent follow-up to "${run.title}" (${run.runId}). It's running in the background; you'll get a '[subagent ${run.runId} finished]' notification when done.`,
          },
        ],
        details: { found: true, subagentId: run.runId },
      };
    },
  });

  // ── 뷰어 오버레이 (Ctrl+X) ───────────────────────────────────────────────
  pi.registerShortcut(VIEW_SHORTCUT, {
    description: "Open subagent view (browse subagent runs & transcripts)",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const list = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
      if (list.length === 0) {
        ctx.ui.notify("No subagent runs in this session.", "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const view = new SubagentViewer(list, theme, tui, done);
          renderViewer = () => tui.requestRender();
          return view;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "top-left",
          },
        },
      );
      renderViewer = undefined;
    },
  });

  // ── 세션 복원: 디스크의 subagent-run 엔트리를 메모리로 ──────────────────────
  pi.on("session_start", async (_event, ctx) => {
    runs.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE) {
        const data = entry.data as SubagentRun | undefined;
        if (data && typeof data.runId === "string") {
          // 같은 runId 의 최신 스냅샷이 뒤에 오므로 덮어쓴다.
          // 복원 시점에 still "running" 이던 것은 죽은 프로세스이므로 failed 로 표시.
          const restored: SubagentRun = { ...data };
          // 구 스냅샷 호환: 새 필드 백필.
          restored.turns = Array.isArray(restored.turns) ? restored.turns : [];
          restored.unreadTurns = Array.isArray(restored.unreadTurns) ? restored.unreadTurns : [];
          restored.transcript = Array.isArray(restored.transcript) ? restored.transcript : [];
          restored.title = restored.title || restored.task || restored.agent || restored.runId;
          if (restored.status === "running") {
            restored.status = "failed";
            restored.error = restored.error ?? "interrupted (session restored)";
          }
          runs.set(restored.runId, restored);
        }
      }
    }
    updateWidget(ctx);
  });
}

// ─── 뷰어 컴포넌트 ───────────────────────────────────────────────────────────

const statusIcon: Record<RunStatus, string> = { running: "⏳", done: "✅", failed: "❌" };

const kindLabel: Record<TranscriptItem["kind"], string> = {
  thinking: "💭 thinking",
  text: "💬 text",
  toolCall: "🔧 tool",
  toolResult: "↩ result",
};

class SubagentViewer implements Focusable {
  focused = false;
  private mode: "list" | "detail" = "list";
  private selected = 0;
  private scroll = 0; // detail 늨 스크롤
  private listScroll = 0; // list 모드 스크롤 (선택 따라감)

  constructor(
    private runs: SubagentRun[],
    private theme: Theme,
    private tui: TUI,
    private done: (r: void) => void,
  ) {}

  // 터미널 높이 (오버레이가 풀스크린이므로 전체 rows 사용, 약간의 여유만 남김).
  private get rows(): number {
    return Math.max(8, (this.tui.terminal.rows || 30) - 1);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, VIEW_SHORTCUT)) {
      if (this.mode === "detail") {
        this.mode = "list";
        this.scroll = 0;
      } else {
        this.done();
      }
      return;
    }
    if (this.mode === "list") {
      if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, "down")) this.selected = Math.min(this.runs.length - 1, this.selected + 1);
      else if (matchesKey(data, "pageUp")) this.selected = Math.max(0, this.selected - 10);
      else if (matchesKey(data, "pageDown")) this.selected = Math.min(this.runs.length - 1, this.selected + 10);
      else if (matchesKey(data, "return")) {
        this.mode = "detail";
        this.scroll = 0;
      }
    } else {
      if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, "down")) this.scroll += 1;
      else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 10);
      else if (matchesKey(data, "pageDown")) this.scroll += 10;
    }
  }

  private renderList(innerW: number): string[] {
    const th = this.theme;
    const rows = this.rows;
    const header = [
      th.fg("accent", " 🤖 Subagent runs") + th.fg("dim", `  (${this.runs.length})`),
      "",
    ];
    const footer = th.fg("dim", ` ↑↓ select · PgUp/PgDn · Enter open · Esc/${formatKeyLabel(VIEW_SHORTCUT)} close`);
    const viewport = Math.max(2, rows - header.length - 1); // 1 = footer

    // 각 run 은 2줄(제목 + 메타). 선택 항목이 뷰포트 안에 들어오도록 스크롤 행을 맞춘다.
    const rowsPerItem = 2;
    const itemsVisible = Math.max(1, Math.floor(viewport / rowsPerItem));
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    else if (this.selected >= this.listScroll + itemsVisible) this.listScroll = this.selected - itemsVisible + 1;
    const maxListScroll = Math.max(0, this.runs.length - itemsVisible);
    if (this.listScroll > maxListScroll) this.listScroll = maxListScroll;

    const body: string[] = [];
    const end = Math.min(this.runs.length, this.listScroll + itemsVisible);
    for (let i = this.listScroll; i < end; i++) {
      const r = this.runs[i];
      const sel = i === this.selected;
      const prefix = sel ? th.fg("accent", " ▶ ") : "   ";
      const dur = r.endedAt ? `${Math.round((r.endedAt - r.startedAt) / 1000)}s` : "...";
      const stats = `${r.usage.turns}t ${formatTokens(r.usage.input + r.usage.output)}tok $${r.usage.cost.toFixed(3)}`;
      const unread = r.unreadTurns.length > 0 ? th.fg("accent", ` ●${r.unreadTurns.length}`) : "";
      // 제목을 먼저 크게, 그 다음줄에 agent/메타.
      const titleMax = Math.max(12, innerW - 12);
      const title = r.title.length > titleMax ? r.title.slice(0, titleMax) + "…" : r.title;
      const head = `${statusIcon[r.status]} ${title}`;
      body.push(`${prefix}${sel ? th.fg("text", head) : th.fg("muted", head)}${unread}`);
      body.push(
        "   " +
          th.fg("dim", `${r.agent} · ${dur} · ${stats}${r.model ? " · " + r.model : ""}`),
      );
    }

    const lines = [...header, ...body];
    // 풀스크린을 채우도록 footer 앞에 빈 줄 패딩.
    while (lines.length < rows - 1) lines.push("");
    lines.push(footer);
    return lines.map((l) => truncateToWidth(" " + l, innerW + 2));
  }

  private renderDetail(innerW: number): string[] {
    const th = this.theme;
    const rows = this.rows;
    const r = this.runs[this.selected];
    const head: string[] = [];
    head.push(th.fg("accent", ` ${statusIcon[r.status]} ${r.title}`) + th.fg("dim", `  (${r.runId} · ${r.agent})`));
    if (r.error) head.push(th.fg("error", ` Error: ${r.error}`));
    head.push(th.fg("dim", " " + "─".repeat(Math.max(4, innerW - 2))));

    // 모든 turn 을 순회해 프롬프트 + 트랜스크립트를 보여준다.
    const body: string[] = [];
    const turns = r.turns.length > 0 ? r.turns : [{ prompt: r.task, transcript: r.transcript, finalOutput: r.finalOutput, startedAt: r.startedAt } as Turn];
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti];
      if (turns.length > 1 || ti > 0) {
        body.push(th.fg("accent", `  ▸ turn ${ti + 1}`));
      }
      body.push(th.fg("dim", `  📤 prompt`));
      for (const raw of turn.prompt.split("\n")) {
        for (const w of wrapTextWithAnsi(raw, innerW - 4)) body.push("    " + th.fg("muted", w));
      }
      for (const item of turn.transcript) {
        const label = kindLabel[item.kind];
        const color =
          item.kind === "thinking" ? "dim" : item.kind === "toolCall" ? "accent" : item.kind === "toolResult" ? "muted" : "text";
        body.push(th.fg("dim", `  ${label}${item.toolName ? " " + item.toolName : ""}`));
        for (const raw of item.text.split("\n")) {
          for (const w of wrapTextWithAnsi(raw, innerW - 4)) body.push("    " + th.fg(color as never, w));
        }
      }
    }
    if (body.length === 0) body.push(th.fg("dim", "  (no transcript yet)"));

    // 스크롤 적용 (header + footer 1줄 제외).
    const viewport = Math.max(2, rows - head.length - 1);
    const maxScroll = Math.max(0, body.length - viewport);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const slice = body.slice(this.scroll, this.scroll + viewport);

    const footer = th.fg(
      "dim",
      ` ↑↓/PgUp/PgDn scroll · Esc back  [${body.length === 0 ? 0 : this.scroll + 1}-${this.scroll + slice.length}/${body.length}]`,
    );
    const lines = [...head, ...slice];
    while (lines.length < rows - 1) lines.push("");
    lines.push(footer);
    return lines.map((l) => truncateToWidth(" " + l, innerW + 2));
  }

  render(width: number): string[] {
    const innerW = width - 2;
    return this.mode === "list" ? this.renderList(innerW) : this.renderDetail(innerW);
  }

  invalidate(): void {}
  dispose(): void {}
}

// VIEW_SHORTCUT 같은 raw 키를 사람이 읽기 좋게 (ctrl+\ → Ctrl+\).
function formatKeyLabel(key: string): string {
  return key
    .split("+")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("+");
}

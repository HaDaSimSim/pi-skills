// subagents — 백그라운드 비동기 멀티 서브에이전트.
//
// 설계 원칙:
//   1. 항상 백그라운드 · 멀티. spawn_subagents({ tasks: [...] }) 는 자식 pi
//      프로세스들을 띄우고 "즉시" return 한다. 메인 에이전트는 블록되지 않는다.
//   2. 각 자식이 끝나면 그 "최종 출력만" 메인 에이전트에 주입한다(컨텍스트 절약).
//   3. 자식의 전체 트랜스크립트(thinking·툴호출 포함)는 세션에 custom 엔트리로
//      영속 저장된다. LLM 컨텍스트엔 절대 안 들어가고, 디스크(세션 jsonl)에만 남는다.
//   4. Ctrl+\ 로 subagent view 오버레이를 띄워 과거 run 들을 조회한다. 세션에서
//      복원하므로 pi 를 껐다 켜도 같은 세션을 열면 계속 볼 수 있다(opencode 스타일).
//      ↑↓ / j k / space·b / g·G 키로 스크롤(터미널 마우스 전달에 의존하지 않는다). 트랜스크립트 텍스트는 렌더 전 TAB/제어문자를
//      제거해 pi-tui 폭 계산 불일치로 인한 렌더 크래시를 막는다(sanitizeForRender).
//   5. 진행 중인 자식은 send_to_subagent 로 follow-up 을 큐잉(steering)하고,
//      abort_subagent 로 중단할 수 있다. 완료·실패·중단은 모두 메인에게 메시지로 알림이
//      가므로, 메인은 sleep/폴링 없이 그냥 일을 이어가거나 멈춰 있으면 된다.
//
// 자식 실행: pi --mode json -p --session-dir <격리> --session-id <runId>
//   (격리 세션으로 멀티턴 context 유지, 메인 /resume 목록은 오염 안 됨)

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  rawKeyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Focusable,
  matchesKey,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import { isTransientError } from "./transient.ts";

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
  tools?: string[]; // follow-up 재실행 시 동일하게 적용 (--tools allowlist)
  excludeTools?: string[]; // 차단할 도구 (--exclude-tools denylist). spawn 시 task별 지정.
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

// 터미널 렌더용 텍스트 정화. 리터럴 TAB 과 그 외 C0 제어문자는 pi-tui 의 폭 계산
// (visibleWidth 는 TAB=3 으로 세지만 compositor 의 sliceByColumn 은 그대로 흘려보내
// 폭이 어긋난다)을 깨뜨려 "Rendered line exceeds terminal width" 크래시를 유발한다.
// 표시 전에 TAB→공백 확장, 그 외 제어문자는 제거해 두 계산이 항상 일치하게 만든다.
// 캡처 시점에 적용하므로 세션에 영속되는 데이터도 깨끗하다.
export function sanitizeForRender(text: string): string {
  if (!text) return text;
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") {
      // 탭을 다음 4칸 경계까지 공백으로 확장.
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else if (ch === "\n") {
      out += ch;
      col = 0;
    } else {
      const code = ch.codePointAt(0) ?? 0;
      // C0 제어문자(\n 제외)와 DEL 제거. 그 외는 보존(폭 계산은 pi-tui 에 위임).
      if ((code >= 0x00 && code < 0x20) || code === 0x7f) continue;
      out += ch;
      col += 1;
    }
  }
  return out;
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
  // pi-gui/pi-web 호스트에서는 process.argv[1] 이 pi CLI 가 아니라 백엔드
  // 진입점(server/index.ts)이다. 그걸 그대로 실행하면 자식이 또 백엔드를
  // 띄우려다 포트(4317) 충돌(EADDRINUSE)로 죽는다. 이 호스트에서는 실제 pi 를 쓴다.
  if (process.env.PI_WEB_HOST) {
    return { command: "pi", args };
  }
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

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `subagent-${agentName}-`));
  const filePath = path.join(dir, "system-prompt.md");
  await fs.promises.writeFile(filePath, prompt, "utf-8");
  return { dir, filePath };
}

// assistant 메시지 content 를 트랜스크립트 항목들로 평탄화.
export function flattenAssistant(msg: AssistantMessage): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const c of msg.content) {
    if (c.type === "thinking" && c.thinking?.trim())
      items.push({ kind: "thinking", text: sanitizeForRender(c.thinking) });
    else if (c.type === "text" && c.text?.trim())
      items.push({ kind: "text", text: sanitizeForRender(c.text) });
    else if (c.type === "toolCall")
      items.push({
        kind: "toolCall",
        text: sanitizeForRender(formatToolCallArgs(c.name, c.arguments ?? {})),
        toolName: c.name,
      });
  }
  return items;
}

function formatToolCallArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const cmd = String(args.command ?? "...");
      return `$ ${cmd.length > 80 ? `${cmd.slice(0, 80)}...` : cmd}`;
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
      return `${toolName} ${s.length > 60 ? `${s.slice(0, 60)}...` : s}`;
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
  if (run.excludeTools && run.excludeTools.length > 0)
    args.push("--exclude-tools", run.excludeTools.join(","));
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
        // 자식 subagent 프로세스임을 마킹. 자식 pi 안에서도 로드되는 다른 익스텐션
        // (예: telegram)이 자식의 agent_end 에 반응해 이중 알림을 보내는 걸 막는다.
        // PI_WEB_HOST 는 제거: 자식은 진짜 pi CLI 이지 pi-gui 호스트가 아니다.
        env: (() => {
          const e: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT: "1" };
          delete e.PI_WEB_HOST;
          return e;
        })(),
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
            text: sanitizeForRender(text.length > 500 ? `${text.slice(0, 500)}…` : text),
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
      if (signal?.aborted) {
        // 명시적 abort: 부분 출력이 있어도 done 으로 됕지 않는다(상태 결정적).
        run.status = "failed";
        run.error = "aborted";
        turn.error = "aborted";
      } else if (code === 0 || turn.finalOutput) {
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
        description:
          "Short, descriptive title for this subagent run, shown in the run list. Required.",
      }),
      excludeTools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Optional denylist of tool names to disable for this subagent (e.g. ["edit", "write"] for a read-only reviewer). Applied on top of the agent\'s own tool config. Use this to spawn a subagent that can investigate but not modify files.',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            'Model override (e.g. "relay/claude-opus-4.8"). Use "current" to run the subagent on the parent\'s current model. Overrides the agent\'s default model when both are given. Required when no agent is specified.',
        }),
      ),
    }),
    {
      description: "One or more subagent tasks to run concurrently in the background.",
      minItems: 1,
    },
  ),
  agentScope: Type.Optional(
    Type.Unsafe<AgentScope>({ type: "string", enum: ["user", "project", "both"], default: "user" }),
  ),
});

export default function (pi: ExtensionAPI) {
  // 자식 subagent 안에서는 subagent 도구를 일절 등록하지 않는다.
  // spawn 시 env 에 PI_SUBAGENT=1 이 박히므로(아래 runSubagentTurn 참고),
  // 자식 pi 가 또 spawn_subagents 를 호출해 손주 subagent 를 띄우는 무한 재귀를
  // 코드 레벨에서 차단한다. 자식은 자기만의 격리 세션이라 다룰 run 도 없어서
  // list/fetch/send/abort 도 전부 무의미 — 통째로 건너뛴다.
  if (process.env.PI_SUBAGENT === "1") return;

  // 메모리상의 진행 중/완료 run 들. 세션 복원 시 디스크에서 채운다.
  const runs = new Map<string, SubagentRun>();
  // 진행 중인 run 의 AbortController. abort_subagent 가 이걸 불러 자식을 죽인다.
  const controllers = new Map<string, AbortController>();
  // 진행 중인 run 에 대기 중인 follow-up 프롬프트 큐(steering). 현재 turn 이 끝나면 순서대로 소비.
  const pendingFollowUps = new Map<string, string[]>();
  // steer 요청: 현재 turn 을 abort 하고 그 즉시 이 메시지로 새 turn 을 시작한다.
  // abort 후 executeTurn 의 완료 콜백에서 소비된다(pendingFollowUps 보다 우선).
  const steerRequests = new Map<string, string>();
  let renderViewer: (() => void) | undefined; // 열린 뷰어가 있으면 갱신용

  // 진행 표시 widget 갱신
  const updateWidget = (ctx: ExtensionContext) => {
    const all = [...runs.values()];
    const running = all.filter((r) => r.status === "running").length;
    // 다른 extension(특히 goal 루프)이 "백그라운드 subagent 가 도는 동안
    // continuation 을 보류"할 수 있도록 진행 중 개수를 공유 버스에 흘린다.
    // UI 유무와 무관하게 항상 emit 한다 (print 모드 자식엔 PI_SUBAGENT 가드로 미도달).
    try {
      pi.events.emit("subagents:running", { running });
    } catch {
      /* 버스 미초기화 단계: 무시 */
    }
    if (!ctx.hasUI) return;
    // run 이 하나라도 있으면 뷰어 단축키 hint 를 footer 에 노출한다.
    // rawKeyHint / ctx.ui.theme 는 TUI theme(initTheme) 에 의존한다. pi-web 같은
    // 비-TUI 호스트는 hasUI=true 여도 theme 가 없어 throw 하므로 전체를 방어한다.
    try {
      const viewHint = all.length > 0 ? rawKeyHint(VIEW_SHORTCUT, "view subagents") : "";
      if (running > 0) {
        const label = ctx.ui.theme.fg(
          "dim",
          `🤖 ${running} subagent${running > 1 ? "s" : ""} running`,
        );
        ctx.ui.setStatus("subagents", viewHint ? `${label} ${viewHint}` : label);
      } else if (all.length > 0) {
        ctx.ui.setStatus("subagents", viewHint);
      } else {
        ctx.ui.setStatus("subagents", undefined);
      }
    } catch {
      /* 비-TUI 호스트(theme 미초기화): widget 갱신은 조용히 건너뛴다. */
    }
  };

  // run 을 세션에 영속(custom 엔트리 = LLM 컨텍스트 불참). 상태 바뀔 때마다 덮어쓴다.
  const persistRun = (run: SubagentRun) => {
    pi.appendEntry(RUN_ENTRY_TYPE, run as unknown as Record<string, unknown>);
  };

  // 한 turn 을 실행한다(최초 task 또는 follow-up 공통). 완료되면 미수령 turn 으로
  // 표시하고, 메인 에이전트에 "수령하라"는 짧은 알림만 보낸다(전문 주입 X).
  const executeTurn = async (run: SubagentRun, prompt: string, ctx: ExtensionContext) => {
    const controller = new AbortController();
    controllers.set(run.runId, controller);
    let promptFile: string | null = null;
    let tmpDir: string | null = null;
    try {
      if (run.agentSystemPrompt?.trim()) {
        const tmp = await writePromptToTempFile(run.agent, run.agentSystemPrompt);
        promptFile = tmp.filePath;
        tmpDir = tmp.dir;
      }
      // transient retry: 자식이 일시적 실패(rate limit/네트워크 깜빡)로 끝나면 같은
      // 모델로 짧은 backoff 후 재시도한다. 모델 정체성은 유지(fallback 아님).
      // abort 나 비-일시적 오류(잘못된 인자 등)는 재시도하지 않는다.
      const MAX_RETRIES = 2;
      for (let attempt = 0; ; attempt++) {
        await runSubagentTurn(run, prompt, promptFile, ctx.cwd, controller.signal, () => {
          persistRun(run);
          updateWidget(ctx);
          renderViewer?.();
        });
        if (
          run.status === "failed" &&
          !controller.signal.aborted &&
          attempt < MAX_RETRIES &&
          isTransientError(run.error)
        ) {
          const backoffMs = 1000 * (attempt + 1);
          const prevErr = run.error ?? "";
          // 실패한 turn 을 transcript 에서 제거(재시도가 새 turn 을 push 하므로 누적 방지).
          run.turns.pop();
          run.error =
            `transient failure (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${backoffMs}ms: ${prevErr}`.slice(
              0,
              500,
            );
          persistRun(run);
          updateWidget(ctx);
          await new Promise((r) => setTimeout(r, backoffMs));
          if (controller.signal.aborted) break;
          continue;
        }
        break;
      }
    } finally {
      if (tmpDir) fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      controllers.delete(run.runId);
    }

    const aborted = controller.signal.aborted;

    // 방금 끝난 turn 인덱스를 미수령 목록에 추가.
    const turnIndex = run.turns.length - 1;
    if (!run.unreadTurns.includes(turnIndex)) run.unreadTurns.push(turnIndex);
    persistRun(run);

    // steer 요청으로 abort 된 경우: 중단된 큐는 버리고, 그 즉시 새 메시지로 이어 돌린다.
    // (중단 알림은 보내지 않고, 새 turn 의 완료 알림만 간다.)
    const steerMsg = steerRequests.get(run.runId);
    if (aborted && steerMsg !== undefined) {
      steerRequests.delete(run.runId);
      pendingFollowUps.delete(run.runId);
      void executeTurn(run, steerMsg, ctx);
      updateWidget(ctx);
      return;
    }
    // steer 가 아닌 그냥 abort 이면 혹시 남은 steer 요청·대기 큐를 정리.
    if (aborted) {
      steerRequests.delete(run.runId);
      pendingFollowUps.delete(run.runId);
    }

    // 대기 중인 follow-up(steering)이 있으면 이어서 돌린다(정상 완료 시에만).
    const queue = pendingFollowUps.get(run.runId);
    if (!aborted && queue && queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) pendingFollowUps.delete(run.runId);
      if (next !== undefined) {
        void executeTurn(run, next, ctx);
        updateWidget(ctx);
        return;
      }
    }

    // 전문 대신 "수령하라"는 알림만 보낸다.
    // 절충안: 실패는 메인이 빨리 알수록 좋으므로 steer(현재 턴 툴 실행 후 즉시 끜어듦),
    // 성공은 급하지 않으므로 followUp(턴이 다 끝난 뒤 전달). idle 이면 둘 다 즉시.
    const status = aborted ? "aborted" : run.status === "done" ? "finished" : "failed";
    let note: string;
    if (aborted) {
      note =
        `Subagent "${run.title}" (id: ${run.runId}) was aborted. ` +
        `Partial output (if any) is available via fetch_subagent_result with subagentId "${run.runId}".`;
    } else if (run.status === "done") {
      note =
        `Subagent "${run.title}" (id: ${run.runId}) ${status}. ${run.unreadTurns.length} unread response(s). ` +
        `Call fetch_subagent_result with subagentId "${run.runId}" to read the output, ` +
        `or send_to_subagent to continue the conversation.`;
    } else {
      note =
        `Subagent "${run.title}" (id: ${run.runId}) ${status}: ${run.error || "unknown error"}. ` +
        `Call fetch_subagent_result with subagentId "${run.runId}" for details.`;
    }
    const deliverAs = run.status === "done" && !aborted ? "followUp" : "steer";
    pi.sendUserMessage(
      `[subagent ${run.runId} ${status}] ${note}`,
      ctx.isIdle() ? undefined : { deliverAs },
    );
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
      "When a subagent finishes you receive a SHORT notification with its id — not the full output. This notification arrives on its own; do NOT sleep or poll waiting for it.",
      "Transient failures (rate limit, timeout, 5xx, network blips) are retried automatically with the SAME model and backoff before a run is reported as failed — you don't need to re-spawn for those.",
      "Call fetch_subagent_result with that id to read the response, send_to_subagent to ask follow-ups (queued if it is still running), and abort_subagent to stop one early.",
      "Use list_subagents to see all runs and which have unread responses (only when you actively need the overview — NOT as a way to wait for a run to finish).",
      "Each task may name an `agent` (a discovered preset with its own system prompt, tools, and default model),",
      "and/or set a `model` override. Omit `agent` to run a bare subagent with full tool access controlled only by `model`.",
      'Set `model` to "current" to reuse the parent\'s current model. `title` is a required short label for the run list.',
      'Set `excludeTools` to restrict a subagent (e.g. ["edit","write"] for a read-only reviewer that can investigate but not modify files).',
      "Use this to parallelize independent investigation or work.",
    ].join(" "),
    promptSnippet:
      "Run subagents concurrently in the background; fetch results by id when notified",
    promptGuidelines: [
      "Use spawn_subagents to delegate independent tasks that can run in parallel without blocking you.",
      "Pick a specialized agent when one fits; otherwise omit agent and just set a model (use 'current' to match yourself).",
      "After spawning, just keep working or end your turn normally. Do NOT poll, and never run sleep/wait to pass time — when a subagent finishes, pi delivers a '[subagent <id> finished]' message to you automatically, even if you stopped.",
      "Waiting for a subagent? Do NOT repeatedly call list_subagents (or any tool) to check on it — that just burns tokens. If you have no other work, STOP and end your turn; the '[subagent <id> finished]' notification will wake you. Polling the run list in a loop is a bug, not progress.",
      "When you get a '[subagent <id> finished]' notification, call fetch_subagent_result with that id to read the output.",
      "To ask a subagent a follow-up, call send_to_subagent with its id (it works even while the subagent is still running — the message is queued). Use abort_subagent to stop one early.",
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
        const title = sanitizeForRender(t.title.trim() || t.task.slice(0, 60)).replace(/\n/g, " ");
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
          excludeTools: t.excludeTools && t.excludeTools.length > 0 ? t.excludeTools : undefined,
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
          `They run concurrently. You are NOT blocked — keep working or end your turn.`,
          `When each finishes you'll get a '[subagent <id> finished]' message automatically — do not sleep or poll. Then call fetch_subagent_result with that id to read the output.`,
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
      "Use this to find a subagent's id before calling fetch_subagent_result or send_to_subagent. " +
      "Do NOT call this in a loop to wait for a run to complete — if you are only waiting, stop and end your turn; the '[subagent <id> finished]' notification arrives on its own.",
    promptSnippet: "List subagent runs and their unread status",
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<Record<string, unknown>>> {
      const all = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
      if (all.length === 0) {
        return {
          content: [{ type: "text", text: "No subagents in this session yet." }],
          details: {},
        };
      }
      const lines = all.map((r) => {
        const unread = r.unreadTurns.length > 0 ? ` · ${r.unreadTurns.length} unread` : "";
        return `${statusIcon[r.status]} ${r.runId}  "${r.title}"  [${r.agent}${r.model ? `, ${r.model}` : ""}]  ${r.turns.length} turn(s)${unread}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: all.length },
      };
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
      subagentId: Type.String({
        description: "The subagent run id (e.g. from the finished notification).",
      }),
      all: Type.Optional(
        Type.Boolean({
          description: "If true, return all turns, not just unread ones. Default false.",
        }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const run = runs.get(params.subagentId);
      if (!run) {
        return {
          content: [
            {
              type: "text",
              text: `No subagent found with id "${params.subagentId}". Use list_subagents to see ids.`,
            },
          ],
          details: { found: false },
        };
      }
      const wantAll = params.all === true;
      const indices = wantAll
        ? run.turns.map((_, i) => i)
        : [...run.unreadTurns].sort((a, b) => a - b);
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
        details: {
          found: true,
          status: run.status,
          returned: indices.length,
          remainingUnread: run.unreadTurns.length,
        },
      };
    },
  });

  // ── 도구: send_to_subagent (id 로 추가 프롬프트, 세션 이어서) ─────────
  pi.registerTool({
    name: "send_to_subagent",
    label: "Send To Subagent",
    description:
      "Send a follow-up message to an existing subagent by its id. The subagent resumes its OWN session, so it keeps full context of all prior turns. " +
      "If the subagent is IDLE, the message runs immediately. If it is RUNNING, behavior depends on `deliverAs`: " +
      "`followUp` (default) queues the message and runs it after the current turn finishes; " +
      "`steer` aborts the current turn right now and immediately starts a new turn with your message (interrupt + redirect). " +
      "Either way it runs in the background; when it finishes you get a '[subagent <id> finished]' notification, then call fetch_subagent_result.",
    promptSnippet: "Send a follow-up to a subagent (followUp to queue, steer to interrupt)",
    promptGuidelines: [
      "Use send_to_subagent to continue a conversation with a subagent that already ran — it remembers its prior turns.",
      "send_to_subagent works whether the subagent is idle or running. For a running one, use deliverAs='followUp' to let the current turn finish first, or deliverAs='steer' to interrupt it now and redirect. Do not poll or sleep waiting.",
    ],
    parameters: Type.Object({
      subagentId: Type.String({ description: "The subagent run id to continue." }),
      message: Type.String({ description: "The follow-up prompt/instruction for the subagent." }),
      deliverAs: Type.Optional(
        StringEnum(["followUp", "steer"] as const, {
          description:
            "How to deliver when the subagent is still running. 'followUp' (default) queues after the current turn; 'steer' aborts the current turn and starts a new one immediately. Ignored when the subagent is idle.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const run = runs.get(params.subagentId);
      if (!run) {
        return {
          content: [
            {
              type: "text",
              text: `No subagent found with id "${params.subagentId}". Use list_subagents to see ids.`,
            },
          ],
          details: { found: false },
        };
      }
      const deliverAs = params.deliverAs ?? "followUp";
      if (run.status === "running") {
        if (deliverAs === "steer") {
          // 현재 turn 을 즉시 중단하고, 끝나면 이 메시지로 새 turn 을 시작한다.
          // 중단 전에 올라온 대기 큐는 비우고(steer 가 우선), 이 메시지만 단독으로 넓는다.
          // executeTurn 은 abort 시 큐를 지우므로, abort 가 처리된 뒤 의 완료 콜백에서
          // 이어달린다. 경주 조건: abort 후 executeTurn 이 pendingFollowUps 를 비우므로,
          // 여기서 큐를 설정해도 지워진다. 따라서 steer 는 "abort 완료를 기다렸다가 새 turn"
          // 을 한번에 처리하는 전용 대기자를 둔다.
          steerRequests.set(run.runId, params.message);
          const controller = controllers.get(run.runId);
          controller?.abort();
          updateWidget(ctx);
          return {
            content: [
              {
                type: "text",
                text:
                  `Steering subagent "${run.title}" (${run.runId}): aborting the current turn and restarting with your message. ` +
                  `You'll get a '[subagent ${run.runId} finished]' notification when the new turn completes. Keep working — no need to wait.`,
              },
            ],
            details: { found: true, running: true, steered: true },
          };
        }
        // followUp: 큐에 넣어 현재 turn 이 끝난 뒤 자동으로 이어 돌린다.
        const queue = pendingFollowUps.get(run.runId) ?? [];
        queue.push(params.message);
        pendingFollowUps.set(run.runId, queue);
        return {
          content: [
            {
              type: "text",
              text:
                `Subagent "${run.title}" (${run.runId}) is running; your message was QUEUED (position ${queue.length}) and will run after the current turn finishes. ` +
                `You'll get a '[subagent ${run.runId} finished]' notification when it completes. Keep working — no need to wait.`,
            },
          ],
          details: { found: true, running: true, queued: true, queueLength: queue.length },
        };
      }
      // idle: 백그라운드 재실행 — 같은 세션을 이어간다.
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

  // ── 도구: abort_subagent (id 로 진행 중인 자식을 중단) ─────────────
  pi.registerTool({
    name: "abort_subagent",
    label: "Abort Subagent",
    description:
      "Abort a currently running subagent by its id. Kills the child process; any partial output is kept and remains readable via fetch_subagent_result. " +
      "Also clears any queued follow-up messages for that subagent. No effect if the subagent is not running.",
    promptSnippet: "Abort a running subagent by id",
    promptGuidelines: [
      "Use abort_subagent to stop a runaway or no-longer-needed subagent; it stops the run but keeps whatever it produced so far.",
    ],
    parameters: Type.Object({
      subagentId: Type.String({ description: "The subagent run id to abort." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const run = runs.get(params.subagentId);
      if (!run) {
        return {
          content: [
            {
              type: "text",
              text: `No subagent found with id "${params.subagentId}". Use list_subagents to see ids.`,
            },
          ],
          details: { found: false },
        };
      }
      const controller = controllers.get(run.runId);
      // 대기 중인 follow-up 과 steer 요청도 함께 비운다(abort 는 사용자의 명시적 중단).
      const hadQueue =
        (pendingFollowUps.get(run.runId)?.length ?? 0) > 0 || steerRequests.has(run.runId);
      pendingFollowUps.delete(run.runId);
      steerRequests.delete(run.runId);
      if (!controller || run.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: `Subagent "${run.title}" (${run.runId}) is not running (status: ${run.status}).${hadQueue ? " Cleared its queued follow-up(s)." : ""}`,
            },
          ],
          details: { found: true, running: false, clearedQueue: hadQueue },
        };
      }
      controller.abort();
      updateWidget(ctx);
      return {
        content: [
          {
            type: "text",
            text:
              `Aborting subagent "${run.title}" (${run.runId}). The child process is being stopped; ` +
              `partial output (if any) stays readable via fetch_subagent_result.${hadQueue ? " Queued follow-up(s) cleared." : ""} ` +
              `You'll get a '[subagent ${run.runId} aborted]' notification shortly.`,
          },
        ],
        details: { found: true, aborted: true, clearedQueue: hadQueue },
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

  // detail 모드 한 페이지 높이(스크롤 단위). header/footer 여유를 뺀 근사치.
  private get pageStep(): number {
    return Math.max(3, this.rows - 4);
  }

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
      // 리스트: ↑↓ / j k 로 선택 이동, PgUp/PgDn / space b 로 점프, g/G 로 처음·끝.
      const last = this.runs.length - 1;
      if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, "down") || data === "j")
        this.selected = Math.min(last, this.selected + 1);
      else if (matchesKey(data, "pageUp") || data === "b")
        this.selected = Math.max(0, this.selected - 10);
      else if (matchesKey(data, "pageDown") || data === " ")
        this.selected = Math.min(last, this.selected + 10);
      else if (data === "g" || matchesKey(data, "home")) this.selected = 0;
      else if (data === "G" || matchesKey(data, "end")) this.selected = last;
      else if (matchesKey(data, "return")) {
        this.mode = "detail";
        this.scroll = 0;
      }
    } else {
      // 디테일: ↑↓ / j k 로 한 줄, PgUp/PgDn / space b 로 한 페이지, g/G 로 처음·끝.
      // 아래쪽 상한은 render 가 maxScroll 로 다시 clamp 하므로 여기서는 크게 잡아도 된다.
      const page = this.pageStep;
      if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, "down") || data === "j") this.scroll += 1;
      else if (matchesKey(data, "pageUp") || data === "b")
        this.scroll = Math.max(0, this.scroll - page);
      else if (matchesKey(data, "pageDown") || data === " ") this.scroll += page;
      else if (data === "g" || matchesKey(data, "home")) this.scroll = 0;
      else if (data === "G" || matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER; // render 가 maxScroll 로 clamp
    }
  }

  private renderList(innerW: number): string[] {
    const th = this.theme;
    const rows = this.rows;
    const header = [
      th.fg("accent", " 🤖 Subagent runs") + th.fg("dim", `  (${this.runs.length})`),
      "",
    ];
    const footer = th.fg(
      "dim",
      ` ↑↓/jk select · space/b page · g/G ends · Enter open · Esc/${formatKeyLabel(VIEW_SHORTCUT)} close`,
    );
    const viewport = Math.max(2, rows - header.length - 1); // 1 = footer

    // 각 run 은 2줄(제목 + 메타). 선택 항목이 뷰포트 안에 들어오도록 스크롤 행을 맞춘다.
    const rowsPerItem = 2;
    const itemsVisible = Math.max(1, Math.floor(viewport / rowsPerItem));
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    else if (this.selected >= this.listScroll + itemsVisible)
      this.listScroll = this.selected - itemsVisible + 1;
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
      const title = r.title.length > titleMax ? `${r.title.slice(0, titleMax)}…` : r.title;
      const head = `${statusIcon[r.status]} ${title}`;
      body.push(`${prefix}${sel ? th.fg("text", head) : th.fg("muted", head)}${unread}`);
      body.push(
        `   ${th.fg("dim", `${r.agent} · ${dur} · ${stats}${r.model ? ` · ${r.model}` : ""}`)}`,
      );
    }

    const lines = [...header, ...body];
    // 풀스크린을 채우도록 footer 앞에 빈 줄 패딩.
    while (lines.length < rows - 1) lines.push("");
    lines.push(footer);
    return lines.map((l) => truncateToWidth(` ${l}`, innerW + 2));
  }

  private renderDetail(innerW: number): string[] {
    const th = this.theme;
    const rows = this.rows;
    const r = this.runs[this.selected];
    const head: string[] = [];
    head.push(
      th.fg("accent", ` ${statusIcon[r.status]} ${r.title}`) +
        th.fg("dim", `  (${r.runId} · ${r.agent})`),
    );
    if (r.error) head.push(th.fg("error", ` Error: ${r.error}`));
    head.push(th.fg("dim", ` ${"─".repeat(Math.max(4, innerW - 2))}`));

    // 모든 turn 을 순회해 프롬프트 + 트랜스크립트를 보여준다.
    const body: string[] = [];
    const turns =
      r.turns.length > 0
        ? r.turns
        : [
            {
              prompt: r.task,
              transcript: r.transcript,
              finalOutput: r.finalOutput,
              startedAt: r.startedAt,
            } as Turn,
          ];
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti];
      if (turns.length > 1 || ti > 0) {
        body.push(th.fg("accent", `  ▸ turn ${ti + 1}`));
      }
      body.push(th.fg("dim", `  📤 prompt`));
      for (const raw of sanitizeForRender(turn.prompt).split("\n")) {
        for (const w of wrapTextWithAnsi(raw, innerW - 4)) body.push(`    ${th.fg("muted", w)}`);
      }
      for (const item of turn.transcript) {
        const label = kindLabel[item.kind];
        const color =
          item.kind === "thinking"
            ? "dim"
            : item.kind === "toolCall"
              ? "accent"
              : item.kind === "toolResult"
                ? "muted"
                : "text";
        body.push(th.fg("dim", `  ${label}${item.toolName ? ` ${item.toolName}` : ""}`));
        for (const raw of item.text.split("\n")) {
          for (const w of wrapTextWithAnsi(raw, innerW - 4))
            body.push(`    ${th.fg(color as never, w)}`);
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
      ` ↑↓/jk scroll · space/b page · g/G ends · Esc back  [${body.length === 0 ? 0 : this.scroll + 1}-${this.scroll + slice.length}/${body.length}]`,
    );
    const lines = [...head, ...slice];
    while (lines.length < rows - 1) lines.push("");
    lines.push(footer);
    return lines.map((l) => truncateToWidth(` ${l}`, innerW + 2));
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

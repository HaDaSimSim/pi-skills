// subagents — background asynchronous multi-subagents.
//
// Design principles:
//   1. Always background and multi. spawn_subagents({ tasks: [...] }) spawns the
//      child pi processes and returns "immediately". The main agent is not blocked.
//   2. When each child finishes, only its "final output" is injected into the main agent (context savings).
//   3. The child's full transcript (including thinking and tool calls) is persisted to the session as a
//      custom entry. It never enters the LLM context and lives only on disk (the session jsonl).
//   4. Press Ctrl+\ to open the subagent view overlay and browse past runs. Because they are
//      restored from the session, you can quit and relaunch pi and still see them by opening the same session (opencode style).
//      Scroll with ↑↓ / j k / space·b / g·G keys (does not rely on terminal mouse forwarding). Transcript text has TAB/control characters
//      stripped before render to prevent render crashes from pi-tui width-calculation mismatches (sanitizeForRender).
//   5. For a running child you can queue follow-ups with send_to_subagent (steering) and
//      abort it with abort_subagent. Completion, failure, and abort are all reported to the main agent as messages,
//      so the main agent can just keep working or stay idle without sleeping/polling.
//
// Child execution: pi --mode json -p --session-dir <isolated> --session-id <runId>
//   (isolated session keeps multi-turn context; the main /resume list is not polluted)

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

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TASKS = 8; // max number of tasks that can be spawned at once
const RUN_ENTRY_TYPE = "subagent-run"; // session custom entry type (full transcript)
const VIEW_SHORTCUT = "ctrl+\\"; // subagent view overlay. Not in the built-in bindings so no conflict, and on terminals without kitty support (Zed, etc.) it arrives as the legacy byte (\x1c).

// ─── Types ────────────────────────────────────────────────────────────────

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

// One turn of a subagent (= one prompt + the response to it).
interface Turn {
  prompt: string; // the prompt sent to the child in this turn
  transcript: TranscriptItem[]; // the full transcript of this turn
  finalOutput: string; // the final response text of this turn
  startedAt: number;
  endedAt?: number;
  error?: string;
}

// The full record of one subagent run, persisted to the session.
interface SubagentRun {
  runId: string;
  batchId: string; // shared id for runs grouped by the same spawn_subagents call
  agent: string;
  title: string; // title for list display (required when the main agent spawns)
  task: string; // initial task (the prompt of the first turn)
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  model?: string;
  tools?: string[]; // applied identically on follow-up re-runs (--tools allowlist)
  excludeTools?: string[]; // tools to block (--exclude-tools denylist). Specified per task at spawn.
  agentSystemPrompt?: string; // used to reconstruct the system prompt on follow-up re-runs (empty string = none)
  sessionDir: string; // isolated session storage directory (does not show up in the main /resume)
  sessionId: string; // fixed id used for pi --session-id (= runId)
  usage: RunUsage; // cumulative usage (summed across all turns)
  turns: Turn[]; // turn history
  // Convenience: mirror of the current (last) turn's transcript/final output.
  transcript: TranscriptItem[];
  finalOutput: string;
  error?: string;
  // Indices of response turns the main thread has not yet received.
  unreadTurns: number[];
}

interface TranscriptItem {
  kind: "thinking" | "text" | "toolCall" | "toolResult";
  text: string;
  toolName?: string;
  // GUI-only optional fields. The terminal overlay renders `text` (a compact
  // summary); these carry the full data so rich web renderers (pi-gui) can show
  // complete tool calls. They are ignored by the terminal and safe to omit.
  args?: Record<string, unknown>; // full tool-call arguments (toolCall only)
  isError?: boolean; // tool result error flag (toolResult only)
  fullText?: string; // untruncated result text (toolResult only)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Sanitize text for terminal rendering. Literal TABs and other C0 control characters break pi-tui's
// width calculation (visibleWidth counts TAB as 3, but the compositor's sliceByColumn passes it through
// unchanged, so the widths diverge), causing a "Rendered line exceeds terminal width" crash.
// Before display, expand TAB→spaces and strip other control characters so both calculations always agree.
// Applied at capture time, so the data persisted to the session is clean too.
export function sanitizeForRender(text: string): string {
  if (!text) return text;
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") {
      // Expand the tab to spaces up to the next 4-column boundary.
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else if (ch === "\n") {
      out += ch;
      col = 0;
    } else {
      const code = ch.codePointAt(0) ?? 0;
      // Strip C0 control characters (except \n) and DEL. Preserve the rest (width calculation is delegated to pi-tui).
      if ((code >= 0x00 && code < 0x20) || code === 0x7f) continue;
      out += ch;
      col += 1;
    }
  }
  return out;
}

// Isolated directory that holds child subagent sessions. Kept separate from the main cwd-based session
// folder so it does not pollute the /resume list.
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

// Decide how to run the child pi (same logic as the example's getPiInvocation).
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  // On pi-gui/pi-web hosts, process.argv[1] is not the pi CLI but the backend
  // entry point (server/index.ts). Running that directly makes the child try to spin up
  // another backend and die on a port (4317) conflict (EADDRINUSE). On these hosts, use the real pi.
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

// Flatten assistant message content into transcript items.
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
        args: c.arguments ?? {},
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

// Extract the last assistant text (= final output) from the transcript.
export function finalOutputFrom(transcript: TranscriptItem[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].kind === "text") return transcript[i].text;
  }
  return "";
}

// ─── Child spawn + streaming ─────────────────────────────────────────────────
// Spawn the child pi to run one turn, parse JSON events, and update the run/turn.
//
// The session is saved to the isolated directory (run.sessionDir) under run.sessionId.
//   - First turn: creates a new session (--session-id)
//   - Follow-up: continues the same session (auto-continued since it already exists)
// This keeps the prior conversation context intact, without summarization.
//
// onProgress is called every time the turn is updated. On main abort via signal, the child is killed too.
export function runSubagentTurn(
  run: SubagentRun,
  prompt: string,
  systemPromptFile: string | null,
  cwd: string,
  signal: AbortSignal | undefined,
  onProgress: () => void,
): Promise<Turn> {
  // Create a new Turn for this turn and attach it to the run.
  const turn: Turn = { prompt, transcript: [], finalOutput: "", startedAt: Date.now() };
  run.turns.push(turn);
  run.transcript = turn.transcript; // current turn mirror
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
        // Mark this as a child subagent process. Prevents other extensions also loaded inside the child pi
        // (e.g. telegram) from reacting to the child's agent_end and sending duplicate notifications.
        // PI_WEB_HOST is removed: the child is a real pi CLI, not a pi-gui host.
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
            isError: tr.isError,
            fullText: sanitizeForRender(text),
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
        // Explicit abort: even if there is partial output, it does not become done (state is deterministic).
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
  // Inside a child subagent, do not register any subagent tools at all.
  // Since PI_SUBAGENT=1 is set in the env at spawn (see runSubagentTurn below),
  // this blocks at the code level the infinite recursion where a child pi calls
  // spawn_subagents again to spawn grandchild subagents. The child has its own isolated session
  // with no runs to manage, so list/fetch/send/abort are all meaningless — skip the whole thing.
  if (process.env.PI_SUBAGENT === "1") return;

  // In-memory running/completed runs. Filled from disk on session restore.
  const runs = new Map<string, SubagentRun>();
  // AbortController for the running run. abort_subagent calls this to kill the child.
  const controllers = new Map<string, AbortController>();
  // Set once the host has invalidated this extension's session (reload/switch/dispose).
  // A child process is detached from the session lifecycle and keeps streaming after
  // the host tears the runtime down (e.g. pi-gui's idle reap or tab close). Any deferred
  // host write (appendEntry/sendUserMessage/events.emit) from that orphan would hit a
  // stale extension runner and throw, surfacing as an uncaughtException on the host.
  // Once stale, stop touching the host and kill every child so they stop emitting.
  let stale = false;

  // Abort every running child. Used on session_shutdown and when a stale host write is
  // detected, so detached children don't keep writing into a dead runtime.
  const killAllChildren = () => {
    for (const c of controllers.values()) c.abort();
  };

  // Run a host-touching side effect (appendEntry/sendUserMessage/events.emit) defensively.
  // If the runner was invalidated, swallow the throw, mark stale, and stop the children
  // instead of letting it bubble to the host as an uncaughtException.
  const withHost = (fn: () => void) => {
    if (stale) return;
    try {
      fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/stale after session replacement or reload/.test(msg)) {
        stale = true;
        killAllChildren();
        return;
      }
      throw e;
    }
  };
  // Queue of pending follow-up prompts for a running run (steering). Consumed in order when the current turn ends.
  const pendingFollowUps = new Map<string, string[]>();
  // steer request: abort the current turn and immediately start a new turn with this message.
  // Consumed in executeTurn's completion callback after the abort (takes priority over pendingFollowUps).
  const steerRequests = new Map<string, string>();
  let renderViewer: (() => void) | undefined; // for refreshing if a viewer is open

  // Refresh the progress widget
  const updateWidget = (ctx: ExtensionContext) => {
    if (stale) return; // host invalidated: ctx.hasUI/theme would throw, and there is nothing to update
    const all = [...runs.values()];
    const running = all.filter((r) => r.status === "running").length;
    // Emit the running count on a shared bus so other extensions (especially the goal loop) can
    // "hold continuation while background subagents are running".
    // Always emit regardless of whether there is a UI (won't reach print-mode children due to the PI_SUBAGENT guard).
    withHost(() => pi.events.emit("subagents:running", { running }));
    let hasUI: boolean;
    try {
      hasUI = ctx.hasUI;
    } catch {
      // ctx access throws once the runner is stale (detached child after host teardown).
      stale = true;
      killAllChildren();
      return;
    }
    if (!hasUI) return;
    // If there is at least one run, expose the viewer shortcut hint in the footer.
    // rawKeyHint / ctx.ui.theme depend on the TUI theme (initTheme). Non-TUI hosts like pi-web
    // have no theme even when hasUI=true, so they throw — guard the whole thing.
    try {
      const viewHint = all.length > 0 ? rawKeyHint(VIEW_SHORTCUT, "view subagents") : "";
      if (running > 0) {
        const label = ctx.ui.theme.fg(
          "dim",
          `🤖 ${running} subagent${running > 1 ? "s" : ""} running`,
        );
        const divider = ctx.ui.theme.fg("dim", " • ");
        ctx.ui.setStatus("subagents", viewHint ? `${label}${divider}${viewHint}` : label);
      } else if (all.length > 0) {
        ctx.ui.setStatus("subagents", viewHint);
      } else {
        ctx.ui.setStatus("subagents", undefined);
      }
    } catch {
      /* Non-TUI host (theme not initialized): silently skip the widget update. */
    }
  };

  // Persist a run to the session (custom entry = not in the LLM context). Overwritten on each state change.
  // Guarded: a detached child can call this after the host invalidated the runtime.
  const persistRun = (run: SubagentRun) => {
    withHost(() => pi.appendEntry(RUN_ENTRY_TYPE, run as unknown as Record<string, unknown>));
  };

  // Execute one turn (shared by the initial task and follow-ups). When done, mark it as an unread
  // turn and send the main agent only a short "go fetch it" notification (no full-text injection).
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
      // transient retry: if the child ends with a transient failure (rate limit/network blip), retry with
      // the same model after a short backoff. Model identity is kept (not a fallback).
      // Aborts and non-transient errors (bad arguments, etc.) are not retried.
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
          // Remove the failed turn from the transcript (the retry pushes a new turn, so prevent accumulation).
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

    // Add the just-finished turn index to the unread list.
    const turnIndex = run.turns.length - 1;
    if (!run.unreadTurns.includes(turnIndex)) run.unreadTurns.push(turnIndex);
    persistRun(run);

    // If aborted by a steer request: discard the interrupted queue and immediately continue with the new message.
    // (No abort notification is sent; only the new turn's completion notification goes out.)
    const steerMsg = steerRequests.get(run.runId);
    if (aborted && steerMsg !== undefined) {
      steerRequests.delete(run.runId);
      pendingFollowUps.delete(run.runId);
      void executeTurn(run, steerMsg, ctx);
      updateWidget(ctx);
      return;
    }
    // If it was a plain abort (not a steer), clean up any leftover steer request and pending queue.
    if (aborted) {
      steerRequests.delete(run.runId);
      pendingFollowUps.delete(run.runId);
    }

    // If there is a pending follow-up (steering), continue with it (only on normal completion).
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

    // Send only a "go fetch it" notification instead of the full text.
    // Tradeoff: failures are better known to the main agent quickly, so use steer (delivered right after the current turn's tool execution);
    // successes are not urgent, so use followUp (delivered after the turn fully ends). When idle, both are immediate.
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
    // Guarded: both ctx.isIdle() and pi.sendUserMessage hit the runner, which throws
    // once the host has invalidated this session. A detached child reaching here after
    // teardown must not crash the host — withHost swallows it and stops the children.
    withHost(() =>
      pi.sendUserMessage(
        `[subagent ${run.runId} ${status}] ${note}`,
        ctx.isIdle() ? undefined : { deliverAs },
      ),
    );
    updateWidget(ctx);
  };

  // ── Tool: spawn_subagents (background multi, returns immediately) ──────────────────
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

      // The parent's current model (for resolving the "current" alias).
      const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      const tasks = params.tasks.slice(0, MAX_TASKS);
      const batchId = newId();
      const accepted: string[] = [];
      const unknownAgents: string[] = [];
      const errors: string[] = [];

      for (const t of tasks) {
        // agent is optional. If specified but not found, add it to the ignored list.
        const agent = t.agent ? byName.get(t.agent) : undefined;
        if (t.agent && !agent) {
          unknownAgents.push(t.agent);
          continue;
        }

        // Model decision: task.model overrides the agent default. "current" maps to the parent's model.
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

        // If there is no agent and no model can be determined, it cannot run.
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

        // Background execution — do not await.
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

  // ── Tool: list_subagents (all runs and their unread status) ──────────────────
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

  // ── Tool: fetch_subagent_result (receive an unread response by id) ───────────────
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
      // Mark as received: remove the read turn from the unread list.
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

  // ── Tool: send_to_subagent (additional prompt by id, continuing the session) ─────────
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
          // Abort the current turn immediately, and when it ends start a new turn with this message.
          // Clear the pending queue that arrived before the interrupt (steer takes priority) and run this message alone.
          // Since executeTurn clears the queue on abort, it is continued from the completion callback after the abort is handled.
          // Race condition: since executeTurn clears pendingFollowUps after abort, setting the queue here would also be cleared.
          // So steer uses a dedicated waiter that handles "wait for the abort to complete, then start a new turn" in one step.
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
        // followUp: enqueue it so it automatically continues after the current turn ends.
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
      // idle: background re-run — continues the same session.
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

  // ── Tool: abort_subagent (abort a running child by id) ─────────────
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
      // Also clear pending follow-ups and steer requests (abort is the user's explicit interruption).
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

  // ── Viewer overlay (Ctrl+X) ───────────────────────────────────────────────
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

  // ── Session restore: load subagent-run entries from disk into memory ──────────────────────
  pi.on("session_start", async (_event, ctx) => {
    stale = false; // fresh (or resumed) session: the runner is live again
    runs.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE) {
        const data = entry.data as SubagentRun | undefined;
        if (data && typeof data.runId === "string") {
          // The latest snapshot for the same runId comes later, so overwrite.
          // Anything still "running" at restore time is a dead process, so mark it failed.
          const restored: SubagentRun = { ...data };
          // Old snapshot compatibility: backfill new fields.
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

  // Host is tearing down or replacing this session (reload/switch/dispose). Detached child
  // processes are not bound to the session lifecycle, so kill them now; otherwise an orphan
  // keeps streaming and its deferred persistRun/notify would hit the invalidated runner.
  // Mark stale so any in-flight callback that races past the kill is swallowed by withHost.
  pi.on("session_shutdown", () => {
    stale = true;
    killAllChildren();
  });
}

// ─── Viewer component ───────────────────────────────────────────────────────────

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
  private scroll = 0; // detail mode scroll
  private listScroll = 0; // list mode scroll (follows the selection)

  constructor(
    private runs: SubagentRun[],
    private theme: Theme,
    private tui: TUI,
    private done: (r: void) => void,
  ) {}

  // Detail mode one-page height (scroll unit). Approximate, minus header/footer margins.
  private get pageStep(): number {
    return Math.max(3, this.rows - 4);
  }

  // Terminal height (the overlay is fullscreen, so use all rows, leaving only a small margin).
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
      // List: ↑↓ / j k to move selection, PgUp/PgDn / space b to jump, g/G for start/end.
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
      // Detail: ↑↓ / j k for one line, PgUp/PgDn / space b for one page, g/G for start/end.
      // The lower bound is re-clamped to maxScroll by render, so it's fine to set it large here.
      const page = this.pageStep;
      if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, "down") || data === "j") this.scroll += 1;
      else if (matchesKey(data, "pageUp") || data === "b")
        this.scroll = Math.max(0, this.scroll - page);
      else if (matchesKey(data, "pageDown") || data === " ") this.scroll += page;
      else if (data === "g" || matchesKey(data, "home")) this.scroll = 0;
      else if (data === "G" || matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER; // render clamps to maxScroll
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

    // Each run is 2 lines (title + meta). Adjust the scroll row so the selected item stays within the viewport.
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
      // Title first (prominent), then agent/meta on the next line.
      const titleMax = Math.max(12, innerW - 12);
      const title = r.title.length > titleMax ? `${r.title.slice(0, titleMax)}…` : r.title;
      const head = `${statusIcon[r.status]} ${title}`;
      body.push(`${prefix}${sel ? th.fg("text", head) : th.fg("muted", head)}${unread}`);
      body.push(
        `   ${th.fg("dim", `${r.agent} · ${dur} · ${stats}${r.model ? ` · ${r.model}` : ""}`)}`,
      );
    }

    const lines = [...header, ...body];
    // Pad with blank lines before the footer to fill the fullscreen.
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

    // Iterate over all turns to show the prompt + transcript.
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

    // Apply scroll (excluding header + 1 footer line).
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

// Make a raw key like VIEW_SHORTCUT human-readable (ctrl+\ → Ctrl+\).
function formatKeyLabel(key: string): string {
  return key
    .split("+")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("+");
}

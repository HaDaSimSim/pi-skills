// async-bash — run long shell commands in the background.
//
// Design principles (mirrors the `subagents` extension's "fire and forget,
// get pinged when done" model):
//   1. bash_async({ command }) spawns the command detached and returns
//      IMMEDIATELY with a jobId. The main agent is never blocked on it.
//   2. Output is streamed to an in-memory buffer plus a temp log file. The main
//      agent does NOT receive the output automatically — it calls bash_output
//      with the jobId when it wants to read it.
//   3. On exit / timeout / abort the job is finalized and a SHORT notification
//      is injected into the main agent ([bash-job <id> done|failed|aborted]),
//      so the agent can keep working or stay idle without polling or sleeping.
//   4. Each job is persisted to the session as a `bash-job` custom entry
//      (updated on every state change, last-wins by jobId) so pi-gui and
//      reopened sessions can see it. Custom entries never enter the LLM context.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  getShellConfig,
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
import { sanitizeForRender, toLabel } from "./sanitize.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const JOB_ENTRY_TYPE = "bash-job"; // session custom entry type
const VIEW_SHORTCUT = "ctrl+shift+b"; // background-jobs viewer overlay
const MAX_INLINE_BYTES = 16 * 1024; // cap inline `output` field; full stream lives in logPath
const LABEL_MAX = 60;

// ─── Types ────────────────────────────────────────────────────────────────

type JobStatus = "running" | "done" | "failed" | "aborted";

interface BashJob {
  jobId: string;
  label: string; // display name (defaults to the command, truncated)
  command: string; // full command
  cwd: string;
  status: JobStatus;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  output: string; // captured text (capped at MAX_INLINE_BYTES; full in logPath)
  truncated?: boolean;
  logPath?: string; // temp file with full output
  timeout?: number; // per-job timeout in seconds, if set
  error?: string; // human-readable reason for failed/aborted
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

// Human-readable duration label for a job, robust to restored jobs that ended
// without an `endedAt` (e.g. marked failed at session restore).
function jobDuration(job: BashJob): string {
  if (job.endedAt) return formatDuration(job.endedAt - job.startedAt);
  if (job.status === "running") return `${formatDuration(Date.now() - job.startedAt)}…`;
  return "unknown duration";
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// Kill a detached process group (the child is spawned with detached:true, so
// its pid is also the process-group id). SIGTERM first for a clean shutdown,
// then SIGKILL after a grace period. Mirrors the core bash tool's
// killProcessTree (which is not exported from the package).
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, 3000);
}

// ─── Extension ─────────────────────────────────────────────────────────────

const BashAsyncParams = Type.Object({
  command: Type.String({
    description:
      "The shell command to run in the background. Runs via the user's shell, detached, and returns immediately.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the command. Defaults to the current session cwd.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Optional timeout in seconds. When it elapses the job's process tree is killed and the job is marked failed.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      description:
        "Optional short display label for the job list. Defaults to the command (truncated).",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  // Inside a child subagent there is no point managing background jobs of our
  // own; keep the surface clean (mirrors the subagents PI_SUBAGENT guard).
  if (process.env.PI_SUBAGENT === "1") return;

  // In-memory jobs, keyed by jobId. Filled from disk on session restore.
  const jobs = new Map<string, BashJob>();
  // Live child handles for running jobs (pid + abort flag), keyed by jobId.
  const live = new Map<string, { pid: number | undefined; aborted: boolean }>();
  let renderViewer: (() => void) | undefined; // refresh hook if the viewer is open

  // Set once the host has invalidated this session (reload/switch/dispose). A detached
  // child keeps streaming after the host tears the runtime down (e.g. pi-gui's idle reap
  // or tab close, which call session.dispose() directly without a session_shutdown event).
  // Any deferred host write (appendEntry/sendUserMessage) from that orphan would hit a
  // stale extension runner and throw, surfacing as an uncaughtException on the host.
  let stale = false;

  // Abort all running children. Used on session_shutdown and when a stale write is detected.
  const killAllJobs = () => {
    for (const handle of live.values()) {
      handle.aborted = true;
      if (handle.pid) killProcessTree(handle.pid);
    }
    live.clear();
  };

  // Run a host-touching side effect defensively. If the runner was invalidated, swallow
  // the throw, mark stale, and kill the children so they stop emitting.
  const withHost = (fn: () => void) => {
    if (stale) return;
    try {
      fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/stale after session replacement or reload/.test(msg)) {
        stale = true;
        killAllJobs();
        return;
      }
      throw e;
    }
  };

  // Persist a job snapshot to the session (custom entry, not in LLM context).
  // Guarded: a detached child can call this after the host invalidated the runtime.
  const persistJob = (job: BashJob) => {
    withHost(() => pi.appendEntry(JOB_ENTRY_TYPE, job as unknown as Record<string, unknown>));
  };

  // Refresh the footer widget with the running-job count + viewer hint.
  const updateWidget = (ctx: ExtensionContext) => {
    if (stale) return; // host invalidated: ctx.hasUI/theme would throw
    let hasUI: boolean;
    try {
      hasUI = ctx.hasUI;
    } catch {
      stale = true;
      killAllJobs();
      return;
    }
    if (!hasUI) return;
    const all = [...jobs.values()];
    const running = all.filter((j) => j.status === "running").length;
    try {
      if (running > 0) {
        const label = ctx.ui.theme.fg(
          "dim",
          `⚙ ${running} bash job${running > 1 ? "s" : ""} running`,
        );
        ctx.ui.setStatus("async-bash", label);
      } else {
        ctx.ui.setStatus("async-bash", undefined);
      }
    } catch {
      /* Non-TUI host (theme not initialized): skip the widget update. */
    }
  };

  // Spawn the command detached, stream output, finalize + notify on exit.
  const startJob = (job: BashJob, ctx: ExtensionContext) => {
    let shell: string;
    let shellArgs: string[];
    try {
      const cfg = getShellConfig();
      shell = cfg.shell;
      shellArgs = cfg.args;
    } catch (e) {
      job.status = "failed";
      job.error = `no shell available: ${(e as Error).message}`;
      job.endedAt = Date.now();
      persistJob(job);
      notify(job, ctx);
      return;
    }

    // Open the log file up front so the full stream is always preserved.
    let logStream: fs.WriteStream | undefined;
    try {
      job.logPath = path.join(os.tmpdir(), `pi-bash-job-${job.jobId}.log`);
      logStream = fs.createWriteStream(job.logPath);
    } catch {
      job.logPath = undefined;
    }

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(shell, [...shellArgs, job.command], {
        cwd: job.cwd,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      job.status = "failed";
      job.error = `spawn failed: ${(e as Error).message}`;
      job.endedAt = Date.now();
      logStream?.end();
      persistJob(job);
      notify(job, ctx);
      return;
    }

    const handle = { pid: proc.pid, aborted: false };
    live.set(job.jobId, handle);

    // Throttle persistence/render while streaming; the full stream always
    // lands in the log file regardless.
    let lastPersist = 0;
    const decoder = new TextDecoder();

    const onData = (data: Buffer) => {
      logStream?.write(data);
      const text = sanitizeForRender(decoder.decode(data, { stream: true }));
      job.output += text;
      // Keep only the tail of the inline buffer.
      if (Buffer.byteLength(job.output, "utf-8") > MAX_INLINE_BYTES) {
        job.truncated = true;
        const buf = Buffer.from(job.output, "utf-8");
        job.output = buf.subarray(buf.length - MAX_INLINE_BYTES).toString("utf-8");
      }
      // Throttle persistence/render to ~every 250ms while streaming.
      const now = Date.now();
      if (now - lastPersist > 250) {
        lastPersist = now;
        persistJob(job);
        renderViewer?.();
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (job.timeout && job.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (proc.pid) killProcessTree(proc.pid);
      }, job.timeout * 1000);
    }

    const finalize = (code: number | null) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      job.endedAt = Date.now();
      job.exitCode = code ?? undefined;
      if (handle.aborted) {
        job.status = "aborted";
        job.error = job.error ?? "aborted";
      } else if (timedOut) {
        job.status = "failed";
        job.error = `timed out after ${job.timeout}s`;
      } else if (code === 0) {
        job.status = "done";
      } else {
        job.status = "failed";
        job.error = job.error ?? `exited with code ${code}`;
      }
      live.delete(job.jobId);
      const close = logStream
        ? new Promise<void>((res) => logStream.end(() => res()))
        : Promise.resolve();
      void close.then(() => {
        persistJob(job);
        updateWidget(ctx);
        renderViewer?.();
        notify(job, ctx);
      });
    };

    proc.on("close", (code) => finalize(code));
    proc.on("error", (e) => {
      if (job.status === "running") {
        job.error = e.message;
        finalize(null);
      }
    });
  };

  // Inject a short completion notification to the main agent. Success uses
  // followUp (not urgent); failure/abort uses steer so the agent reacts sooner.
  // When idle, both are immediate.
  const notify = (job: BashJob, ctx: ExtensionContext) => {
    const dur = job.endedAt ? formatDuration(job.endedAt - job.startedAt) : "?";
    let note: string;
    let deliverAs: "followUp" | "steer";
    if (job.status === "done") {
      note =
        `[bash-job ${job.jobId} done] "${job.label}" exited 0 in ${dur}. ` +
        `Use bash_output with jobId "${job.jobId}" to read its output.`;
      deliverAs = "followUp";
    } else if (job.status === "aborted") {
      note =
        `[bash-job ${job.jobId} aborted] "${job.label}" was aborted after ${dur}. ` +
        `Partial output (if any) is available via bash_output with jobId "${job.jobId}".`;
      deliverAs = "steer";
    } else {
      note =
        `[bash-job ${job.jobId} failed] "${job.label}" ${job.error ?? "failed"} in ${dur}. ` +
        `Use bash_output with jobId "${job.jobId}" to read its output.`;
      deliverAs = "steer";
    }
    // Guarded: both ctx.isIdle() and pi.sendUserMessage hit the runner, which throws
    // once the host has invalidated this session. A detached child reaching here after
    // teardown must not crash the host — withHost swallows it and stops the jobs.
    withHost(() => pi.sendUserMessage(note, ctx.isIdle() ? undefined : { deliverAs }));
  };

  // ── Tool: bash_async (spawn detached, return immediately) ──────────────────
  pi.registerTool({
    name: "bash_async",
    label: "Bash (async)",
    description: [
      "Run a long shell command in the BACKGROUND and return IMMEDIATELY with a jobId.",
      "Use this instead of bash for long jobs (builds, test suites, installs, watchers) so the turn is not blocked.",
      "You are NOT blocked — keep working or end your turn. Do NOT sleep or poll.",
      "When the job exits you receive a SHORT '[bash-job <id> done|failed|aborted]' message automatically; then call bash_output with that id to read the output.",
      "Use bash_jobs to list jobs, bash_output to read captured output, and bash_abort to stop a job early.",
    ].join(" "),
    promptSnippet:
      "Run a long shell command in the background; get pinged when it exits (no polling)",
    promptGuidelines: [
      "Use bash_async for long-running commands (builds, test suites, installs, dev servers) so they don't block the turn; use the plain bash tool for quick commands.",
      "After starting a job, keep working or end your turn. Do NOT sleep or poll — when the job exits, pi delivers a '[bash-job <id> ...]' message automatically.",
      "When you get a '[bash-job <id> ...]' notification, call bash_output with that id to read the output.",
    ],
    parameters: BashAsyncParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const command = params.command;
      const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
      if (!fs.existsSync(cwd)) {
        return {
          content: [{ type: "text", text: `Working directory does not exist: ${cwd}` }],
          details: { started: false },
        };
      }
      const jobId = newId();
      const job: BashJob = {
        jobId,
        label: params.label ? toLabel(params.label, LABEL_MAX) : toLabel(command, LABEL_MAX),
        command,
        cwd,
        status: "running",
        startedAt: Date.now(),
        output: "",
        timeout: params.timeout && params.timeout > 0 ? params.timeout : undefined,
      };
      jobs.set(jobId, job);
      persistJob(job);
      startJob(job, ctx);
      updateWidget(ctx);

      return {
        content: [
          {
            type: "text",
            text:
              `Started bash job "${job.label}" (id: ${jobId}, pid: ${live.get(jobId)?.pid ?? "?"}) in the background. ` +
              `It runs detached — you are NOT blocked. Keep working or end your turn. ` +
              `When it exits you'll get a '[bash-job ${jobId} ...]' message automatically; do not sleep or poll. ` +
              `Then call bash_output with jobId "${jobId}" to read its output.`,
          },
        ],
        details: { jobId, label: job.label, pid: live.get(jobId)?.pid },
      };
    },
  });

  // ── Tool: bash_jobs (list all jobs this session) ──────────────────
  pi.registerTool({
    name: "bash_jobs",
    label: "Bash Jobs",
    description:
      "List all background bash jobs in this session with their id, label, status, exit code, and timing. " +
      "Use this to find a job's id before calling bash_output or bash_abort. " +
      "Do NOT call this in a loop to wait for a job to finish — the '[bash-job <id> ...]' notification arrives on its own.",
    promptSnippet: "List background bash jobs and their status",
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<Record<string, unknown>>> {
      const all = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
      if (all.length === 0) {
        return {
          content: [{ type: "text", text: "No bash jobs in this session yet." }],
          details: { count: 0 },
        };
      }
      const lines = all.map((j) => {
        const dur = jobDuration(j);
        const code = j.exitCode !== undefined ? ` exit ${j.exitCode}` : "";
        return `${statusIcon[j.status]} ${j.jobId}  "${j.label}"  [${j.status}${code}]  ${dur}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: all.length },
      };
    },
  });

  // ── Tool: bash_output (read captured output by id) ──────────────────
  pi.registerTool({
    name: "bash_output",
    label: "Bash Output",
    description:
      "Read the captured output of a background bash job by its id. Works while the job is still running and after it exits. " +
      "By default returns the full captured output; pass `tail` to return only the last N lines.",
    promptSnippet: "Read a background bash job's captured output by id",
    parameters: Type.Object({
      jobId: Type.String({ description: "The bash job id (from bash_async or the notification)." }),
      tail: Type.Optional(
        Type.Number({ description: "If set, return only the last N lines of output." }),
      ),
    }),
    async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const job = jobs.get(params.jobId);
      if (!job) {
        return {
          content: [
            {
              type: "text",
              text: `No bash job found with id "${params.jobId}". Use bash_jobs to see ids.`,
            },
          ],
          details: { found: false },
        };
      }
      let output = job.output;
      if (params.tail && params.tail > 0) {
        const lines = output.split("\n");
        if (lines.length > params.tail) output = lines.slice(-params.tail).join("\n");
      }
      const dur = jobDuration(job);
      const header =
        `Bash job "${job.label}" (id: ${job.jobId}) — status: ${job.status}` +
        `${job.exitCode !== undefined ? `, exit ${job.exitCode}` : ""}, ${dur}.` +
        `${job.truncated ? ` (inline output truncated to last ${Math.round(MAX_INLINE_BYTES / 1024)}KB; full log at ${job.logPath})` : ""}` +
        `${job.error ? `\nError: ${job.error}` : ""}`;
      return {
        content: [{ type: "text", text: `${header}\n\n${output || "(no output yet)"}` }],
        details: {
          found: true,
          status: job.status,
          exitCode: job.exitCode,
          truncated: job.truncated ?? false,
          logPath: job.logPath,
        },
      };
    },
  });

  // ── Tool: bash_abort (kill a running job) ──────────────────
  pi.registerTool({
    name: "bash_abort",
    label: "Bash Abort",
    description:
      "Abort a running background bash job by its id. Kills the process tree (SIGTERM then SIGKILL). " +
      "Any partial output stays readable via bash_output. No effect if the job is not running.",
    promptSnippet: "Abort a running background bash job by id",
    parameters: Type.Object({
      jobId: Type.String({ description: "The bash job id to abort." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const job = jobs.get(params.jobId);
      if (!job) {
        return {
          content: [
            {
              type: "text",
              text: `No bash job found with id "${params.jobId}". Use bash_jobs to see ids.`,
            },
          ],
          details: { found: false },
        };
      }
      const handle = live.get(job.jobId);
      if (!handle || job.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: `Bash job "${job.label}" (${job.jobId}) is not running (status: ${job.status}).`,
            },
          ],
          details: { found: true, running: false },
        };
      }
      handle.aborted = true;
      if (handle.pid) killProcessTree(handle.pid);
      updateWidget(ctx);
      return {
        content: [
          {
            type: "text",
            text:
              `Aborting bash job "${job.label}" (${job.jobId}). The process tree is being stopped; ` +
              `partial output stays readable via bash_output. ` +
              `You'll get a '[bash-job ${job.jobId} aborted]' notification shortly.`,
          },
        ],
        details: { found: true, aborted: true },
      };
    },
  });

  // ── Viewer overlay (Ctrl+Shift+B) ─────────────────────────────────────────
  pi.registerShortcut(VIEW_SHORTCUT, {
    description: "Open background bash jobs view",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const list = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
      if (list.length === 0) {
        ctx.ui.notify("No bash jobs in this session.", "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const view = new BashJobViewer(list, theme, tui, done);
          renderViewer = () => tui.requestRender();
          return view;
        },
        {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
        },
      );
      renderViewer = undefined;
    },
  });

  // ── Session restore: load bash-job entries from disk into memory ──────────────
  pi.on("session_start", async (_event, ctx) => {
    stale = false; // fresh (or resumed) session: the runner is live again
    jobs.clear();
    live.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === JOB_ENTRY_TYPE) {
        const data = entry.data as BashJob | undefined;
        if (data && typeof data.jobId === "string") {
          const restored: BashJob = { ...data };
          // A job still "running" at restore time is a dead process (the
          // detached child did not survive the previous pi instance).
          if (restored.status === "running") {
            restored.status = "failed";
            restored.error = restored.error ?? "interrupted (session restored)";
          }
          restored.output = typeof restored.output === "string" ? restored.output : "";
          restored.label = restored.label || toLabel(restored.command || restored.jobId, LABEL_MAX);
          jobs.set(restored.jobId, restored);
        }
      }
    }
    updateWidget(ctx);
  });

  // ── Abort all running jobs on teardown ───────────────────────────────────
  // Note: reload/switch emit session_shutdown, but a host that calls session.dispose()
  // directly (e.g. pi-gui's idle reap / tab close) does not — withHost is the safety net
  // for that path, killing the jobs the first time a stale host write is attempted.
  pi.on("session_shutdown", async () => {
    stale = true;
    killAllJobs();
  });
}

// ─── Viewer component ───────────────────────────────────────────────────────────

const statusIcon: Record<JobStatus, string> = {
  running: "⏳",
  done: "✅",
  failed: "❌",
  aborted: "🛑",
};

class BashJobViewer implements Focusable {
  focused = false;
  private mode: "list" | "detail" = "list";
  private selected = 0;
  private scroll = 0;
  private listScroll = 0;

  constructor(
    private jobs: BashJob[],
    private theme: Theme,
    private tui: TUI,
    private done: (r: void) => void,
  ) {}

  private get pageStep(): number {
    return Math.max(3, this.rows - 4);
  }

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
      const last = this.jobs.length - 1;
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
      const page = this.pageStep;
      if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, "down") || data === "j") this.scroll += 1;
      else if (matchesKey(data, "pageUp") || data === "b")
        this.scroll = Math.max(0, this.scroll - page);
      else if (matchesKey(data, "pageDown") || data === " ") this.scroll += page;
      else if (data === "g" || matchesKey(data, "home")) this.scroll = 0;
      else if (data === "G" || matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER;
    }
  }

  private renderList(innerW: number): string[] {
    const th = this.theme;
    const rows = this.rows;
    const header = [
      th.fg("accent", " ⚙ Background bash jobs") + th.fg("dim", `  (${this.jobs.length})`),
      "",
    ];
    const footer = th.fg(
      "dim",
      ` ↑↓/jk select · space/b page · g/G ends · Enter open · Esc/${formatKeyLabel(VIEW_SHORTCUT)} close`,
    );
    const viewport = Math.max(2, rows - header.length - 1);
    const rowsPerItem = 2;
    const itemsVisible = Math.max(1, Math.floor(viewport / rowsPerItem));
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    else if (this.selected >= this.listScroll + itemsVisible)
      this.listScroll = this.selected - itemsVisible + 1;
    const maxListScroll = Math.max(0, this.jobs.length - itemsVisible);
    if (this.listScroll > maxListScroll) this.listScroll = maxListScroll;

    const body: string[] = [];
    const end = Math.min(this.jobs.length, this.listScroll + itemsVisible);
    for (let i = this.listScroll; i < end; i++) {
      const j = this.jobs[i];
      const sel = i === this.selected;
      const prefix = sel ? th.fg("accent", " ▶ ") : "   ";
      const dur = jobDuration(j);
      const code = j.exitCode !== undefined ? ` · exit ${j.exitCode}` : "";
      const titleMax = Math.max(12, innerW - 12);
      const title = j.label.length > titleMax ? `${j.label.slice(0, titleMax)}…` : j.label;
      const head = `${statusIcon[j.status]} ${title}`;
      body.push(`${prefix}${sel ? th.fg("text", head) : th.fg("muted", head)}`);
      body.push(`   ${th.fg("dim", `${j.status} · ${dur}${code} · ${shortenPath(j.cwd)}`)}`);
    }

    const lines = [...header, ...body];
    while (lines.length < rows - 1) lines.push("");
    lines.push(footer);
    return lines.map((l) => truncateToWidth(` ${l}`, innerW + 2));
  }

  private renderDetail(innerW: number): string[] {
    const th = this.theme;
    const rows = this.rows;
    const j = this.jobs[this.selected];
    const head: string[] = [];
    head.push(
      th.fg("accent", ` ${statusIcon[j.status]} ${j.label}`) +
        th.fg(
          "dim",
          `  (${j.jobId} · ${j.status}${j.exitCode !== undefined ? ` · exit ${j.exitCode}` : ""})`,
        ),
    );
    head.push(th.fg("dim", ` $ ${j.command}`));
    if (j.error) head.push(th.fg("error", ` Error: ${j.error}`));
    head.push(th.fg("dim", ` ${"─".repeat(Math.max(4, innerW - 2))}`));

    const body: string[] = [];
    const text = j.output || "(no output)";
    for (const raw of text.split("\n")) {
      for (const w of wrapTextWithAnsi(raw, innerW - 2)) body.push(` ${th.fg("muted", w)}`);
    }
    if (j.truncated) {
      body.unshift(th.fg("dim", ` (inline output truncated; full log at ${j.logPath ?? "n/a"})`));
    }

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

// Make a raw key like VIEW_SHORTCUT human-readable (ctrl+b → Ctrl+B).
function formatKeyLabel(key: string): string {
  return key
    .split("+")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("+");
}

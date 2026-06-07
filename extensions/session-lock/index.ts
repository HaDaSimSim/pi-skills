// Session lock extension for the pi (TUI/CLI) side.
//
// Responsibilities:
//   - When a session opens (session_start), place an exclusive lock on that session file.
//   - Before every message/tool execution, check whether the lock is still mine.
//       If it's my lock, proceed. If it's not (someone took it over or the lock vanished), block + downgrade to read-only.
//   - When the session closes (session_shutdown), release the lock.
//
// Because this extension uses the "same protocol (SessionLock)" as pi-web,
// pi-web recognizes a session opened in the TUI, and vice versa.
//
// Install: ~/.pi/agent/extensions/session-lock/index.ts
//       (place this file alongside shared/session-lock.ts, or inline it at build time)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type LockRecord, SessionLock } from "./shared/session-lock.ts";

export default function (pi: ExtensionAPI) {
  // Don't apply a session lock in child subagent processes (`pi -p`, subagent sessions).
  // Children run in the ~/.pi/agent/.subagent-sessions/ directory, so the web or another TUI
  // will never grab that session. The lock would only leave unnecessary lock-file noise.
  // The subagents extension sets PI_SUBAGENT=1 in the child env.
  if (process.env.PI_SUBAGENT) return;

  // In a runtime launched by a pi-web/pi-gui host, the host already manages the
  // SessionLock directly (owner="pi-web"). If this extension also locks the same file,
  // there would be two holders, leading to the self-contradiction of blocking that
  // runtime's own tools as "held elsewhere". When the host sets PI_WEB_HOST=1, bail out here.
  if (process.env.PI_WEB_HOST) return;

  let lock: SessionLock | null = null;

  const fmtOwner = (r?: LockRecord) =>
    r ? `${r.label || r.owner} (pid ${r.pid}${r.host ? ` @ ${r.host}` : ""})` : "unknown";

  // The other footer text (cwd/tokens/model) is all dim-colored, so match that.
  const setLockStatus = (
    ctx: {
      ui: {
        theme: { fg: (c: string, s: string) => string };
        setStatus: (k: string, t: string | undefined) => void;
      };
    },
    text: string,
  ) => ctx.ui.setStatus("session-lock", ctx.ui.theme.fg("dim", text));

  // Session opened: try to acquire the lock
  pi.on("session_start", async (_event, ctx) => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path) return; // ephemeral sessions have no file, so no lock is needed

    const name = ctx.sessionManager.getSessionName?.();
    lock = new SessionLock(path, "pi", name ? `TUI: ${name}` : "TUI");

    const { acquired, current } = lock.tryAcquire();
    if (acquired) {
      setLockStatus(ctx, "🔓 owned");
      return;
    }

    // Already held by another side (another TUI / pi-web).
    setLockStatus(ctx, "🔒 read-only (locked elsewhere)");
    const force = ctx.hasUI
      ? await ctx.ui.confirm(
          "Session locked",
          `This session is already held by ${fmtOwner(current)}.\n` +
            `Force takeover? (the other side will be downgraded to read-only)`,
        )
      : false;
    if (force) {
      lock.takeover();
      setLockStatus(ctx, "🔓 owned (forced)");
      ctx.ui.notify("Forced takeover of the lock.", "warning");
    } else {
      ctx.ui.notify("Read-only mode. You cannot send messages.", "warning");
    }
  });

  // Message guard: check the lock right when the user submits input. This is
  // the real enforcement point — the `input` event can consume the input
  // (action: "handled") so it never reaches the agent or this session file.
  // (before_agent_start cannot cancel; it can only patch the prompt.)
  pi.on("input", async (event, ctx) => {
    if (!lock) return;
    // Let extension-injected messages through; only guard real user input.
    if (event.source === "extension") return;
    if (lock.isMine()) return; // proceed

    // It's not my lock — either never acquired (read-only) or acquired and then lost.
    const st = lock.state();
    if (st.state === "lost" && st.record) {
      setLockStatus(ctx, "🔒 lost (taken over)");
      ctx.ui.notify(
        `This session was taken over by ${fmtOwner(st.record)}. Switching to read-only.`,
        "error",
      );
    } else {
      setLockStatus(ctx, "🔒 read-only");
      ctx.ui.notify("No lock held; cannot send messages.", "warning");
    }
    return { action: "handled" as const }; // consume input → not sent to agent
  });

  // Same guard right before tool execution (protects file-modifying tools)
  pi.on("tool_call", async (_event, _ctx) => {
    if (!lock) return;
    if (!lock.isMine()) {
      return { block: true, reason: "No session lock held (held elsewhere)." };
    }
  });

  // /takeover manual command
  pi.registerCommand("takeover", {
    description: "Force-take this session lock (downgrade the other side to read-only)",
    handler: async (_args, ctx) => {
      const path = ctx.sessionManager.getSessionFile();
      if (!path) return;
      if (!lock) lock = new SessionLock(path, "pi", "TUI");
      const { takenFrom } = lock.takeover();
      setLockStatus(ctx, "🔓 owned (forced)");
      ctx.ui.notify(
        takenFrom ? `Took the lock from ${fmtOwner(takenFrom)}.` : "Acquired the lock.",
        "info",
      );
    },
  });

  // Session closed: release the lock
  pi.on("session_shutdown", async (_event, _ctx) => {
    lock?.release();
    lock = null;
  });
}

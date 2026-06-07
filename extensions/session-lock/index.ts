// pi (TUI/CLI) 측 세션 락 extension.
//
// 역할:
//   - 세션이 열리면(session_start) 그 세션 파일에 배타 락을 건다.
//   - "매번 메시지/툴 실행 직전에 락이 나한테 있는지" 확인한다.
//       내 락이면 통과. 내 락이 아니면(누가 탈취했거나 락이 사라짐) 차단 + 읽기전용 강등.
//   - 세션이 닫히면(session_shutdown) 락을 푼다.
//
// 이 extension 이 pi-web 과 "같은 규약(SessionLock)"을 쓰기 때문에,
// TUI 에서 연 세션을 pi-web 이 인식하고, 그 반대도 성립한다.
//
// 설치: ~/.pi/agent/extensions/session-lock/index.ts
//       (이 파일과 shared/session-lock.ts 를 함께 배치하거나, 빌드시 인라인)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type LockRecord, SessionLock } from "./shared/session-lock.ts";

export default function (pi: ExtensionAPI) {
  // 자식 subagent 프로세스(`pi -p`, ꈁ리 세션)에서는 세션락을 걸지 않는다.
  // 자식은 ~/.pi/agent/.subagent-sessions/ ꈁ리 디렉터리에서 돌아 웹이나 다른 TUI 가
  // 그 세션을 잡을 일이 없다. 락은 불필요한 락 파일 노이즈만 남긴다.
  // subagents 익스텐션이 자식 env 에 PI_SUBAGENT=1 을 박는다.
  if (process.env.PI_SUBAGENT) return;

  // pi-web/pi-gui 호스트가 띄운 런타임에서는 호스트가 이미 SessionLock 을 직접
  // 관리한다(owner="pi-web"). 그때 이 익스텐션까지 또 같은 파일에 락을 걸면
  // 두 홀더가 생겨서, 정작 그 런타임의 tool 을 "held elsewhere" 로 차단하는
  // 자가당착에 빠진다. 호스트가 PI_WEB_HOST=1 을 박으면 여기서 빠진다.
  if (process.env.PI_WEB_HOST) return;

  let lock: SessionLock | null = null;

  const fmtOwner = (r?: LockRecord) =>
    r ? `${r.label || r.owner} (pid ${r.pid}${r.host ? ` @ ${r.host}` : ""})` : "unknown";

  // footer 의 다른 텍스트(cwd/토큰/모델)는 모두 dim 색이라 거기 맞춘다.
  const setLockStatus = (
    ctx: {
      ui: {
        theme: { fg: (c: string, s: string) => string };
        setStatus: (k: string, t: string | undefined) => void;
      };
    },
    text: string,
  ) => ctx.ui.setStatus("session-lock", ctx.ui.theme.fg("dim", text));

  // 세션 열림: 락 시도
  pi.on("session_start", async (_event, ctx) => {
    const path = ctx.sessionManager.getSessionFile();
    if (!path) return; // ephemeral 세션은 파일이 없어 락 불필요

    const name = ctx.sessionManager.getSessionName?.();
    lock = new SessionLock(path, "pi", name ? `TUI: ${name}` : "TUI");

    const { acquired, current } = lock.tryAcquire();
    if (acquired) {
      setLockStatus(ctx, "🔓 owned");
      return;
    }

    // 이미 다른 쪽(다른 TUI / pi-web)이 점유 중.
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
    if (lock.isMine()) return; // 통과

    // 내 락이 아니다 — 한번도 안 잡았거나(read-only), 잡았다가 잃었거나(lost).
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

  // 도구 실행 직전에도 동일 가드 (파일 변경 도구 보호)
  pi.on("tool_call", async (_event, _ctx) => {
    if (!lock) return;
    if (!lock.isMine()) {
      return { block: true, reason: "No session lock held (held elsewhere)." };
    }
  });

  // /takeover 수동 명령
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

  // 세션 닫힘: 락 해제
  pi.on("session_shutdown", async (_event, _ctx) => {
    lock?.release();
    lock = null;
  });
}

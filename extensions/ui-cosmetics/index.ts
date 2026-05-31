// UI cosmetics extension — footer 커스텀 + working 경과 시간.
//
// Footer 변경:
//   - context: 퍼센트 대신 현재 토큰 수 (8.2k/200k)
//   - auto-compaction 지점 마커 (184k)
//
// Working 메시지:
//   - 작업 중 경과 시간을 "Working... 3s" / "Working... 2m 15s" 형태로 실시간 표시

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 100000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function resolveReserveTokens(cwd: string): { enabled: boolean; reserve: number } {
  let enabled = true;
  let reserve = 16384;
  const read = (p: string) => {
    try {
      const c = JSON.parse(readFileSync(p, "utf8"))?.compaction;
      if (c && typeof c === "object") {
        if (typeof c.enabled === "boolean") enabled = c.enabled;
        if (typeof c.reserveTokens === "number") reserve = c.reserveTokens;
      }
    } catch {
      // 없거나 깨진 파일은 무시
    }
  };
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) read(join(home, ".pi", "agent", "settings.json"));
  read(join(cwd, ".pi", "settings.json"));
  return { enabled, reserve };
}

// ─── Extension ─────────────────────────────────────────────────────────────

const META_TYPE = "turn-meta";

export default function (pi: ExtensionAPI) {
  // working 경과 시간
  let workStartTime = 0;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let workingCtx: { ui: { setWorkingMessage: (m?: string) => void } } | undefined;
  let requestRender: (() => void) | undefined;

  // 응답 메타데이터: agent_end 에서 저장, before_agent_start 에서 세션 삽입
  let pendingMeta: { content: string; details: unknown } | undefined;
  // footer 에 표시할 마지막 메타 (항상 유지)
  let lastMeta: { model: string; elapsed: number } | undefined;

  pi.on("turn_start", (event, ctx) => {
    if (event.turnIndex === 0) {
      workStartTime = Date.now();
      workingCtx = ctx;
      lastMeta = undefined; // 새 턴 시작하면 이전 메타 숨김
      requestRender?.();
      if (!workingTimer) {
        workingTimer = setInterval(() => {
          if (workStartTime > 0 && workingCtx) {
            const sec = (Date.now() - workStartTime) / 1000;
            workingCtx.ui.setWorkingMessage(`Working... ${formatDuration(sec)}`);
          }
        }, 1000);
      }
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    // 메타데이터 저장 (다음 before_agent_start 에서 세션 삽입 + footer 에 즉시 표시)
    if (workStartTime > 0) {
      const elapsed = (Date.now() - workStartTime) / 1000;
      const model = ctx.model?.id || "unknown";
      const content = `${model} · ${formatDuration(elapsed)}`;
      pendingMeta = { content, details: { elapsed, model } };
      lastMeta = { model, elapsed };
      requestRender?.(); // footer 즉시 갱신
    }

    workStartTime = 0;
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = undefined;
    }
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
  });

  // 다음 턴 시작 직전에 이전 메타를 삽입. 이 시점은 확실히 idle 이라
  // sendMessage 가 steer 로 빠지지 않아 루프가 안 생긴다.
  pi.on("before_agent_start", () => {
    if (pendingMeta) {
      pi.sendMessage(
        { customType: META_TYPE, content: pendingMeta.content, display: true, details: pendingMeta.details },
        { triggerTurn: false },
      );
      pendingMeta = undefined;
    }
  });

  // LLM context 에서 메타데이터 메시지 제거
  pi.on("context", (event) => {
    return {
      messages: event.messages.filter(
        (m) => !(m.role === "custom" && (m as { customType?: string }).customType === META_TYPE),
      ),
    };
  });

  // 메타데이터 렌더러
  pi.registerMessageRenderer(META_TYPE, (message, _options, theme) => {
    return new Text(theme.fg("dim", `  ${message.content}`), 0, 0);
  });

  // ─── Footer ────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    // reload/resume 시 세션에서 마지막 메타를 복원
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type: string; customType?: string; details?: { model?: string; elapsed?: number } };
      if (e.type === "custom_message" && e.customType === META_TYPE && e.details?.elapsed) {
        lastMeta = { model: e.details.model || "unknown", elapsed: e.details.elapsed };
        break;
      }
    }

    const compaction = resolveReserveTokens(ctx.sessionManager.getCwd());

    ctx.ui.setFooter((_tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => _tui.requestRender());
      requestRender = () => _tui.requestRender();
      return {
        dispose() { unsub(); },
        invalidate() {},
        render(width: number): string[] {
          // 토큰/코스트 누적
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const u = (entry.message as AssistantMessage).usage;
              totalInput += u.input;
              totalOutput += u.output;
              totalCacheRead += u.cacheRead;
              totalCacheWrite += u.cacheWrite;
              totalCost += u.cost.total;
            }
          }

          // context
          const usage = ctx.getContextUsage();
          const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const tokens = usage?.tokens ?? null;
          const { enabled: autoCompact, reserve } = compaction;
          const compactAt = window > 0 ? window - reserve : 0;
          const dangerPct = autoCompact && compactAt > 0 && tokens !== null ? (tokens / compactAt) * 100 : (usage?.percent ?? 0);
          const ctxText = tokens === null ? `?/${formatTokens(window)}` : `${formatTokens(tokens)}/${formatTokens(window)}`;
          const ctxColored = dangerPct > 95 ? theme.fg("error", ctxText) : dangerPct > 80 ? theme.fg("warning", ctxText) : ctxText;
          const compactMarker = autoCompact && compactAt > 0 && compactAt < window ? ` (${formatTokens(compactAt)})` : "";

          // 좌측 stats
          const stats: string[] = [];
          if (totalInput) stats.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) stats.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) stats.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) stats.push(`W${formatTokens(totalCacheWrite)}`);
          const usingSub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSub) stats.push(`$${totalCost.toFixed(3)}${usingSub ? " (sub)" : ""}`);
          stats.push(ctxColored + theme.fg("dim", compactMarker));
          const left = stats.join(" ");
          const leftW = visibleWidth(left);

          // 우측 모델명 + thinking level
          let right = ctx.model?.id || "no-model";
          if (ctx.model?.reasoning) {
            const level = pi.getThinkingLevel() || "off";
            right = level === "off" ? `${right} • thinking off` : `${right} • ${level}`;
          }
          const rightW = visibleWidth(right);

          // pwd + git branch + session name
          let pwd = ctx.sessionManager.getCwd().replace(process.env.HOME || "~", "~");
          const branch = footerData.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const name = ctx.sessionManager.getSessionName();
          if (name) pwd += ` • ${name}`;

          // 조립
          const pad = " ".repeat(Math.max(2, width - leftW - rightW));
          const statsLine = theme.fg("dim", left) + theme.fg("dim", pad + right);
          const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
          const lines = [pwdLine, statsLine];

          // extension statuses + 마지막 메타 (세 번째 줄)
          const statuses = footerData.getExtensionStatuses();
          const statusParts: string[] = [];
          if (statuses.size > 0) {
            const sorted = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, t]) => t.replace(/[\r\n\t]+/g, " ").trim());
            statusParts.push(...sorted);
          }
          if (statusParts.length > 0 || lastMeta) {
            const leftPart = statusParts.join(" ");
            // 모델이 바뀌었으면 모델명 포함, 같으면 시간만
            let metaText = "";
            if (lastMeta) {
              const showModel = lastMeta.model !== (ctx.model?.id || "");
              metaText = showModel ? `${lastMeta.model} · ${formatDuration(lastMeta.elapsed)}` : formatDuration(lastMeta.elapsed);
            }
            const rightPart = metaText ? theme.fg("dim", metaText) : "";
            const leftPartW = visibleWidth(leftPart);
            const rightPartW = visibleWidth(rightPart);
            if (leftPart && rightPart) {
              const gap = " ".repeat(Math.max(2, width - leftPartW - rightPartW));
              lines.push(truncateToWidth(leftPart + gap + rightPart, width, theme.fg("dim", "...")));
            } else if (leftPart) {
              lines.push(truncateToWidth(leftPart, width, theme.fg("dim", "...")));
            } else {
              const metaPad = " ".repeat(Math.max(0, width - rightPartW));
              lines.push(truncateToWidth(metaPad + rightPart, width));
            }
          }
          return lines;
        },
      };
    });
  });
}

// UI cosmetics extension — footer customization + working elapsed time.
//
// Footer changes:
//   - context: current token count instead of percentage (8.2k/200k)
//   - auto-compaction point marker (184k)
//
// Working message:
//   - shows elapsed time during work in real time, as "Working... 3s" / "Working... 2m 15s"

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
      // Ignore missing or corrupted files
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
  // working elapsed time
  let workStartTime = 0;
  let workingTimer: ReturnType<typeof setInterval> | undefined;
  let workingCtx: { ui: { setWorkingMessage: (m?: string) => void } } | undefined;
  let requestRender: (() => void) | undefined;

  // Response metadata: saved at agent_end, inserted into the session at before_agent_start
  let pendingMeta: { content: string; details: unknown } | undefined;
  // Last meta to display in the footer (always kept)
  let lastMeta: { model: string; elapsed: number } | undefined;

  pi.on("turn_start", (event, ctx) => {
    if (event.turnIndex === 0) {
      workStartTime = Date.now();
      workingCtx = ctx;
      lastMeta = undefined; // Hide the previous meta when a new turn starts
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
    // Save metadata (inserted into the session at the next before_agent_start + shown immediately in the footer)
    if (workStartTime > 0) {
      const elapsed = (Date.now() - workStartTime) / 1000;
      const model = ctx.model?.id || "unknown";
      const content = `${model} · ${formatDuration(elapsed)}`;
      pendingMeta = { content, details: { elapsed, model } };
      lastMeta = { model, elapsed };
      requestRender?.(); // refresh footer immediately
    }

    workStartTime = 0;
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = undefined;
    }
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
  });

  // Insert the previous meta right before the next turn starts. At this point we're definitely idle,
  // so sendMessage won't fall into steer and no loop is created.
  pi.on("before_agent_start", () => {
    if (pendingMeta) {
      pi.sendMessage(
        {
          customType: META_TYPE,
          content: pendingMeta.content,
          display: true,
          details: pendingMeta.details,
        },
        { triggerTurn: false },
      );
      pendingMeta = undefined;
    }
  });

  // Remove metadata messages from the LLM context
  pi.on("context", (event) => {
    return {
      messages: event.messages.filter(
        (m) => !(m.role === "custom" && (m as { customType?: string }).customType === META_TYPE),
      ),
    };
  });

  // Metadata renderer
  pi.registerMessageRenderer(META_TYPE, (message, _options, theme) => {
    return new Text(theme.fg("dim", `  ${message.content}`), 0, 0);
  });

  // ─── Footer ────────────────────────────────────────────────────────────

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Restore the last meta from the session on reload/resume
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as {
        type: string;
        customType?: string;
        details?: { model?: string; elapsed?: number };
      };
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
        dispose() {
          unsub();
        },
        invalidate() {},
        render(width: number): string[] {
          // Token/cost accumulation
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
          const dangerPct =
            autoCompact && compactAt > 0 && tokens !== null
              ? (tokens / compactAt) * 100
              : (usage?.percent ?? 0);
          const ctxText =
            tokens === null
              ? `?/${formatTokens(window)}`
              : `${formatTokens(tokens)}/${formatTokens(window)}`;
          const ctxColored =
            dangerPct > 95
              ? theme.fg("error", ctxText)
              : dangerPct > 80
                ? theme.fg("warning", ctxText)
                : ctxText;
          const compactMarker =
            autoCompact && compactAt > 0 && compactAt < window
              ? ` (${formatTokens(compactAt)})`
              : "";

          // left-side stats
          const stats: string[] = [];
          if (totalInput) stats.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) stats.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) stats.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) stats.push(`W${formatTokens(totalCacheWrite)}`);
          const usingSub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSub)
            stats.push(`$${totalCost.toFixed(3)}${usingSub ? " (sub)" : ""}`);
          stats.push(ctxColored + theme.fg("dim", compactMarker));
          const left = stats.join(" ");
          const leftW = visibleWidth(left);

          // right-side model name + thinking level
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

          // assemble
          const pad = " ".repeat(Math.max(2, width - leftW - rightW));
          const statsLine = theme.fg("dim", left) + theme.fg("dim", pad + right);
          const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
          const lines = [pwdLine, statsLine];

          // extension statuses + last meta (third line)
          const statuses = footerData.getExtensionStatuses();
          const statusParts: string[] = [];
          if (statuses.size > 0) {
            const sorted = Array.from(statuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, t]) => t.replace(/[\r\n\t]+/g, " ").trim());
            statusParts.push(...sorted);
          }
          if (statusParts.length > 0 || lastMeta) {
            const leftPart = statusParts.join(theme.fg("dim", " • "));
            // Include the model name if the model changed, otherwise just the time
            let metaText = "";
            if (lastMeta) {
              const showModel = lastMeta.model !== (ctx.model?.id || "");
              metaText = showModel
                ? `${lastMeta.model} · ${formatDuration(lastMeta.elapsed)}`
                : formatDuration(lastMeta.elapsed);
            }
            const rightPart = metaText ? theme.fg("dim", metaText) : "";
            const leftPartW = visibleWidth(leftPart);
            const rightPartW = visibleWidth(rightPart);
            if (leftPart && rightPart) {
              const gap = " ".repeat(Math.max(2, width - leftPartW - rightPartW));
              lines.push(
                truncateToWidth(leftPart + gap + rightPart, width, theme.fg("dim", "...")),
              );
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

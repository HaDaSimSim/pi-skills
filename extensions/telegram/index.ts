// Telegram notification extension.
//
// 알림 시점:
//   - agent_end: 일정 시간(기본 30초) 이상 걸린 작업 완료 시
//   - goal:status-change: goal이 achieved/blocked/budget-limited 될 때
//   - questionnaire tool 호출 시: 사용자 입력 대기 알림
//
// 설정: extensions/telegram/.env
//   TELEGRAM_BOT_TOKEN=...
//   TELEGRAM_CHAT_ID=...
//   TELEGRAM_MIN_SECONDS=30  (선택, 기본 30)

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Config ────────────────────────────────────────────────────────────────

interface TelegramConfig {
  botToken: string;
  chatId: string;
  minSeconds: number;
}

function loadConfig(): TelegramConfig | null {
  let botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  let chatId = process.env.TELEGRAM_CHAT_ID || "";
  let minSeconds = 30;

  // .env fallback: resolve symlink to find real dir
  if (!botToken || !chatId) {
    try {
      const realPath = realpathSync(__filename);
      const envPath = join(dirname(realPath), ".env");
      const lines = readFileSync(envPath, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const [key, ...rest] = trimmed.split("=");
        const value = rest.join("=").trim().replace(/^["']|["']$/g, "");
        if (key === "TELEGRAM_BOT_TOKEN" && !botToken) botToken = value;
        if (key === "TELEGRAM_CHAT_ID" && !chatId) chatId = value;
        if (key === "TELEGRAM_MIN_SECONDS") minSeconds = parseInt(value, 10) || 30;
      }
    } catch {
      // .env 없으면 무시
    }
  }

  if (!botToken || !chatId) return null;
  return { botToken, chatId, minSeconds };
}

// ─── Telegram API ──────────────────────────────────────────────────────────

async function sendTelegram(config: TelegramConfig, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    // 네트워크 에러는 조용히 무시 (알림 실패가 작업을 막으면 안 됨)
  }
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  if (!config) return; // 설정 없으면 아무것도 안 함

  let workStartTime = 0;
  let currentCwd = "";
  let currentSessionName = "";

  pi.on("session_start", (_event, ctx) => {
    currentCwd = ctx.sessionManager.getCwd();
    currentSessionName = ctx.sessionManager.getSessionName() || "";
  });

  pi.on("turn_start", (event) => {
    if (event.turnIndex === 0) {
      workStartTime = Date.now();
    }
  });

  // agent_end: 일정 시간 이상이면 알림
  pi.on("agent_end", (_event, ctx) => {
    if (workStartTime === 0) return;
    const elapsed = (Date.now() - workStartTime) / 1000;
    workStartTime = 0;
    if (elapsed < config.minSeconds) return;

    const model = ctx.model?.id || "unknown";
    const project = currentCwd.replace(process.env.HOME || "", "~");
    const mins = Math.floor(elapsed / 60);
    const secs = Math.round(elapsed % 60);
    const dur = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    const session = currentSessionName ? `\n📌 ${currentSessionName}` : "";
    sendTelegram(config, `✅ *Task complete* (${dur})\n📁 ${project}${session}\n🤖 ${model}`);
  });

  // goal 연동: goal extension이 이벤트를 emit하면 받아서 알림
  pi.events.on("goal:status-change", (data) => {
    const { status, objective, note } = data as { status: string; objective: string; note?: string };
    if (status === "achieved") {
      sendTelegram(config, `✅ *Goal achieved*\n🎯 ${objective}\n📝 ${note || ""}`);
    } else if (status === "blocked") {
      sendTelegram(config, `🚧 *Goal blocked*\n🎯 ${objective}\n❓ ${note || ""}`);
    } else if (status === "budget-limited") {
      sendTelegram(config, `⛔ *Budget exceeded*\n🎯 ${objective}\n📝 ${note || ""}`);
    }
  });

  // questionnaire/question tool 호출 시: 사용자 입력 대기 알림
  pi.on("tool_call", (event) => {
    if (event.name === "questionnaire" || event.name === "question") {
      const args = event.input as { questions?: { prompt?: string }[] };
      const firstQ = args?.questions?.[0]?.prompt || "There is a question";
      sendTelegram(config, `❓ *Waiting for input*\n${firstQ}`);
    }
  });
}

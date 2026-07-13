// Telegram notification extension.
//
// Notification triggers:
//   - agent_end: when a task that took at least a certain time (default 30s) completes
//   - ralph:status-change: when a ralph-loop goal becomes achieved/blocked/budget-limited
//   - when the questionnaire tool is called: notify that user input is awaited
//
// Config: extensions/telegram/.env
//   TELEGRAM_BOT_TOKEN=...
//   TELEGRAM_CHAT_ID=...
//   TELEGRAM_MIN_SECONDS=30  (optional, default 30)

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
        const value = rest
          .join("=")
          .trim()
          .replace(/^["']|["']$/g, "");
        if (key === "TELEGRAM_BOT_TOKEN" && !botToken) botToken = value;
        if (key === "TELEGRAM_CHAT_ID" && !chatId) chatId = value;
        if (key === "TELEGRAM_MIN_SECONDS") minSeconds = parseInt(value, 10) || 30;
      }
    } catch {
      // ignore if there's no .env
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
    // silently ignore network errors (a failed notification must not block the task)
  }
}

// Telegram API call (parses the result). Returns null on failure.
interface InlineButton {
  text: string;
  callback_data: string;
}

async function tgCall(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const url = `https://api.telegram.org/bot${config.botToken}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok?: boolean; result?: unknown };
    if (!json.ok) return null;
    return json.result as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Send a message (with inline keyboard options). Returns message_id.
async function tgSend(
  config: TelegramConfig,
  text: string,
  buttons?: InlineButton[][],
): Promise<number | null> {
  const body: Record<string, unknown> = { chat_id: config.chatId, text, parse_mode: "Markdown" };
  if (buttons && buttons.length > 0) body.reply_markup = { inline_keyboard: buttons };
  const result = await tgCall(config, "sendMessage", body);
  return result && typeof result.message_id === "number" ? result.message_id : null;
}

// Edit a message (e.g. to remove buttons).
async function tgEdit(config: TelegramConfig, messageId: number, text: string): Promise<void> {
  await tgCall(config, "editMessageText", {
    chat_id: config.chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [] },
  });
}

// Answer a callback query (toast to the person who pressed the button).
async function tgAnswerCallback(
  config: TelegramConfig,
  callbackId: string,
  text?: string,
): Promise<void> {
  await tgCall(config, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text, show_alert: true } : {}),
  });
}

// Delete a message (used to clean up the user's input message after adding text in multi-select).
async function tgDelete(config: TelegramConfig, messageId: number): Promise<void> {
  await tgCall(config, "deleteMessage", { chat_id: config.chatId, message_id: messageId });
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // In child subagent processes (spawned via `pi -p`), turn telegram off entirely.
  // Otherwise, every time a subagent finishes, we'd react to the child's agent_end
  // and a "Task complete" notification would arrive duplicated with the main one. The
  // subagents extension sets PI_SUBAGENT=1 in the child env.
  if (process.env.PI_SUBAGENT) return;

  const config = loadConfig();
  if (!config) return; // do nothing if there's no config

  let workStartTime = 0;
  let currentCwd = "";
  let currentSessionName = "";

  // pi.events subscriptions must be unsubscribed manually because the EventBus is
  // reused on reload, so listeners don't accumulate as duplicates. Unsubscribe them
  // all at session_shutdown.
  const unsubs: (() => void)[] = [];

  pi.on("session_start", (_event, ctx) => {
    currentCwd = ctx.sessionManager.getCwd();
    currentSessionName = ctx.sessionManager.getSessionName() || "";
  });

  pi.on("turn_start", (event) => {
    if (event.turnIndex === 0) {
      workStartTime = Date.now();
    }
  });

  // agent_end: notify if it took at least the minimum time
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

  // ralph-loop integration: when the ralph-loop extension emits a status-change event, notify
  unsubs.push(
    pi.events.on("ralph:status-change", (data) => {
      const { status, objective, note } = data as {
        status: string;
        objective: string;
        note?: string;
      };
      if (status === "achieved") {
        sendTelegram(config, `✅ *Goal achieved*\n🎯 ${objective}\n📝 ${note || ""}`);
      } else if (status === "blocked") {
        sendTelegram(config, `🚧 *Goal blocked*\n🎯 ${objective}\n❓ ${note || ""}`);
      } else if (status === "budget-limited") {
        sendTelegram(config, `⛔ *Budget exceeded*\n🎯 ${objective}\n📝 ${note || ""}`);
      }
    }),
  );

  // ── Remote question answering (integrated with the question extension via pi.events) ─────
  // When we receive question:ask, send the question over telegram (multiple-choice =
  // buttons, free input = reply), poll for the response via getUpdates, and return it
  // via question:answer.
  // If the local TUI answers first, question:resolved arrives and we clean up
  // (method C: edit the message).
  interface QOption {
    value: string;
    label: string;
    description?: string;
  }
  interface QItem {
    id: string;
    label: string;
    prompt: string;
    options: QOption[];
    multiSelect: boolean;
  }
  interface AskState {
    askId: string;
    short: string; // short id for callback_data
    questions: QItem[];
    idx: number; // current question
    answersByIdx: Map<number, TgAnswer>; // qIdx -> answer (can go back and edit)
    multiSel: Map<number, Set<number>>; // qIdx -> selected option indices (multi-select)
    customTexts: Map<number, string[]>; // qIdx -> free-input texts added in multi-select
    messageId: number | null; // the currently displayed question message
    done: boolean;
  }
  interface TgAnswer {
    id: string;
    value: string;
    label: string;
    wasCustom: boolean;
    index?: number;
    values?: string[];
    labels?: string[];
  }

  const asks = new Map<string, AskState>(); // askId -> state
  const shortToAsk = new Map<string, string>(); // short -> askId
  let polling = false;
  let pollOffset = 0;

  const projectLine = () => {
    const project = currentCwd.replace(process.env.HOME || "", "~");
    const session = currentSessionName ? `\n📌 ${currentSessionName}` : "";
    return `📁 ${project}${session}`;
  };

  // Navigation row (◀ Prev / ▶ Next / ✅ Submit). Attached only for multi-question sets.
  const navRow = (st: AskState, qIdx: number): InlineButton[] => {
    const row: InlineButton[] = [];
    if (qIdx > 0) row.push({ text: "◀ Prev", callback_data: `p:${st.short}:${qIdx}:0` });
    if (qIdx < st.questions.length - 1)
      row.push({ text: "▶ Next", callback_data: `n:${st.short}:${qIdx}:0` });
    row.push({ text: "✅ Submit all", callback_data: `a:${st.short}:${qIdx}:0` });
    return row;
  };

  // Multi-select button rows (toggle state + nav).
  const multiButtons = (st: AskState, qIdx: number): InlineButton[][] => {
    const q = st.questions[qIdx];
    const checked = st.multiSel.get(qIdx) ?? new Set<number>();
    const buttons: InlineButton[][] = q.options.map((opt, oi) => {
      const mark = checked.has(oi) ? "☑ " : "☐ ";
      return [{ text: `${mark}${opt.label}`, callback_data: `q:${st.short}:${qIdx}:${oi}` }];
    });
    if (st.questions.length > 1) buttons.push(navRow(st, qIdx));
    else buttons.push([{ text: "✅ Submit selection", callback_data: `a:${st.short}:${qIdx}:0` }]);
    return buttons;
  };

  // Single-select button rows (selected one marked with ✓ + nav).
  const singleButtons = (st: AskState, qIdx: number): InlineButton[][] => {
    const q = st.questions[qIdx];
    const ans = st.answersByIdx.get(qIdx);
    const buttons: InlineButton[][] = q.options.map((opt, oi) => {
      const mark = ans && !ans.wasCustom && ans.index === oi ? "✓ " : "";
      return [{ text: `${mark}${opt.label}`, callback_data: `q:${st.short}:${qIdx}:${oi}` }];
    });
    if (st.questions.length > 1) buttons.push(navRow(st, qIdx));
    return buttons;
  };

  // Question body (shows progress + current answer state).
  const questionText = (st: AskState, qIdx: number): string => {
    const q = st.questions[qIdx];
    const n = st.questions.length;
    const progress = n > 1 ? ` [${qIdx + 1}/${n}]` : "";
    const ans = st.answersByIdx.get(qIdx);
    const customs = st.customTexts.get(qIdx) ?? [];
    let state = "";
    if (q.multiSelect) {
      if (customs.length > 0) state += `\n✍ added: ${customs.join(", ")}`;
    } else if (ans) {
      state += `\n✓ ${ans.label}`;
    }
    const hint = q.multiSelect
      ? "\n\n_Tap to toggle, reply with text to add._"
      : "\n\n_Tap an option, or reply with text._";
    return `❓ *Waiting for input*${progress}\n${projectLine()}\n\n*${q.prompt}*${state}${hint}`;
  };

  // Send/refresh the current question to telegram (replacing a single message).
  const renderQuestion = async (st: AskState) => {
    const q = st.questions[st.idx];
    if (!q) return;
    const buttons = q.multiSelect ? multiButtons(st, st.idx) : singleButtons(st, st.idx);
    const text = questionText(st, st.idx);
    if (st.messageId != null) {
      await tgCall(config, "editMessageText", {
        chat_id: config.chatId,
        message_id: st.messageId,
        text,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons },
      });
    } else {
      st.messageId = await tgSend(config, text, buttons);
    }
    ensurePolling();
  };

  // Move to the question at the given index (replacing a single message).
  const goTo = async (st: AskState, idx: number) => {
    st.idx = Math.max(0, Math.min(st.questions.length - 1, idx));
    await renderQuestion(st);
  };

  // Check whether all questions are answered; otherwise return the first unanswered index.
  const firstUnanswered = (st: AskState): number => {
    for (let i = 0; i < st.questions.length; i++) if (!st.answersByIdx.has(i)) return i;
    return -1;
  };

  // Reflect the multi-select's current toggles + free input into answersByIdx (remove if nothing selected).
  const syncMultiAnswer = (st: AskState, qIdx: number) => {
    const q = st.questions[qIdx];
    if (!q) return;
    const set = st.multiSel.get(qIdx) ?? new Set<number>();
    const chosen = [...set].sort((a, b) => a - b);
    const opts = chosen.map((i) => q.options[i]).filter(Boolean);
    const customs = st.customTexts.get(qIdx) ?? [];
    const values = [...opts.map((o) => o.value), ...customs];
    const labels = [...opts.map((o) => o.label), ...customs];
    if (values.length === 0) {
      st.answersByIdx.delete(qIdx);
      return;
    }
    st.answersByIdx.set(qIdx, {
      id: q.id,
      value: values[0] ?? "",
      label: labels[0] ?? "",
      wasCustom: opts.length === 0 && customs.length > 0,
      values,
      labels,
    });
  };

  // Submit: if there are unanswered questions, block and move to that question; otherwise emit question:answer.
  const submitAll = async (st: AskState, cbId: string) => {
    const missing = firstUnanswered(st);
    if (missing >= 0) {
      await tgAnswerCallback(config, cbId, `Q${missing + 1} is not answered yet.`);
      await goTo(st, missing);
      return;
    }
    await tgAnswerCallback(config, cbId);
    st.done = true;
    const answers = st.questions.map((_, i) => st.answersByIdx.get(i)!).filter(Boolean);
    if (st.messageId != null) await tgEdit(config, st.messageId, "✅ _Submitted. Thanks!_");
    pi.events.emit("question:answer", { askId: st.askId, answers, cancelled: false });
    // After emit, question returns question:resolved, so cleanup happens there.
  };

  // Multiple-choice single select: save the answer then auto-advance (stay if last). If single question, submit immediately.
  const pickSingle = async (st: AskState, qIdx: number, optIdx: number) => {
    const q = st.questions[qIdx];
    const opt = q?.options[optIdx];
    if (!q || !opt) return;
    st.answersByIdx.set(qIdx, {
      id: q.id,
      value: opt.value,
      label: opt.label,
      wasCustom: false,
      index: optIdx,
    });
    if (st.questions.length === 1) {
      st.done = true;
      if (st.messageId != null)
        await tgEdit(config, st.messageId, `✅ *${q.prompt}*\n→ ${opt.label}`);
      pi.events.emit("question:answer", {
        askId: st.askId,
        answers: [st.answersByIdx.get(0)!],
        cancelled: false,
      });
      return;
    }
    if (qIdx < st.questions.length - 1) await goTo(st, qIdx + 1);
    else await renderQuestion(st); // last question: stay and refresh the selection display
  };

  // Multi-select toggle.
  const toggleMulti = async (st: AskState, qIdx: number, optIdx: number, cbId: string) => {
    const set = st.multiSel.get(qIdx) ?? new Set<number>();
    if (set.has(optIdx)) set.delete(optIdx);
    else set.add(optIdx);
    st.multiSel.set(qIdx, set);
    syncMultiAnswer(st, qIdx);
    await tgAnswerCallback(config, cbId);
    if (st.messageId != null) {
      await tgCall(config, "editMessageReplyMarkup", {
        chat_id: config.chatId,
        message_id: st.messageId,
        reply_markup: { inline_keyboard: multiButtons(st, qIdx) },
      });
    }
  };

  // Free-text response.
  //  - multi-select: add the custom value to the selection list, refresh answersByIdx, stay.
  //  - single: save as the custom answer then auto-advance (submit immediately if single question).
  const answerText = async (st: AskState, text: string, srcMsgId?: number) => {
    const q = st.questions[st.idx];
    if (!q) return;
    const qIdx = st.idx;
    if (q.multiSelect) {
      const arr = st.customTexts.get(qIdx) ?? [];
      arr.push(text);
      st.customTexts.set(qIdx, arr);
      syncMultiAnswer(st, qIdx);
      // If something was added, delete the text message the user sent to keep the chat clean.
      if (srcMsgId != null) await tgDelete(config, srcMsgId);
      await renderQuestion(st);
      return;
    }
    st.answersByIdx.set(qIdx, { id: q.id, value: text, label: text, wasCustom: true });
    if (st.questions.length === 1) {
      st.done = true;
      if (st.messageId != null) await tgEdit(config, st.messageId, `✅ *${q.prompt}*\n→ ${text}`);
      pi.events.emit("question:answer", {
        askId: st.askId,
        answers: [st.answersByIdx.get(0)!],
        cancelled: false,
      });
      return;
    }
    if (qIdx < st.questions.length - 1) await goTo(st, qIdx + 1);
    else await renderQuestion(st);
  };

  // Find an ask by message id (for reply-based routing).
  const askByMessageId = (messageId: number): AskState | undefined => {
    for (const st of asks.values()) if (!st.done && st.messageId === messageId) return st;
    return undefined;
  };

  // Number of pending asks (used to decide the fallback for text without a reply).
  const pendingAsks = (): AskState[] => [...asks.values()].filter((s) => !s.done);

  let pollInitialized = false;

  const ensurePolling = () => {
    if (polling) return;
    polling = true;
    void pollLoop();
  };

  // Before the first poll, skip any updates already accumulated (past messages/callbacks).
  // offset:-1 returns only the last update → receive from after that.
  const initOffset = async () => {
    if (pollInitialized) return;
    pollInitialized = true;
    const result = await tgCall(config, "getUpdates", { offset: -1, timeout: 0 });
    const updates = (result as unknown as { update_id: number }[] | null) ?? [];
    if (Array.isArray(updates) && updates.length > 0) {
      pollOffset = updates[updates.length - 1].update_id + 1;
    }
  };

  const pollLoop = async () => {
    await initOffset();
    while ([...asks.values()].some((s) => !s.done)) {
      const result = await tgCall(config, "getUpdates", { offset: pollOffset, timeout: 25 });
      const updates = (result as unknown as { update_id: number }[] | null) ?? [];
      if (!Array.isArray(updates)) continue;
      for (const u of updates as Record<string, unknown>[]) {
        pollOffset = (u.update_id as number) + 1;
        await handleUpdate(u);
      }
    }
    polling = false;
  };

  const handleUpdate = async (u: Record<string, unknown>) => {
    // Callback query (button)
    const cq = u.callback_query as Record<string, unknown> | undefined;
    if (cq) {
      const from = (cq.message as Record<string, unknown>)?.chat as
        | Record<string, unknown>
        | undefined;
      const chatId = String(from?.id ?? "");
      const cbId = String(cq.id ?? "");
      const dataStr = String(cq.data ?? "");
      if (chatId !== String(config.chatId)) {
        await tgAnswerCallback(config, cbId);
        return;
      }
      const [kind, short, qIdxS, optIdxS] = dataStr.split(":");
      const askId = shortToAsk.get(short);
      const st = askId ? asks.get(askId) : undefined;
      if (!st || st.done) {
        await tgAnswerCallback(config, cbId, "This question is already closed.");
        return;
      }
      const qIdx = parseInt(qIdxS, 10);
      const optIdx = parseInt(optIdxS, 10);
      const q = st.questions[qIdx];
      if (kind === "a") {
        await submitAll(st, cbId);
      } else if (kind === "n") {
        await tgAnswerCallback(config, cbId);
        await goTo(st, qIdx + 1);
      } else if (kind === "p") {
        await tgAnswerCallback(config, cbId);
        await goTo(st, qIdx - 1);
      } else if (kind === "q" && q?.multiSelect) {
        await toggleMulti(st, qIdx, optIdx, cbId);
      } else if (kind === "q") {
        await tgAnswerCallback(config, cbId);
        await pickSingle(st, qIdx, optIdx);
      } else {
        await tgAnswerCallback(config, cbId);
      }
      return;
    }
    // Regular message (text reply)
    const msg = u.message as Record<string, unknown> | undefined;
    if (msg) {
      const chat = msg.chat as Record<string, unknown> | undefined;
      if (String(chat?.id ?? "") !== String(config.chatId)) return;
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text || text.startsWith("/")) return;
      const msgId = typeof msg.message_id === "number" ? msg.message_id : undefined;
      // Only allow reply-based routing: the user must reply to a specific question message to be recognized.
      // If there's no reply, we can't tell which question it is, so ignore it (just guide).
      const reply = msg.reply_to_message as Record<string, unknown> | undefined;
      const replyId = reply && typeof reply.message_id === "number" ? reply.message_id : undefined;
      if (replyId == null) {
        if (pendingAsks().length > 0) {
          // Delete the guide message + the user's original text shortly after to keep the chat clean.
          const noticeId = await tgSend(
            config,
            "❗ To answer with text, *reply* to the specific question message.",
          );
          setTimeout(() => {
            if (noticeId != null) void tgDelete(config, noticeId);
            if (msgId != null) void tgDelete(config, msgId);
          }, 4000);
        }
        return;
      }
      const st = askByMessageId(replyId);
      if (st) await answerText(st, text, msgId);
    }
  };

  // question:ask — receive a new question set.
  unsubs.push(
    pi.events.on("question:ask", (data) => {
      const payload = data as { askId?: string; questions?: QItem[] };
      if (!payload?.askId || !Array.isArray(payload.questions) || payload.questions.length === 0)
        return;
      const short = payload.askId.slice(-8);
      const st: AskState = {
        askId: payload.askId,
        short,
        questions: payload.questions,
        idx: 0,
        answersByIdx: new Map(),
        multiSel: new Map(),
        customTexts: new Map(),
        messageId: null,
        done: false,
      };
      asks.set(payload.askId, st);
      shortToAsk.set(short, payload.askId);
      void renderQuestion(st);
    }),
  );

  // question:resolved — the local TUI answered first or it was cancelled. Method C cleanup.
  unsubs.push(
    pi.events.on("question:resolved", (data) => {
      const payload = data as { askId?: string };
      const st = payload?.askId ? asks.get(payload.askId) : undefined;
      if (!st) return;
      // If it didn't end because we emitted (= local won), clean up the displayed message.
      if (!st.done && st.messageId != null) {
        void tgEdit(config, st.messageId, "✅ _Answered in terminal. This question is closed._");
      }
      st.done = true;
      asks.delete(st.askId);
      shortToAsk.delete(st.short);
    }),
  );

  // On reload/shutdown, unsubscribe (the EventBus is reused, so prevent listener accumulation).
  pi.on("session_shutdown", () => {
    for (const off of unsubs.splice(0)) off();
  });
}

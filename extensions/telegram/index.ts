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

// 텔레그램 API 호출 (결과 파싱). 실패 시 null.
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

// 메시지 전송 (inline 키보드 선택). message_id 반환.
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

// 메시지 편집 (버튼 제거 등).
async function tgEdit(config: TelegramConfig, messageId: number, text: string): Promise<void> {
  await tgCall(config, "editMessageText", {
    chat_id: config.chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [] },
  });
}

// 콜백 쿼리 응답 (버튼 누른 사람에게 토스트).
async function tgAnswerCallback(config: TelegramConfig, callbackId: string, text?: string): Promise<void> {
  await tgCall(config, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text, show_alert: true } : {}),
  });
}

// 메시지 삭제 (멀티셀렉트에 텍스트 추가 후 사용자 입력 메시지 정리용).
async function tgDelete(config: TelegramConfig, messageId: number): Promise<void> {
  await tgCall(config, "deleteMessage", { chat_id: config.chatId, message_id: messageId });
}


// ─── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // 자식 subagent 프로세스(`pi -p` 로 spawn)에서는 telegram 을 완전히 끕다.
  // 없으면 subagent 가 끝날 때마다 자식의 agent_end 에 반응해 "Task complete" 알림이
  // 메인 알림과 이중으로 온다. subagents 익스텐션이 자식 env 에 PI_SUBAGENT=1 을 박는다.
  if (process.env.PI_SUBAGENT) return;

  const config = loadConfig();
  if (!config) return; // 설정 없으면 아무것도 안 함

  let workStartTime = 0;
  let currentCwd = "";
  let currentSessionName = "";

  // pi.events 구독은 reload 시 EventBus 가 재사용되므로 수동으로 해제해야
  // 리스너가 중복 누적되지 않는다. session_shutdown 에서 일괄 해제.
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
  unsubs.push(pi.events.on("goal:status-change", (data) => {
    const { status, objective, note } = data as { status: string; objective: string; note?: string };
    if (status === "achieved") {
      sendTelegram(config, `✅ *Goal achieved*\n🎯 ${objective}\n📝 ${note || ""}`);
    } else if (status === "blocked") {
      sendTelegram(config, `🚧 *Goal blocked*\n🎯 ${objective}\n❓ ${note || ""}`);
    } else if (status === "budget-limited") {
      sendTelegram(config, `⛔ *Budget exceeded*\n🎯 ${objective}\n📝 ${note || ""}`);
    }
  }));

  // ── 원격 질문 응답 (question 익스텐션과 pi.events 로 연동) ─────────────
  // question:ask 를 받으면 텔레그램으로 질문을 보내고(객관식=버튼, 자유입력=답장),
  // getUpdates 폴링로 응답을 받아 question:answer 로 돌려준다.
  // 로컬 TUI 가 먼저 답하면 question:resolved 가 와서 정리한다(방식 C: 메시지 편집).
  interface QOption { value: string; label: string; description?: string }
  interface QItem { id: string; label: string; prompt: string; options: QOption[]; multiSelect: boolean }
  interface AskState {
    askId: string;
    short: string; // callback_data 용 짧은 id
    questions: QItem[];
    idx: number; // 현재 질문
    answersByIdx: Map<number, TgAnswer>; // qIdx -> 답변 (되돌아가 수정 가능)
    multiSel: Map<number, Set<number>>; // qIdx -> 선택된 옵션 인덱스(멀티셀렉트)
    customTexts: Map<number, string[]>; // qIdx -> 멀티셀렉트에서 추가한 자유입력들
    messageId: number | null; // 현재 떠 있는 질문 메시지
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

  // 네비게이션 행 (◀ Prev / ▶ Next / ✅ Submit). 멀티 질문일 때만 붙인다.
  const navRow = (st: AskState, qIdx: number): InlineButton[] => {
    const row: InlineButton[] = [];
    if (qIdx > 0) row.push({ text: "◀ Prev", callback_data: `p:${st.short}:${qIdx}:0` });
    if (qIdx < st.questions.length - 1) row.push({ text: "▶ Next", callback_data: `n:${st.short}:${qIdx}:0` });
    row.push({ text: "✅ Submit all", callback_data: `a:${st.short}:${qIdx}:0` });
    return row;
  };

  // 멀티셀렉트 버튼 루에 (토글 상태 + 네비).
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

  // 단일 선택 버튼 루에 (선택된 것 ✓ 표시 + 네비).
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

  // 질문 본문 (진행도 + 현재 답변 상태 표시).
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

  // 현재 질문을 텔레그램으로 전송/갱신 (단일 메시지 교체).
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

  // 지정 인덱스 질문으로 이동 (단일 메시지 교체).
  const goTo = async (st: AskState, idx: number) => {
    st.idx = Math.max(0, Math.min(st.questions.length - 1, idx));
    await renderQuestion(st);
  };

  // 모든 질문이 답변되었는지 확인, 아니면 첫 미답변 인덱스 반환.
  const firstUnanswered = (st: AskState): number => {
    for (let i = 0; i < st.questions.length; i++) if (!st.answersByIdx.has(i)) return i;
    return -1;
  };

  // 멀티셀렉트의 현재 토글+자유입력을 answersByIdx 에 반영 (선택 없으면 제거).
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

  // 제출: 미답변 있으면 막고 그 질문으로 이동, 아니면 question:answer emit.
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
    // emit 후 question 이 question:resolved 를 돌려주므로 정리는 그곳에서.
  };

  // 객관식 단일 선택: 답 저장 후 자동 다음(마지막이면 머문). 단일 질문이면 즉시 제출.
  const pickSingle = async (st: AskState, qIdx: number, optIdx: number) => {
    const q = st.questions[qIdx];
    const opt = q?.options[optIdx];
    if (!q || !opt) return;
    st.answersByIdx.set(qIdx, { id: q.id, value: opt.value, label: opt.label, wasCustom: false, index: optIdx });
    if (st.questions.length === 1) {
      st.done = true;
      if (st.messageId != null) await tgEdit(config, st.messageId, `✅ *${q.prompt}*\n→ ${opt.label}`);
      pi.events.emit("question:answer", { askId: st.askId, answers: [st.answersByIdx.get(0)!], cancelled: false });
      return;
    }
    if (qIdx < st.questions.length - 1) await goTo(st, qIdx + 1);
    else await renderQuestion(st); // 마지막 질문: 머문며 선택 표시 갱신
  };

  // 멀티셀렉트 토글.
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

  // 자유 텍스트 응답.
  //  - 멀티셀렉트: 선택 목록에 custom 값 추가, answersByIdx 갱신, 머문.
  //  - 단일: custom 답으로 저장 후 자동 다음(단일 질문이면 즉시 제출).
  const answerText = async (st: AskState, text: string, srcMsgId?: number) => {
    const q = st.questions[st.idx];
    if (!q) return;
    const qIdx = st.idx;
    if (q.multiSelect) {
      const arr = st.customTexts.get(qIdx) ?? [];
      arr.push(text);
      st.customTexts.set(qIdx, arr);
      syncMultiAnswer(st, qIdx);
      // 추가했으면 사용자가 보난 텍스트 메시지는 지워 채팅을 깔끔히 유지.
      if (srcMsgId != null) await tgDelete(config, srcMsgId);
      await renderQuestion(st);
      return;
    }
    st.answersByIdx.set(qIdx, { id: q.id, value: text, label: text, wasCustom: true });
    if (st.questions.length === 1) {
      st.done = true;
      if (st.messageId != null) await tgEdit(config, st.messageId, `✅ *${q.prompt}*\n→ ${text}`);
      pi.events.emit("question:answer", { askId: st.askId, answers: [st.answersByIdx.get(0)!], cancelled: false });
      return;
    }
    if (qIdx < st.questions.length - 1) await goTo(st, qIdx + 1);
    else await renderQuestion(st);
  };

  // 메시지 id 로 ask 찾기 (reply 기반 라우팅용).
  const askByMessageId = (messageId: number): AskState | undefined => {
    for (const st of asks.values()) if (!st.done && st.messageId === messageId) return st;
    return undefined;
  };

  // 대기 중인 ask 개수 (reply 없는 텍스트 폴백 판단용).
  const pendingAsks = (): AskState[] => [...asks.values()].filter((s) => !s.done);

  let pollInitialized = false;

  const ensurePolling = () => {
    if (polling) return;
    polling = true;
    void pollLoop();
  };

  // 첫 폴링 전에 기존에 쌓인 업데이트(과거 메시지/콜백)를 건너뛴다.
  // offset:-1 은 마지막 업데이트 1개만 반환 → 그 다음부터 수신.
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
    // 콜백 쿼리 (버튼)
    const cq = u.callback_query as Record<string, unknown> | undefined;
    if (cq) {
      const from = (cq.message as Record<string, unknown>)?.chat as Record<string, unknown> | undefined;
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
    // 일반 메시지 (텍스트 답장)
    const msg = u.message as Record<string, unknown> | undefined;
    if (msg) {
      const chat = msg.chat as Record<string, unknown> | undefined;
      if (String(chat?.id ?? "") !== String(config.chatId)) return;
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text || text.startsWith("/")) return;
      const msgId = typeof msg.message_id === "number" ? msg.message_id : undefined;
      // reply 기반 라우팅만 허용: 특정 질문 메시지에 답장해야 인식한다.
      // reply 가 없으면 어느 질문인지 알 수 없으므로 무시(안내만).
      const reply = msg.reply_to_message as Record<string, unknown> | undefined;
      const replyId = reply && typeof reply.message_id === "number" ? reply.message_id : undefined;
      if (replyId == null) {
        if (pendingAsks().length > 0) {
          // 안내 메시지 + 사용자 원본 텍스트를 잠시 뒤 지워 채팅을 깔끔히 유지.
          const noticeId = await tgSend(config, "❗ To answer with text, *reply* to the specific question message.");
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

  // question:ask — 새 질문 세트 수신.
  unsubs.push(pi.events.on("question:ask", (data) => {
    const payload = data as { askId?: string; questions?: QItem[] };
    if (!payload?.askId || !Array.isArray(payload.questions) || payload.questions.length === 0) return;
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
  }));

  // question:resolved — 로컬 TUI 가 먼저 답했거나 취소됨. 방식 C 정리.
  unsubs.push(pi.events.on("question:resolved", (data) => {
    const payload = data as { askId?: string };
    const st = payload?.askId ? asks.get(payload.askId) : undefined;
    if (!st) return;
    // 우리가 emit 해서 끝난 게 아니라면(= 로컬이 이김) 떠있는 메시지를 정리.
    if (!st.done && st.messageId != null) {
      void tgEdit(config, st.messageId, "✅ _Answered in terminal. This question is closed._");
    }
    st.done = true;
    asks.delete(st.askId);
    shortToAsk.delete(st.short);
  }));

  // reload/종료 시 구독 해제 (EventBus 가 재사용되므로 리스너 누적 방지).
  pi.on("session_shutdown", () => {
    for (const off of unsubs.splice(0)) off();
  });
}

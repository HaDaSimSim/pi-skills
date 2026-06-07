// pi 용 todo — Claude Code 의 TodoWrite 를 pi 에 이식한 것.
//
// 동작 개념:
//   에이전트가 멀티스텝 작업을 진행할 때 쓰는 구조화된 작업 목록이다.
//   모델이 todo_write 로 목록 전체를 교체하면, 그 시점의 진행 상황이
//   사용자에게 보인다. 사용자가 직접 관리하는 개인 todo 가 아니라,
//   "지금 무엇을 하고 있고 다음에 뭘 할지" 를 드러내는 에이전트용 추적 도구.
//
// 표시:
//   - 에이전트가 일하는 동안(turn_start ~ agent_end) "Working… Ns" 줄 바로
//     아래에 진행 중/남은 항목이 위젯으로 뜬다 (setWidget, aboveEditor).
//   - /todo 로 언제든 현재 목록을 텍스트로 볼 수 있다.
//
// 영속화:
//   목록은 pi.appendEntry 로 세션에 기록되고 session_start 에서 복원되므로
//   /reload 나 재시작 후에도 살아있다. 브랜치와 무관한 세션 전역 상태이므로
//   appendEntry(마지막 기록이 곧 현재 상태)를 쓴다.
//
// 이벤트:
//   목록이 바뀔 때마다 events 버스에 "todo:changed" 를 쏜다. 다른 확장이
//   (예: telegram) 진행 상황을 구독할 수 있다.
//
// 설치: ~/.pi/agent/extensions/todo/index.ts (make install 이 symlink)

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  // 할 일의 명령형 설명 (예: "Run the test suite").
  content: string;
  // 진행 중일 때 보여줄 현재형 설명 (예: "Running the test suite"). 선택.
  activeForm?: string;
  status: TodoStatus;
}

const isDone = (t: TodoItem): boolean => t.status === "completed";
const allDone = (todos: TodoItem[]): boolean => todos.length > 0 && todos.every(isDone);
const doneCount = (todos: TodoItem[]): number => todos.filter(isDone).length;

// in_progress 중일 땐 activeForm 을 우선 쓰고, 없으면 content.
const labelOf = (t: TodoItem): string =>
  t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;

// todo_write 의 핵심 동작: 통째 replace + (CC V1 처럼) 전부 completed 면 클리어.
const normalize = (next: TodoItem[]): TodoItem[] =>
  next.length > 0 && next.every(isDone) ? [] : next;

// tool 이 모델에게 돌려줄 요약 텍스트.
const summary = (todos: TodoItem[]): string => {
  if (todos.length === 0) return "All todos completed; list cleared.";
  const done = doneCount(todos);
  const active = todos.find((t) => t.status === "in_progress");
  return active
    ? `In progress: ${labelOf(active)} (${done}/${todos.length} done)`
    : `${done}/${todos.length} todos completed`;
};

// 상세 위젯/목록 표시용 정렬: in_progress → pending → completed.
const ORDER: Record<TodoStatus, number> = { in_progress: 0, pending: 1, completed: 2 };
const sortForDisplay = (todos: TodoItem[]): TodoItem[] =>
  [...todos].sort((a, b) => ORDER[a.status] - ORDER[b.status]);

// 세션 저널에 기록할 커스텀 엔트리 타입. session_start 에서 이 타입만 골라
// 마지막 기록을 현재 목록으로 복원한다. LLM 컨텍스트에는 들어가지 않는다.
const STATE_ENTRY_TYPE = "todo-list";

// working 중 "Working… Ns" 줄 아래에 다는 위젯 키. 다른 확장의 위젯과
// 겹치지 않도록 고유 키를 쓴다. setFooter/setWorkingMessage 는 ui-cosmetics
// 가 소유하므로 건드리지 않는다.
const WIDGET_KEY = "todo-progress";

// footer status 키. setStatus 는 키별 멀티 오너라 다른 확장과 공존한다.
// idle/working 무관하게 todo 가 있으면 n/N 카운트를 상시 띄운다.
const STATUS_KEY = "todo";

// 위젯이 길어지면 pi 가 잘라내므로(MAX_WIDGET_LINES) 표시 줄 수를 제한한다.
const MAX_WIDGET_ITEMS = 8;

// 모델이 마지막으로 todo_write 를 호출한 뒤 이만큼 턴이 지나면 현재
// 목록을 컨텍스트에 다시 주입한다(CC 의 todo_reminder 방식). compaction 으로
// todo_write 호출 기록이 잘려 모델이 자신의 todo 를 잊는 걸 막는다.
const REMIND_AFTER_TURNS = 3;

const MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

export default function (pi: ExtensionAPI) {
  let todos: TodoItem[] = [];
  // 에이전트가 일하는 중인지(turn_start ~ agent_end). 위젯(상세 목록)은
  // working 중에만 띄우고, footer 의 n/N 카운트는 idle 에도 상시 띄운다.
  let working = false;

  // 리마인더용 턴 카운터. turn_start 마다 증가하고, todo_write 호출 시
  // "마지막으로 목록을 다룬 턴"을 기록해 경과 턴 수를 쟰다.
  let turnCount = 0;
  let lastWriteTurn = 0;

  // 목록 → 위젯 줄 배열. in_progress 와 pending 을 우선 보여주고, 완료 항목은
  // 뒤로 미뤄 잘릴 때 덜 중요한 것부터 잘리게 한다.
  // 마커는 ASCII(`[ ] [~] [x]`)라 터미널 무관하게 너비가 균일해 정렬이 맞는다.
  const widgetLines = (ctx: ExtensionContext): string[] => {
    const theme = ctx.ui.theme;
    const sorted = sortForDisplay(todos);
    const shown = sorted.slice(0, MAX_WIDGET_ITEMS);

    // 헤더: "n/N todos" (들여쓰기 없이, 아래 본문과 구분).
    const done = doneCount(todos);
    const header = theme.fg("dim", `${done}/${todos.length} todos`);

    const items = shown.map((t) => {
      const label = labelOf(t);
      // 항목은 헤더보다 한 단계 더 들여쓰고, 마커 뒤 공백 1칸.
      if (t.status === "completed") {
        return `  ${theme.fg("success", MARK.completed)} ${theme.fg("muted", theme.strikethrough(label))}`;
      }
      if (t.status === "in_progress") {
        return `  ${theme.fg("accent", MARK.in_progress)} ${label}`;
      }
      return `  ${theme.fg("muted", MARK.pending)} ${theme.fg("muted", label)}`;
    });

    const hidden = sorted.length - shown.length;
    if (hidden > 0) items.push(theme.fg("muted", `  …and ${hidden} more`));
    // 맨 위 헤더 + 본문 + 아래 여백 두 줄.
    return [header, ...items, "", ""];
  };

  // footer 의 n/N 카운트. todo 가 있으면 idle/working 무관하게 상시 표시.
  const refreshStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (todos.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const done = doneCount(todos);
    const complete = done === todos.length;
    // n/N 카운트는 완료 여부에 따라 색, "todos" 단어는 항상 dim.
    const count = ctx.ui.theme.fg(complete ? "success" : "muted", `${done}/${todos.length}`);
    ctx.ui.setStatus(STATUS_KEY, `${count} ${ctx.ui.theme.fg("dim", "todos")}`);
  };

  // working 중이고 미완료 항목이 남아 있으면 상세 위젯을 갱신, 아니면 클리어.
  // footer 카운트(refreshStatus)도 함께 갱신한다.
  const refresh = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    refreshStatus(ctx);
    if (working && todos.length > 0 && !allDone(todos)) {
      ctx.ui.setWidget(WIDGET_KEY, widgetLines(ctx), { placement: "aboveEditor" });
    } else {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  };

  const persist = () => {
    pi.appendEntry(STATE_ENTRY_TYPE, { todos } as unknown as Record<string, unknown>);
  };

  const emitChange = () => {
    const counts = {
      total: todos.length,
      pending: todos.filter((t) => t.status === "pending").length,
      in_progress: todos.filter((t) => t.status === "in_progress").length,
      completed: doneCount(todos),
    };
    pi.events.emit("todo:changed", { todos, counts });
  };

  // 현재 목록을 사람이 읽는 텍스트로 (/, 알림용).
  const renderList = (ctx: ExtensionContext): string => {
    if (todos.length === 0) return "No todos.";
    const lines = todos.map((t) => `${MARK[t.status]} ${labelOf(t)}`);
    lines.push("");
    lines.push(ctx.ui.theme.fg("muted", `${doneCount(todos)}/${todos.length} completed`));
    return lines.join("\n");
  };

  pi.registerTool({
    name: "todo_write",
    label: "Write Todos",
    description:
      "Create or update the structured task list for the current work. Pass the FULL " +
      "list every time — it replaces the previous list wholesale. Use this to plan " +
      "multi-step work and to surface progress to the user: mark exactly one item as " +
      "in_progress while you work on it, and flip items to completed as soon as they " +
      "are done. Skip it for trivial single-step tasks.",
    promptSnippet: "Track multi-step work with a structured todo list via todo_write",
    promptGuidelines: [
      "Use todo_write for multi-step or non-trivial tasks to plan and show progress; skip it for single trivial steps.",
      "Always send the complete list — todo_write replaces the whole list, it does not merge.",
      "Keep exactly one item in_progress at a time; mark items completed immediately when finished, not in a batch at the end.",
      "Provide activeForm (present continuous, e.g. 'Running tests') so the in-progress item reads naturally while working.",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({
            description: "Imperative description of the task, e.g. 'Run the test suite'.",
          }),
          activeForm: Type.Optional(
            Type.String({
              description:
                "Present-continuous form shown while in progress, e.g. 'Running the test suite'.",
            }),
          ),
          status: StringEnum(["pending", "in_progress", "completed"] as const, {
            description: "Current status of this task.",
          }),
        }),
        { description: "The complete task list. Replaces the previous list entirely." },
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // 통째 replace + 전부 completed 면 클리어 (logic.normalize).
      todos = normalize(params.todos as TodoItem[]);
      lastWriteTurn = turnCount; // 방금 목록을 주었으므로 리마인더 카운터 리셋.
      persist();
      emitChange();
      refresh(ctx);
      return {
        content: [{ type: "text", text: summary(todos) }],
        details: { todos },
      };
    },
  });

  pi.registerTool({
    name: "todo_read",
    label: "Read Todos",
    description:
      "Read the current task list (the one managed by todo_write). Use this to re-check " +
      "your remaining work without re-sending the whole list — e.g. after a long tangent, " +
      "or when resuming a session, to see what's still pending or in progress.",
    promptSnippet: "Read the current todo list with todo_read",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      lastWriteTurn = turnCount; // 명시적으로 읽었으므로 리마인더 카운터 리셋.
      if (todos.length === 0) {
        return { content: [{ type: "text", text: "The todo list is empty." }], details: { todos } };
      }
      const lines = todos.map((t) => `${MARK[t.status]} ${labelOf(t)}`);
      lines.push(`${doneCount(todos)}/${todos.length} completed`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { todos },
      };
    },
  });

  pi.registerCommand("todo", {
    description: "Show the current task list. `/todo clear` empties it.",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "clear") {
        todos = [];
        persist();
        emitChange();
        refresh(ctx);
        ctx.ui.notify("Todo list cleared.", "info");
        return;
      }
      ctx.ui.notify(renderList(ctx), "info");
    },
    getArgumentCompletions: (prefix: string) => {
      const items = ["clear"]
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
  });

  // 세션 시작/재진입 시 마지막 todo-list 엔트리로 목록을 복원하고, footer
  // 카운트를 띄운다(idle 이라도 todo 가 있으면 보인다).
  pi.on("session_start", async (_event, ctx) => {
    todos = [];
    turnCount = 0;
    lastWriteTurn = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as { todos?: TodoItem[] } | undefined;
        if (data && Array.isArray(data.todos)) todos = data.todos;
      }
    }
    refresh(ctx);
  });

  // 모델이 한동안 todo_write/read 를 안 썼고 미완료 항목이 남아 있으면,
  // 현재 목록을 ephemeral user 메시지로 이번 턴 컨텍스트에만 주입한다.
  // event.messages 에 push 한 것은 세션 저널에 남지 않고, 매 호출마다 다시
  // 계산되므로 컨텍스트에 누적되지 않는다.
  pi.on("context", (event) => {
    if (todos.length === 0 || allDone(todos)) return;
    if (turnCount - lastWriteTurn < REMIND_AFTER_TURNS) return;
    const lines = todos.map((t) => `${MARK[t.status]} ${labelOf(t)}`);
    const reminder =
      "[todo reminder] Your current task list (manage it with todo_write):\n" +
      `${lines.join("\n")}\n` +
      `${doneCount(todos)}/${todos.length} completed. Keep exactly one task in_progress; ` +
      "update the list as you make progress.";
    return {
      messages: [
        ...event.messages,
        { role: "user" as const, content: reminder, timestamp: Date.now() },
      ],
    };
  });

  // 에이전트가 일을 시작하면 상세 위젯을 켠고, 리마인더용 턴 카운터를 올린다.
  pi.on("turn_start", (event, ctx) => {
    if (event.turnIndex === 0) working = true;
    turnCount++;
    refresh(ctx);
  });

  // 턴이 끝나면 idle 로 전환한다. 상세 위젯은 내리지만 footer n/N 카운트는
  // 그대로 남는다(refresh 안에서 처리).
  pi.on("agent_end", (_event, ctx) => {
    working = false;
    refresh(ctx);
  });
}

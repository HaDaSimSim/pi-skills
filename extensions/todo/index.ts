// todo for pi — a port of Claude Code's TodoWrite to pi.
//
// Concept:
//   A structured task list used while the agent works through a multi-step task.
//   When the model replaces the whole list via todo_write, the progress at that
//   point is shown to the user. This is not a personal todo managed by the user;
//   it's a tracking tool for the agent that surfaces "what it's doing now and what
//   it'll do next".
//
// Display:
//   - While the agent is working (turn_start ~ agent_end), a widget showing the
//     in-progress/remaining items appears right below the "Working… Ns" line
//     (setWidget, aboveEditor).
//   - /todo shows the current list as text at any time.
//
// Persistence:
//   The list is recorded to the session via pi.appendEntry and restored at
//   session_start, so it survives /reload and restarts. Since it's session-global
//   state independent of the branch, we use appendEntry (the last record is the
//   current state).
//
// Events:
//   Whenever the list changes, "todo:changed" is emitted on the events bus. Other
//   extensions (e.g. telegram) can subscribe to the progress.
//
// Install: ~/.pi/agent/extensions/todo/index.ts (make install symlinks it)

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  // Imperative description of the task (e.g. "Run the test suite").
  content: string;
  // Present-continuous description shown while in progress (e.g. "Running the test suite"). Optional.
  activeForm?: string;
  status: TodoStatus;
}

const isDone = (t: TodoItem): boolean => t.status === "completed";
const allDone = (todos: TodoItem[]): boolean => todos.length > 0 && todos.every(isDone);
const doneCount = (todos: TodoItem[]): number => todos.filter(isDone).length;

// While in_progress, prefer activeForm; otherwise use content.
const labelOf = (t: TodoItem): string =>
  t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;

// Core behavior of todo_write: wholesale replace + (like CC V1) clear if all completed.
const normalize = (next: TodoItem[]): TodoItem[] =>
  next.length > 0 && next.every(isDone) ? [] : next;

// Summary text the tool returns to the model.
const summary = (todos: TodoItem[]): string => {
  if (todos.length === 0) return "All todos completed; list cleared.";
  const done = doneCount(todos);
  const active = todos.find((t) => t.status === "in_progress");
  return active
    ? `In progress: ${labelOf(active)} (${done}/${todos.length} done)`
    : `${done}/${todos.length} todos completed`;
};

// Ordering for detail widget/list display: in_progress → pending → completed.
const ORDER: Record<TodoStatus, number> = { in_progress: 0, pending: 1, completed: 2 };
const sortForDisplay = (todos: TodoItem[]): TodoItem[] =>
  [...todos].sort((a, b) => ORDER[a.status] - ORDER[b.status]);

// Custom entry type recorded in the session journal. At session_start we pick out
// only this type and restore the last record as the current list. It does not enter
// the LLM context.
const STATE_ENTRY_TYPE = "todo-list";

// Widget key attached below the "Working… Ns" line while working. We use a unique
// key so it doesn't collide with other extensions' widgets. setFooter/setWorkingMessage
// are owned by ui-cosmetics, so we don't touch them.
const WIDGET_KEY = "todo-progress";

// footer status key. setStatus is multi-owner per key, so it coexists with other
// extensions. Regardless of idle/working, the n/N count is always shown when there are todos.
const STATUS_KEY = "todo";

// If the widget gets too long pi truncates it (MAX_WIDGET_LINES), so we limit the number of shown lines.
const MAX_WIDGET_ITEMS = 8;

// Once this many turns have passed since the model last called todo_write, the
// current list is re-injected into the context (CC's todo_reminder approach). This
// prevents the model from forgetting its own todos when compaction truncates the
// todo_write call history.
const REMIND_AFTER_TURNS = 3;

const MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

export default function (pi: ExtensionAPI) {
  let todos: TodoItem[] = [];
  // Whether the agent is currently working (turn_start ~ agent_end). The widget
  // (detail list) is shown only while working, but the footer's n/N count is always
  // shown even when idle.
  let working = false;

  // Turn counter for the reminder. Incremented on each turn_start; on a todo_write
  // call we record the "turn the list was last handled" to measure elapsed turns.
  let turnCount = 0;
  let lastWriteTurn = 0;

  // List → widget line array. Show in_progress and pending first, and push completed
  // items to the back so the less important ones get truncated first.
  // The markers are ASCII (`[ ] [~] [x]`), so their width is uniform regardless of
  // terminal and the alignment stays correct.
  const widgetLines = (ctx: ExtensionContext): string[] => {
    const theme = ctx.ui.theme;
    const sorted = sortForDisplay(todos);
    const shown = sorted.slice(0, MAX_WIDGET_ITEMS);

    // Header: "n/N todos" (no indentation, distinct from the body below).
    const done = doneCount(todos);
    const header = theme.fg("dim", `${done}/${todos.length} todos`);

    const items = shown.map((t) => {
      const label = labelOf(t);
      // Items are indented one level deeper than the header, with 1 space after the marker.
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
    // Header at the top + body + two blank lines below.
    return [header, ...items, "", ""];
  };

  // The footer's n/N count. Always shown when there are todos, regardless of idle/working.
  const refreshStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (todos.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const done = doneCount(todos);
    const complete = done === todos.length;
    // The n/N count is colored based on completion; the word "todos" is always dim.
    const count = ctx.ui.theme.fg(complete ? "success" : "muted", `${done}/${todos.length}`);
    ctx.ui.setStatus(STATUS_KEY, `${count} ${ctx.ui.theme.fg("dim", "todos")}`);
  };

  // If working and there are unfinished items remaining, refresh the detail widget;
  // otherwise clear it. Also refreshes the footer count (refreshStatus).
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

  // Render the current list as human-readable text (for /todo, notifications).
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
      // Wholesale replace + clear if all completed (logic.normalize).
      todos = normalize(params.todos as TodoItem[]);
      lastWriteTurn = turnCount; // Just provided the list, so reset the reminder counter.
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
      lastWriteTurn = turnCount; // Read explicitly, so reset the reminder counter.
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

  // On session start/re-entry, restore the list from the last todo-list entry and
  // show the footer count (visible whenever there are todos, even when idle).
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

  // If the model hasn't used todo_write/read for a while and there are unfinished
  // items remaining, inject the current list as an ephemeral user message into this
  // turn's context only. What's pushed to event.messages doesn't stay in the session
  // journal and is recomputed on each call, so it doesn't accumulate in the context.
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

  // When the agent starts working, turn on the detail widget and bump the reminder turn counter.
  pi.on("turn_start", (event, ctx) => {
    if (event.turnIndex === 0) working = true;
    turnCount++;
    refresh(ctx);
  });

  // When the turn ends, switch to idle. The detail widget is taken down, but the
  // footer n/N count stays (handled inside refresh).
  pi.on("agent_end", (_event, ctx) => {
    working = false;
    refresh(ctx);
  });
}

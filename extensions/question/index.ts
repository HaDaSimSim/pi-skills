/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
  values?: string[]; // multi-select
  labels?: string[]; // multi-select
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    }),
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Allow selecting multiple options (default: false)" }),
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
  message: string,
  questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

export default function questionnaire(pi: ExtensionAPI) {
  // Don't register the questionnaire in child subagent processes (`pi -p`, non-interactive).
  // There's no one to answer, so the tool is useless (hasUI=false makes it error immediately), and the model
  // could waste a turn or get confused trying to call it. The subagents extension sets PI_SUBAGENT=1 in the child env.
  if (process.env.PI_SUBAGENT) return;

  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult("Error: UI not available (running in non-interactive mode)");
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      // Normalize questions with defaults
      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
        multiSelect: q.multiSelect === true,
      }));

      // Non-TUI hosts like pi-gui/pi-web: can't draw ctx.ui.custom (a terminal overlay).
      // If the host provides a questionnaire adapter (ctx.ui.questionnaire), use it to show a nice
      // dialog, but also race it against remote responses like telegram (first one in wins).
      const webUi = ctx.ui as unknown as {
        questionnaire?: (qs: Question[]) => {
          promise: Promise<Answer[] | null>;
          cancel: () => void;
        };
      };
      if (process.env.PI_WEB_HOST && typeof webUi.questionnaire === "function") {
        const askId2 = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const gui = webUi.questionnaire(questions);
        let remoteAnswers: Answer[] | null | undefined;
        let cancelledRemote = false;
        let resolveRemote: (() => void) | undefined;
        const remoteWait = new Promise<void>((r) => (resolveRemote = r));
        const onRemote = (data: unknown) => {
          const payload = data as { askId?: string; answers?: Answer[]; cancelled?: boolean };
          if (!payload || payload.askId !== askId2) return;
          remoteAnswers = Array.isArray(payload.answers) ? payload.answers : [];
          cancelledRemote = payload.cancelled === true;
          resolveRemote?.();
        };
        const unsub = pi.events.on("question:answer", onRemote);
        // Send the question to remote clients like telegram.
        pi.events.emit("question:ask", { askId: askId2, questions });

        let answers: Answer[] | null;
        try {
          // GUI response vs remote response race. The first one in wins and the loser is cleaned up.
          const winner = await Promise.race([
            gui.promise.then((a) => ({ src: "gui" as const, a })),
            remoteWait.then(() => ({ src: "remote" as const, a: undefined })),
          ]);
          if (winner.src === "remote") {
            gui.cancel(); // close the GUI dialog
            answers = cancelledRemote ? null : (remoteAnswers ?? []);
          } else {
            answers = winner.a; // GUI result (null = cancelled)
          }
        } finally {
          unsub();
          pi.events.emit("question:resolved", { askId: askId2 });
        }

        if (!answers) {
          return {
            content: [{ type: "text", text: "User cancelled the questionnaire" }],
            details: { questions, answers: [], cancelled: true },
          };
        }
        const lines = answers.map((a) => {
          const qLabel = questions.find((x) => x.id === a.id)?.label || a.id;
          if (a.wasCustom) return `${qLabel}: user wrote: ${a.label}`;
          if (a.values && a.values.length > 0)
            return `${qLabel}: user selected: ${a.labels?.join(", ") || a.label}`;
          return `${qLabel}: user selected: ${a.label}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { questions, answers, cancelled: false },
        };
      }
      if (process.env.PI_WEB_HOST) {
        // Non-TUI host without an adapter: one at a time via select/input (fallback).
        const answers: Answer[] = [];
        for (const q of questions) {
          if (q.options.length > 0) {
            const labels = q.options.map((o) => o.label);
            const picked = await ctx.ui.select(q.prompt, labels);
            if (picked === undefined) {
              return {
                content: [{ type: "text", text: "User cancelled the questionnaire" }],
                details: { questions, answers, cancelled: true },
              };
            }
            const idx = labels.indexOf(picked);
            const opt = q.options[idx] ?? q.options[0];
            answers.push({
              id: q.id,
              value: opt.value,
              label: opt.label,
              wasCustom: false,
              index: idx,
              values: [opt.value],
              labels: [opt.label],
            });
          } else {
            const typed = await ctx.ui.input(q.prompt);
            if (typed === undefined) {
              return {
                content: [{ type: "text", text: "User cancelled the questionnaire" }],
                details: { questions, answers, cancelled: true },
              };
            }
            answers.push({ id: q.id, value: typed, label: typed, wasCustom: true });
          }
        }
        const lines = answers.map((a) => {
          const qLabel = questions.find((x) => x.id === a.id)?.label || a.id;
          return a.wasCustom
            ? `${qLabel}: user wrote: ${a.label}`
            : `${qLabel}: user selected: ${a.label}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { questions, answers, cancelled: false },
        };
      }

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit

      // Remote response support (telegram, etc.): identify by askId, exchange via pi.events.
      // Between local TUI input and remote input, whichever arrives first calls done and wins (prevents duplicates).
      const askId = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      let settled = false;
      let finishRemote: (() => void) | undefined; // resolved signal + unsubscribe
      let capturedDone: ((r: QuestionnaireResult) => void) | undefined;

      const resultPromise = ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
        capturedDone = done;
        // State
        let currentTab = 0;
        let optionIndex = 0;
        let inputMode = false;
        let inputQuestionId: string | null = null;
        let cachedLines: string[] | undefined;
        const answers = new Map<string, Answer>();
        const multiChecked = new Map<string, Set<number>>(); // questionId -> checked indices

        // Editor for "Type something" option
        const editorTheme: EditorTheme = {
          borderColor: (s) => s,
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };
        const editor = new Editor(tui, editorTheme);

        // Helpers
        function refresh() {
          cachedLines = undefined;
          tui.requestRender();
        }

        function submit(cancelled: boolean) {
          if (settled) return;
          settled = true;
          done({ questions, answers: Array.from(answers.values()), cancelled });
        }

        function currentQuestion(): Question | undefined {
          return questions[currentTab];
        }

        function currentOptions(): RenderOption[] {
          const q = currentQuestion();
          if (!q) return [];
          const opts: RenderOption[] = [...q.options];
          opts.push({ value: "__other__", label: "Type something.", isOther: true });
          return opts;
        }

        function allAnswered(): boolean {
          return questions.every((q) => answers.has(q.id));
        }

        function advanceAfterAnswer() {
          if (!isMulti) {
            submit(false);
            return;
          }
          if (currentTab < questions.length - 1) {
            currentTab++;
          } else {
            currentTab = questions.length; // Submit tab
          }
          optionIndex = 0;
          refresh();
        }

        function saveAnswer(
          questionId: string,
          value: string,
          label: string,
          wasCustom: boolean,
          index?: number,
        ) {
          answers.set(questionId, { id: questionId, value, label, wasCustom, index });
        }

        // Editor submit callback
        editor.onSubmit = (value) => {
          if (!inputQuestionId) return;
          const trimmed = value.trim() || "(no response)";
          saveAnswer(inputQuestionId, trimmed, trimmed, true);
          inputMode = false;
          inputQuestionId = null;
          editor.setText("");
          advanceAfterAnswer();
        };

        function handleInput(data: string) {
          // Input mode: route to editor
          if (inputMode) {
            if (matchesKey(data, Key.escape)) {
              inputMode = false;
              inputQuestionId = null;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const q = currentQuestion();
          const opts = currentOptions();

          // Tab navigation (multi-question only)
          if (isMulti) {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
              currentTab = (currentTab + 1) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
            if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
              currentTab = (currentTab - 1 + totalTabs) % totalTabs;
              optionIndex = 0;
              refresh();
              return;
            }
          }

          // Submit tab
          if (currentTab === questions.length) {
            if (matchesKey(data, Key.enter) && allAnswered()) {
              submit(false);
            } else if (matchesKey(data, Key.escape)) {
              submit(true);
            }
            return;
          }

          // Option navigation
          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(opts.length - 1, optionIndex + 1);
            refresh();
            return;
          }

          // Select option
          if (matchesKey(data, Key.enter) && q) {
            if (q.multiSelect) {
              // Enter confirms multi-select
              const checked = multiChecked.get(q.id) || new Set();
              const selectedOpts = Array.from(checked)
                .sort((a, b) => a - b)
                .map((i) => opts[i]);
              const values = selectedOpts.map((o) => o.value);
              const labels = selectedOpts.map((o) => o.label);
              saveAnswer(q.id, values.join(", "), labels.join(", "), false);
              (answers.get(q.id) as Answer).values = values;
              (answers.get(q.id) as Answer).labels = labels;
              advanceAfterAnswer();
              return;
            }
            const opt = opts[optionIndex];
            if (opt.isOther) {
              inputMode = true;
              inputQuestionId = q.id;
              editor.setText("");
              refresh();
              return;
            }
            saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
            advanceAfterAnswer();
            return;
          }

          // Cancel
          if (matchesKey(data, Key.escape)) {
            submit(true);
          }

          // Space toggle for multi-select
          if (data === " " && q?.multiSelect) {
            if (!multiChecked.has(q.id)) multiChecked.set(q.id, new Set());
            const checked = multiChecked.get(q.id)!;
            if (checked.has(optionIndex)) checked.delete(optionIndex);
            else checked.add(optionIndex);
            refresh();
          }
        }

        function render(width: number): string[] {
          if (cachedLines) return cachedLines;

          const lines: string[] = [];
          const q = currentQuestion();
          const opts = currentOptions();

          // Helper to add truncated line
          const add = (s: string) => lines.push(truncateToWidth(s, width));

          add(theme.fg("accent", "─".repeat(width)));

          // Tab bar (multi-question only)
          if (isMulti) {
            const tabs: string[] = ["← "];
            for (let i = 0; i < questions.length; i++) {
              const isActive = i === currentTab;
              const isAnswered = answers.has(questions[i].id);
              const lbl = questions[i].label;
              const box = isAnswered ? "■" : "□";
              const color = isAnswered ? "success" : "muted";
              const text = ` ${box} ${lbl} `;
              const styled = isActive
                ? theme.bg("selectedBg", theme.fg("text", text))
                : theme.fg(color, text);
              tabs.push(`${styled} `);
            }
            const canSubmit = allAnswered();
            const isSubmitTab = currentTab === questions.length;
            const submitText = " ✓ Submit ";
            const submitStyled = isSubmitTab
              ? theme.bg("selectedBg", theme.fg("text", submitText))
              : theme.fg(canSubmit ? "success" : "dim", submitText);
            tabs.push(`${submitStyled} →`);
            add(` ${tabs.join("")}`);
            lines.push("");
          }

          // Helper to render options list
          function renderOptions() {
            const isMultiSel = q?.multiSelect === true;
            const checked = isMultiSel ? multiChecked.get(q!.id) || new Set() : new Set();
            for (let i = 0; i < opts.length; i++) {
              const opt = opts[i];
              const selected = i === optionIndex;
              const isOther = opt.isOther === true;
              const prefix = selected ? theme.fg("accent", "> ") : "  ";
              const color = selected ? "accent" : "text";
              const checkbox = isMultiSel ? (checked.has(i) ? "■ " : "□ ") : "";
              if (isOther && inputMode) {
                add(prefix + theme.fg("accent", `${checkbox}${i + 1}. ${opt.label} ✎`));
              } else {
                add(prefix + theme.fg(color, `${checkbox}${i + 1}. ${opt.label}`));
              }
              if (opt.description) {
                add(`     ${theme.fg("muted", opt.description)}`);
              }
            }
          }

          // Content
          if (inputMode && q) {
            add(theme.fg("text", ` ${q.prompt}`));
            lines.push("");
            // Show options for reference
            renderOptions();
            lines.push("");
            add(theme.fg("muted", " Your answer:"));
            for (const line of editor.render(width - 2)) {
              add(` ${line}`);
            }
            lines.push("");
            add(theme.fg("dim", " Enter to submit • Esc to cancel"));
          } else if (currentTab === questions.length) {
            add(theme.fg("accent", theme.bold(" Ready to submit")));
            lines.push("");
            for (const question of questions) {
              const answer = answers.get(question.id);
              if (answer) {
                const prefix = answer.wasCustom ? "(wrote) " : "";
                add(
                  `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`,
                );
              }
            }
            lines.push("");
            if (allAnswered()) {
              add(theme.fg("success", " Press Enter to submit"));
            } else {
              const missing = questions
                .filter((q) => !answers.has(q.id))
                .map((q) => q.label)
                .join(", ");
              add(theme.fg("warning", ` Unanswered: ${missing}`));
            }
          } else if (q) {
            add(theme.fg("text", ` ${q.prompt}`));
            lines.push("");
            renderOptions();
          }

          lines.push("");
          if (!inputMode) {
            const isMultiSel = q?.multiSelect === true;
            let help: string;
            if (isMulti && isMultiSel) {
              help = " Tab/←→ navigate • ↑↓ move • Space toggle • Enter confirm • Esc cancel";
            } else if (isMultiSel) {
              help = " ↑↓ move • Space toggle • Enter confirm • Esc cancel";
            } else if (isMulti) {
              help = " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel";
            } else {
              help = " ↑↓ navigate • Enter select • Esc cancel";
            }
            add(theme.fg("dim", help));
          }
          add(theme.fg("accent", "─".repeat(width)));

          cachedLines = lines;
          return lines;
        }

        // Focusable implementation: when the TUI calls setFocus on this overlay component, focused
        // must be propagated to the inner Editor. Only then does the Editor emit CURSOR_MARKER and
        // the TUI places the hardware cursor there, so the Korean IME composition window appears in the right spot.
        // (Without propagation, editor.focused stays false → no marker → the IME position is misaligned.)
        let _focused = false;
        return {
          render,
          invalidate: () => {
            cachedLines = undefined;
          },
          handleInput,
          get focused() {
            return _focused;
          },
          set focused(value: boolean) {
            _focused = value;
            editor.focused = value;
          },
        };
      });

      // ── Remote response wiring: emit question:ask, subscribe to question:answer ───────────────
      // An extension like telegram receives question:ask, takes remote input,
      // and returns the answer via question:answer, which we use to call done and close the overlay.
      const applyRemoteAnswer = (data: unknown) => {
        if (settled) return;
        const payload = data as { askId?: string; answers?: Answer[]; cancelled?: boolean };
        if (!payload || payload.askId !== askId) return;
        settled = true;
        const remoteAnswers = Array.isArray(payload.answers) ? payload.answers : [];
        // capturedDone was set synchronously in the factory. Calling it
        // closes the overlay and resolves resultPromise.
        capturedDone?.({
          questions,
          answers: remoteAnswers,
          cancelled: payload.cancelled === true,
        });
      };
      const unsubscribe = pi.events.on("question:answer", applyRemoteAnswer);
      finishRemote = () => {
        unsubscribe();
        pi.events.emit("question:resolved", { askId });
      };
      // Notify the remote side of the full question (telegram receives it and sends buttons/Q&A).
      pi.events.emit("question:ask", { askId, questions });

      let result: QuestionnaireResult;
      try {
        result = await resultPromise;
      } finally {
        finishRemote?.();
      }

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
        if (a.wasCustom) {
          return `${qLabel}: user wrote: ${a.label}`;
        }
        if (a.values && a.values.length > 0) {
          return `${qLabel}: user selected: ${a.labels?.join(", ") || a.label}`;
        }
        return `${qLabel}: user selected: ${a.index}. ${a.label}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args, theme, _context) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questionnaire "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

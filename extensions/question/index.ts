/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default: false)" })),
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
	// 자식 subagent 프로세스(`pi -p`, 비대화형)에서는 questionnaire 를 등록하지 않는다.
	// 응답할 사람이 없어 해당 툴은 쓸모가 없고(hasUI=false 라 즉시 에러), 모델이 그걸 부르려다
	// 턴을 낭비하거나 헷갈릴 수 있다. subagents 익스텐션이 자식 env 에 PI_SUBAGENT=1 을 박는다.
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

			// pi-gui/pi-web 같은 비-TUI 호스트: ctx.ui.custom(터미널 오버레이)을 못 그린다.
			// 대신 일반 ctx.ui 브릿지(select/input)로 질문을 하나씩 물어 답을 모은다.
			// (옵션 있으면 select, 없으면 input. multiSelect 는 단일 선택으로 강등.)
			if (process.env.PI_WEB_HOST) {
				const answers: Answer[] = [];
				for (const q of questions) {
					if (q.options.length > 0) {
						const labels = q.options.map((o) => o.label);
						const picked = await ctx.ui.select(q.prompt, labels);
						if (picked === undefined) {
							return { content: [{ type: "text", text: "User cancelled the questionnaire" }], details: { questions, answers, cancelled: true } };
						}
						const idx = labels.indexOf(picked);
						const opt = q.options[idx] ?? q.options[0];
						answers.push({ id: q.id, value: opt.value, label: opt.label, wasCustom: false, index: idx, values: [opt.value], labels: [opt.label] });
					} else {
						const typed = await ctx.ui.input(q.prompt);
						if (typed === undefined) {
							return { content: [{ type: "text", text: "User cancelled the questionnaire" }], details: { questions, answers, cancelled: true } };
						}
						answers.push({ id: q.id, value: typed, label: typed, wasCustom: true });
					}
				}
				const lines = answers.map((a) => {
					const qLabel = questions.find((x) => x.id === a.id)?.label || a.id;
					return a.wasCustom ? `${qLabel}: user wrote: ${a.label}` : `${qLabel}: user selected: ${a.label}`;
				});
				return { content: [{ type: "text", text: lines.join("\n") }], details: { questions, answers, cancelled: false } };
			}

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			// 원격 응답(텔레그램 등) 지원: askId 로 식별하고, pi.events 로 주고받는다.
			// 로컬 TUI 입력과 원격 입력 중 먼저 온 쪽이 done 을 호출해 이긴다(중복 방지).
			const askId = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			let settled = false;
			let finishRemote: (() => void) | undefined; // resolved 신호 + 구독 해제
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

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
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
						const selectedOpts = Array.from(checked).sort((a, b) => a - b).map((i) => opts[i]);
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
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
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
						const checked = isMultiSel ? (multiChecked.get(q!.id) || new Set()) : new Set();
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
								add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`);
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

				// Focusable 구현: TUI 가 이 오버레이 컴포넌트에 setFocus 할 때 focused 를
				// 내부 Editor 로 전파해야 한다. 그래야 Editor 가 CURSOR_MARKER 를 내보내고
				// TUI 가 하드웨어 커서를 거기에 둬서 한국어 IME 조합창이 올바른 위치에 뜬다.
				// (전파를 안 하면 editor.focused 가 계속 false → 마커 없음 → IME 위치가 어긋남.)
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

			// ── 원격 응답 배선: question:ask emit, question:answer 구독 ───────────────
			// telegram 같은 익스텐션이 question:ask 를 받아 원격 입력을 받고,
			// question:answer 로 답을 돌려주면 그걸로 done 을 호출해 오버레이를 닫는다.
			const applyRemoteAnswer = (data: unknown) => {
				if (settled) return;
				const payload = data as { askId?: string; answers?: Answer[]; cancelled?: boolean };
				if (!payload || payload.askId !== askId) return;
				settled = true;
				const remoteAnswers = Array.isArray(payload.answers) ? payload.answers : [];
				// capturedDone 은 factory 에서 동기적으로 설정되었다. 이걸 부르면
				// 오버레이가 닫히고 resultPromise 가 풀린다.
				capturedDone?.({ questions, answers: remoteAnswers, cancelled: payload.cancelled === true });
			};
			const unsubscribe = pi.events.on("question:answer", applyRemoteAnswer);
			finishRemote = () => {
				unsubscribe();
				pi.events.emit("question:resolved", { askId });
			};
			// 질문 전체를 원격쪽에 알린다 (telegram 이 받아 버튼/문답으로 전송).
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

// btw — Claude Code 의 /btw ("by the way") 사이드 질문 커맨드를 pi 에 이식한 것.
//
// 동작 개념:
//   대화 도중 "잠깐, 이거 하나만" 같은 곁가지 질문을 던지고 싶을 때가 있다.
//   그걸 그냥 보내면 메인 대화 컨텍스트가 그 질답으로 오염되고, 모델이
//   "확인해볼게요…" 하며 도구를 부르고 턴을 이어가 버린다.
//
//   /btw 는 현재 대화 컨텍스트를 "포크" 해서, 도구 없이 단발(single-turn)
//   질문을 모델에 던지고, 답변을 인라인 오버레이로만 보여준다. 메인 세션·
//   LLM 컨텍스트에는 질문도 답변도 남지 않는다. 즉 본 대화에 0 의 영향.
//
// Claude Code 와의 대응:
//   - 현재 브랜치 전체를 컨텍스트로 사용                  (forkContextMessages)
//   - 도구 사용 불가 + 단일 응답 강제 (system-reminder)   (canUseTool: deny, maxTurns: 1)
//   - thinking 끔                                          (maxThinkingTokens: 0)
//   - 메인 대화 불참                                       (skipCacheWrite, side_question)
//
//   pi 의 complete() 는 애초에 도구 스키마를 전송하지 않으므로, 모델은
//   도구를 부를 방법 자체가 없다. Claude Code 가 클라이언트단에서 막는 것보다
//   더 깔끔하게 "도구 없는 단발 응답" 이 된다.
//
// 설치: ~/.pi/agent/extensions/btw/index.ts (make install 이 symlink)

import { complete, type Message, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

// 사이드 질문임을 모델에 알리는 system-reminder. Claude Code 의 원문을 거의 그대로
// 옮겼다. 핵심은 "도구 없음 · 단일 응답 · 추측 금지".
const SIDE_QUESTION_REMINDER = [
  "<system-reminder>This is a side question from the user. You must answer this question directly in a single response.",
  "",
  "CRITICAL CONSTRAINTS:",
  "- You have NO tools available - you cannot read files, run commands, search, or take any actions",
  "- This is a one-off response - there will be no follow-up turns",
  "- You can ONLY provide information based on what you already know from the conversation context",
  '- NEVER say things like "Let me try...", "I\'ll now...", "Let me check...", or promise to take any action',
  "- If you don't know the answer, say so - do not offer to look it up or investigate",
  "",
  "Simply answer the question with the information you have.</system-reminder>",
].join("\n");

// ─── 컨텍스트 포크 ───────────────────────────────────────────────────────────

// 현재 브랜치의 실제 메시지 배열을 그대로 포크한다 (Claude Code 의
// forkContextMessages). 평탄화하지 않고 user/assistant/toolResult 메시지를
// 원형 그대로 복사해 넘긴다 — 모델은 진짜 대화 흐름을 그대로 본다.
// 메시지는 deep copy 해서 메인 세션 객체를 건드리지 않는다.
function forkContextMessages(ctx: ExtensionCommandContext): Message[] {
  const branch = ctx.sessionManager.getBranch();
  const messages: Message[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    messages.push(structuredClone(entry.message as Message));
  }
  return messages;
}

// ─── 결과 오버레이 ───────────────────────────────────────────────────────────

async function showAnswer(question: string, answer: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;
  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const mdTheme = getMarkdownTheme();

    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold("💬 by the way")), 1, 0));
    container.addChild(new Text(theme.fg("dim", question), 1, 1));
    container.addChild(new Markdown(answer, 1, 0, mdTheme));
    container.addChild(new Text(theme.fg("dim", "Enter/Esc to close · this is not saved to the conversation"), 1, 0));
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
      },
    };
  });
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Ask a side question with full context, no tools, no effect on the conversation",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui.notify("Usage: /btw <your question>", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/btw requires interactive mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const contextMessages = forkContextMessages(ctx);

      // 사이드 질문: 포크한 대화 메시지 배열 뒤에 system-reminder + 질문을
      // 마지막 user 메시지로 붙인다. 대화 흐름은 그대로 유지된다.
      const sideQuestion: UserMessage = {
        role: "user",
        content: [{ type: "text", text: `${SIDE_QUESTION_REMINDER}\n\n${question}` }],
        timestamp: Date.now(),
      };
      const forkedMessages: Message[] = [...contextMessages, sideQuestion];

      // 진행 표시 + 단발 호출. Esc 로 취소.
      const answer = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, `Asking ${ctx.model!.id} (side question)...`);
        loader.onAbort = () => done(null);

        const ask = async (): Promise<string | null> => {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
          if (!auth.ok) {
            throw new Error(auth.error);
          }
          if (!auth.apiKey) {
            throw new Error(`No API key for ${ctx.model!.provider}`);
          }

          // complete() 는 도구 스키마를 전송하지 않는다 → 도구 없는 단발 응답.
          // reasoning "off" 로 thinking 도 끈다 (Claude Code 의 maxThinkingTokens: 0).
          const response = await complete(
            ctx.model!,
            { messages: forkedMessages },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal, reasoning: "off" },
          );

          if (response.stopReason === "aborted") return null;

          return response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();
        };

        ask()
          .then(done)
          .catch((e: unknown) => {
            ctx.ui.notify(`/btw failed: ${e instanceof Error ? e.message : String(e)}`, "error");
            done(null);
          });

        return loader;
      });

      if (answer === null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }
      if (!answer) {
        ctx.ui.notify("No answer returned", "warning");
        return;
      }

      await showAnswer(question, answer, ctx);
    },
  });
}

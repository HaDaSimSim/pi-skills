// btw — a port of Claude Code's /btw ("by the way") side-question command to pi.
//
// Concept:
//   Sometimes mid-conversation you want to throw in a tangential "hold on, just this one thing" question.
//   If you just send it, the main conversation context gets polluted by that exchange, and the model
//   says "let me check…", calls tools, and carries on the turn.
//
//   /btw "forks" the current conversation context, throws a single-turn question at the model
//   without tools, and shows the answer only as an inline overlay. Neither the question nor the
//   answer remains in the main session or LLM context. In other words, zero impact on the conversation.
//
// Correspondence with Claude Code:
//   - Uses the entire current branch as context              (forkContextMessages)
//   - No tool use + forced single response (system-reminder)  (canUseTool: deny, maxTurns: 1)
//   - thinking off                                            (maxThinkingTokens: 0)
//   - Stays out of the main conversation                      (skipCacheWrite, side_question)
//
//   pi's complete() never sends a tool schema to begin with, so the model has
//   no way to call a tool at all. This is a cleaner "tool-less single response"
//   than Claude Code blocking it on the client side.
//
// Install: ~/.pi/agent/extensions/btw/index.ts (make install symlinks it)

import { complete, type Message, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

// system-reminder that tells the model this is a side question. Carried over almost
// verbatim from Claude Code's original. The key points are "no tools · single response · no guessing".
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

// ─── Context fork ───────────────────────────────────────────────────────────

// Fork the current branch's actual message array as-is (Claude Code's
// forkContextMessages). Copies user/assistant/toolResult messages in their
// original form without flattening — the model sees the real conversation flow as-is.
// The messages are deep-copied so the main session objects aren't touched.
function forkContextMessages(ctx: ExtensionCommandContext): Message[] {
  const branch = ctx.sessionManager.getBranch();
  const messages: Message[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    messages.push(structuredClone(entry.message as Message));
  }
  return messages;
}

// ─── Result overlay ───────────────────────────────────────────────────────────

async function showAnswer(
  question: string,
  answer: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) return;
  // pi-gui/pi-web: instead of a terminal overlay, show the markdown answer via the host adapter.
  const webUi = ctx.ui as unknown as { showBtw?: (q: string, a: string) => Promise<void> };
  if (process.env.PI_WEB_HOST && typeof webUi.showBtw === "function") {
    await webUi.showBtw(question, answer);
    return;
  }
  await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const mdTheme = getMarkdownTheme();

    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold("💬 by the way")), 1, 0));
    container.addChild(new Text(theme.fg("dim", question), 1, 1));
    container.addChild(new Markdown(answer, 1, 0, mdTheme));
    container.addChild(
      new Text(theme.fg("dim", "Enter/Esc to close · this is not saved to the conversation"), 1, 0),
    );
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

      // Side question: append the system-reminder + question after the forked
      // conversation message array, as the final user message. The conversation flow is preserved.
      const sideQuestion: UserMessage = {
        role: "user",
        content: [{ type: "text", text: `${SIDE_QUESTION_REMINDER}\n\n${question}` }],
        timestamp: Date.now(),
      };
      const forkedMessages: Message[] = [...contextMessages, sideQuestion];

      // Single-shot LLM call helper (tool-less single response).
      const runComplete = async (signal?: AbortSignal): Promise<string | null> => {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
        if (!auth.ok) throw new Error(auth.error);
        if (!auth.apiKey) throw new Error(`No API key for ${ctx.model!.provider}`);
        const response = await complete(
          ctx.model!,
          { messages: forkedMessages },
          { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: "off" },
        );
        if (response.stopReason === "aborted") return null;
        return response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();
      };

      // pi-gui/pi-web: can't draw the terminal loader (custom). Call directly and show progress with a toast.
      let answer: string | null;
      if (process.env.PI_WEB_HOST) {
        ctx.ui.notify(`Asking ${ctx.model.id} (side question)…`, "info");
        try {
          answer = await runComplete();
        } catch (e) {
          ctx.ui.notify(`/btw failed: ${e instanceof Error ? e.message : String(e)}`, "error");
          return;
        }
      } else {
        // Progress display + single-shot call. Cancel with Esc.
        answer = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `Asking ${ctx.model!.id} (side question)...`,
          );
          loader.onAbort = () => done(null);

          const ask = async (): Promise<string | null> => {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
            if (!auth.ok) {
              throw new Error(auth.error);
            }
            if (!auth.apiKey) {
              throw new Error(`No API key for ${ctx.model!.provider}`);
            }

            // complete() doesn't send a tool schema → tool-less single response.
            // reasoning "off" also turns off thinking (Claude Code's maxThinkingTokens: 0).
            const response = await complete(
              ctx.model!,
              { messages: forkedMessages },
              {
                apiKey: auth.apiKey,
                headers: auth.headers,
                signal: loader.signal,
                reasoning: "off",
              },
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
      }

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

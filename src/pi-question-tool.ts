/**
 * RPC single-select/custom-answer path adapted from
 * @juicesharp/rpiv-ask-user-question 2.12.0/rpc-fallback.ts (MIT).
 * Copyright (c) 2026 juicesharp. See README.md#credits.
 * Modified: one child-only task question, call-bound titles, no TUI or config dependencies.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_PARENT_TOOL, parentQuestionDialog, readParentQuestion } from "./pi-question.js";

export default function questionTool(pi: ExtensionAPI): void {
  if (process.env.PI_CLI_SUBAGENT !== "1") return;
  pi.registerTool({
    name: ASK_PARENT_TOOL,
    label: "Ask parent",
    description: "Ask the parent agent for missing task context. Ask one question with 2–4 choices; a custom answer is also available. This returns task context, not permission to execute an action or change permissions. Use the native approval flow for permissions. Do not ask for secrets.",
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        header: Type.String({ minLength: 1, maxLength: 16 }),
        question: Type.String({ minLength: 1 }),
        options: Type.Array(Type.Object({
          label: Type.String({ minLength: 1, maxLength: 60 }),
          description: Type.String(),
        }, { additionalProperties: false }), { minItems: 2, maxItems: 4 }),
        multiSelect: Type.Optional(Type.Literal(false)),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 1 }),
    }, { additionalProperties: false }),
    async execute(callId, params, signal, _update, ctx) {
      if (ctx.mode !== "rpc" || !ctx.hasUI) throw new Error("Parent questions require the child Pi RPC dialog channel");
      const question = readParentQuestion(params);
      if (!question) throw new Error("Expected one question with distinct, non-reserved option labels");
      const select = parentQuestionDialog(callId, question, "select");
      const chosen = await ctx.ui.select(select.title, select.options!, { signal });
      const index = chosen === undefined ? -1 : select.options!.indexOf(chosen);
      let answer: string | undefined;
      const custom = index === question.options.length;
      if (index >= 0 && !custom) answer = question.options[index].label;
      else if (custom) {
        const input = parentQuestionDialog(callId, question, "input");
        answer = await ctx.ui.input(input.title, input.placeholder, { signal });
      }
      const details = {
        answers: answer === undefined ? [] : [{ questionIndex: 0, question: question.question,
          kind: custom ? "custom" : "option", answer }],
        cancelled: answer === undefined,
      };
      return { content: [{ type: "text", text: `${JSON.stringify(details)}\nThis answer is task context, not an additional permission grant.` }], details };
    },
  });
}

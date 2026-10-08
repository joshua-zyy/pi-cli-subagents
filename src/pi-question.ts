/**
 * Single-question subset of @juicesharp/rpiv-ask-user-question 2.12.0 (MIT).
 * Copyright (c) 2026 juicesharp. See README.md#credits.
 * Modified: child-only contract, one question, and call-bound dialog titles.
 * No Pi runtime imports: the worker and injected extension share this wire contract.
 */
export const ASK_PARENT_TOOL = "subagent_ask_parent";
export interface ParentQuestion {
  header: string;
  question: string;
  options: { label: string; description: string }[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function readParentQuestion(input: unknown): ParentQuestion | undefined {
  if (!object(input) || !Array.isArray(input.questions) || input.questions.length !== 1) return;
  const q: unknown = input.questions[0];
  if (!object(q) || typeof q.header !== "string" || !q.header.trim() || q.header.length > 16 ||
    typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.options) ||
    q.options.length < 2 || q.options.length > 4 || q.multiSelect !== undefined && q.multiSelect !== false) return;
  const options: ParentQuestion["options"] = [];
  for (const option of q.options) {
    if (!object(option) || typeof option.label !== "string" || !option.label.trim() || option.label.length > 60 ||
      typeof option.description !== "string" || ["Other", "Type something.", "Next"].includes(option.label) ||
      options.some(prior => prior.label === option.label)) return;
    options.push({ label: option.label, description: option.description });
  }
  return { header: q.header, question: q.question, options };
}

/** The marker correlates a dialog; it is not a sandbox against code running in the child. */
export function parentQuestionDialog(callId: string, question: ParentQuestion, method: "select" | "input") {
  const displayTitle = `[${question.header}] ${question.question}${method === "input" ? "\n\nType your answer:" : ""}`;
  return {
    title: `[pi-cli-subagents:question:v1:${encodeURIComponent(callId)}:${method}]\n${displayTitle}`,
    displayTitle,
    options: method === "select" ? [
      ...question.options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`),
      `${question.options.length + 1}. Type something.`,
    ] : undefined,
    placeholder: method === "input" ? "" : undefined,
  };
}

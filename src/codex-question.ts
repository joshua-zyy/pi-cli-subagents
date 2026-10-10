import type { QuestionAnswers, QuestionField } from "./types.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Question normalization and ID-keyed reply mapping adapted from Paseo (Apache-2.0).
 * Copyright (c) 2025-present Mohamed Boudra; see README.md#credits.
 * Modified: validate the installed Codex contract, preserve IDs/text, never guess an answer.
 */
export function readCodexQuestionFields(input: unknown): QuestionField[] | undefined {
  if (!Array.isArray(input) || !input.length) return;
  const fields: QuestionField[] = [];
  for (const q of input) {
    if (!object(q) || typeof q.id !== "string" || !q.id.trim() || fields.some(field => field.id === q.id) ||
      typeof q.header !== "string" || !q.header.trim() || typeof q.question !== "string" || !q.question.trim() ||
      q.isOther !== undefined && typeof q.isOther !== "boolean" || q.isSecret !== undefined && typeof q.isSecret !== "boolean" ||
      q.options != null && !Array.isArray(q.options) || q.multiSelect !== undefined && q.multiSelect !== false) return;
    // Codex 0.159.2 core/src/mcp_tool_call.rs reserves this namespace for MCP approvals,
    // including session-wide and persisted grants. They are not task questions.
    if (q.id.startsWith("mcp_tool_call_approval")) return;
    const options: QuestionField["options"] = [];
    for (const option of (q.options ?? []) as unknown[]) {
      if (!object(option) || typeof option.label !== "string" || !option.label.trim() ||
        typeof option.description !== "string" || options.some(prior => prior.label === option.label)) return;
      options.push({ label: option.label, description: option.description });
    }
    fields.push({ id: q.id, header: q.header, question: q.question, options,
      allowOther: !options.length || q.isOther === true, isSecret: q.isSecret === true });
  }
  return fields;
}

/**
 * Async-message normalization adapted from Paseo's codex/async-questions.ts
 * at 29db2b79809fc032860ff4e8ee360fbe0073c3e9 (Apache-2.0; copyright above).
 * Reuse the existing form contract; indices identify questions, not native RPC requests.
 */
export function readCodexAsyncQuestionFields(item: unknown): QuestionField[] | undefined {
  if (!object(item) || item.type !== "agentMessage" || item.delivery !== "async" ||
    typeof item.id !== "string" || !item.id.trim() || !Array.isArray(item.questions) || !item.questions.length) return;
  const questions = [];
  for (const [index, question] of item.questions.entries()) {
    if (!object(question) || question.options != null && !Array.isArray(question.options)) return;
    questions.push({ id: String(index), header: `Question ${index + 1}`, question: question.title,
      options: ((question.options ?? []) as unknown[]).map(label => ({ label, description: "" })), isOther: true });
  }
  return readCodexQuestionFields(questions)?.map(field => ({ ...field, multiSelect: false, required: true }));
}

/** Used before the worker's audit and again at the native reply boundary. */
export function validateQuestionAnswers(fields: readonly QuestionField[], input: unknown): QuestionAnswers {
  if (!fields.length || !object(input) || Object.keys(input).length !== fields.length ||
    fields.some(field => !Object.hasOwn(input, field.id))) throw new Error("Provide answers for exactly the current form field IDs");
  return Object.fromEntries(fields.map(field => {
    const values = input[field.id];
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Each field answer must be a string array");
    if (field.required && (values.length !== 1 || !values[0].trim())) throw new Error(`Required field ${field.id} needs one non-blank answer`);
    if (field.multiSelect === false && values.length > 1) throw new Error(`Field ${field.id} accepts at most one answer`);
    if (field.multiSelect === true && values.length > field.options.length + Number(field.allowOther))
      throw new Error(`Too many answers for multi-select field ${field.id}`);
    if (!field.allowOther && values.some(value => !field.options.some(option => option.label === value)))
      throw new Error(`Answer for field ${field.id} is not an offered choice`);
    return [field.id, [...values]];
  }));
}

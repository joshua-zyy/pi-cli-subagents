import type { QuestionField } from "./types.js";
import { validateQuestionAnswers } from "./codex-question.js";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hintKeys = ["kind", "description", "placeholder", "min", "max", "step", "defaultValue", "unit"];
const fieldKeys = ["question", "header", "options", "multiSelect", ...hintKeys];

/** Decode the built-in Claude 2.1.283 card, not arbitrary tools with question-like input. */
export function readClaudeQuestionFields(input: unknown): QuestionField[] | undefined {
  // Apply the audited strict-card rules locally; their activation on native stdio is unverified.
  // Never carry host-owned answers, annotations, response, followUp or afkTimeoutMs from model input.
  if (!object(input) || Object.keys(input).some(key => !["questions", "title", "metadata"].includes(key)) ||
    !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4 ||
    input.title !== undefined && typeof input.title !== "string" ||
    input.metadata !== undefined && (!object(input.metadata) || Object.keys(input.metadata).some(key => key !== "source") ||
      input.metadata.source !== undefined && typeof input.metadata.source !== "string")) return;
  const fields: QuestionField[] = [];
  for (const q of input.questions) {
    if (!object(q) || Object.keys(q).some(key => !fieldKeys.includes(key)) ||
      typeof q.question !== "string" || fields.some(field => field.id === q.question) ||
      typeof q.header !== "string" ||
      q.multiSelect !== undefined && typeof q.multiSelect !== "boolean" ||
      [q.description, q.placeholder, q.unit].some(value => value !== undefined && typeof value !== "string")) return;
    const kind = q.kind === undefined ? "choice" : q.kind;
    if (typeof kind !== "string" || !["choice", "text", "number"].includes(kind) ||
      kind !== "text" && q.placeholder !== undefined ||
      kind !== "number" && [q.min, q.max, q.step, q.defaultValue, q.unit].some(value => value !== undefined)) return;
    if (kind === "number" && (typeof q.min !== "number" || !Number.isFinite(q.min) || typeof q.max !== "number" || !Number.isFinite(q.max) || q.min >= q.max ||
      q.step !== undefined && (typeof q.step !== "number" || !Number.isFinite(q.step) || q.step <= 0) ||
      q.defaultValue !== undefined && (typeof q.defaultValue !== "number" || !Number.isFinite(q.defaultValue) || q.defaultValue < q.min || q.defaultValue > q.max))) return;
    const rawOptions = q.options === undefined && kind !== "choice" ? [] : q.options;
    if (!Array.isArray(rawOptions) || rawOptions.length > 4 || (kind === "choice" ? rawOptions.length < 2 : rawOptions.length !== 0 || q.multiSelect === true)) return;
    const options: QuestionField["options"] = [];
    for (const option of rawOptions) {
      if (!object(option) || Object.keys(option).some(key => !["label", "description", "preview"].includes(key)) ||
        typeof option.label !== "string" || options.some(prior => prior.label === option.label) ||
        option.description !== undefined && typeof option.description !== "string" ||
        option.preview !== undefined && typeof option.preview !== "string") return;
      options.push({ label: option.label, description: option.description ?? "", ...(option.preview !== undefined ? { preview: option.preview } : {}) });
    }
    const hints = Object.fromEntries(hintKeys.flatMap(key => q[key] === undefined ? [] : [[key, q[key]]]));
    fields.push({ id: q.question, header: q.header, question: q.question, options, multiSelect: q.multiSelect === true,
      allowOther: true, isSecret: false, ...(Object.keys(hints).length ? { description: JSON.stringify(hints) } : {}) });
  }
  return fields;
}

/** Validate before audit and again before transport. Let Claude encode multi-select arrays. */
export function claudeQuestionAnswers(fields: readonly QuestionField[], input: unknown): Record<string, string | string[]> {
  const answers = validateQuestionAnswers(fields, input);
  let textSize = 0;
  const entries = fields.map(field => {
    const values = answers[field.id];
    if (values.some(value => value.length > 8192)) throw new Error("Claude answer exceeds the native 8192-character limit");
    const value = field.multiSelect ? values : values[0] ?? "";
    // Budget against 2.1.283's strict-card encoding, without assuming stdio selects that policy.
    if (Array.isArray(value)) {
      const encoded = value.map(item => item.includes(", ") || item.includes('"') ? JSON.stringify(item) : item).join(", ");
      textSize += encoded.length;
    } else textSize += value.length;
    return [field.id, value];
  });
  if (textSize > 32_768 || textSize + fields.reduce((size, field) => size + field.id.length, 0) > 48_000)
    throw new Error("Claude answers are too large for the native card admission limit");
  return Object.fromEntries(entries);
}

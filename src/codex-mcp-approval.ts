const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

interface McpAction { type: "mcpToolCall"; id: string; status: "inProgress"; server: string; tool: string; arguments: unknown }

function liveMcpAction(item: unknown): item is McpAction {
  if (!object(item) || item.type !== "mcpToolCall" || item.status !== "inProgress" ||
    typeof item.id !== "string" || !item.id.trim() || typeof item.server !== "string" || !item.server.trim() ||
    typeof item.tool !== "string" || !item.tool.trim() || item.arguments === undefined) return false;
  return true;
}

function mcpMessage(item: McpAction, request: string): string | undefined {
  const message = JSON.stringify({ server: item.server, tool: item.tool, arguments: item.arguments, request }, null, 2)
    + "\nOnly a single call may be approved. Session/persistent grants are not supported. Cancellation follows the native request; the CLI decides whether the turn continues.";
  return message.length <= 12_000 ? message : undefined;
}

/**
 * Single-action/persistent permission separation adapted from Lody's permissions/mcp.ts
 * (acp-extension-codex 60f1dc4, Apache-2.0; Copyright 2025 JetBrains s.r.o.).
 * Native envelope/labels: OpenAI Codex rust-v0.159.2, core/src/mcp_tool_call.rs:1460,1906.
 * Modified: bind the legacy question to a live action and expose only Allow/Cancel.
 * See README.md#credits for source and license details.
 */
export function readCodexMcpApproval(input: unknown, item: unknown): { questionId: string; message: string } | undefined {
  if (!liveMcpAction(item) || !Array.isArray(input) || input.length !== 1) return;
  const q: unknown = input[0];
  if (!object(q) || typeof q.id !== "string" || q.id !== `mcp_tool_call_approval_${item.id}` ||
    typeof q.header !== "string" || typeof q.question !== "string" || !q.question.trim() ||
    q.isOther !== undefined && q.isOther !== false || q.isSecret !== undefined && q.isSecret !== false ||
    q.multiSelect !== undefined && q.multiSelect !== false ||
    !Array.isArray(q.options)) return;
  const labels: string[] = [];
  for (const option of q.options as unknown[]) {
    if (!object(option) || typeof option.label !== "string" || typeof option.description !== "string" ||
      !["Allow", "Allow for this session", "Allow and don't ask me again", "Cancel"].includes(option.label) ||
      labels.includes(option.label)) return;
    labels.push(option.label);
  }
  if (!labels.includes("Allow") || !labels.includes("Cancel")) return;
  const message = mcpMessage(item, q.question);
  return message ? { questionId: q.id, message } : undefined;
}

/**
 * Lody CodexElicitationHandler.isMessageOnlyForm + permissions/mcp.ts marker contract
 * (same pinned source/license above), narrowed to a known native action and no form input.
 * Native request/response: OpenAI Codex rust-v0.159.2, core/src/mcp_tool_call.rs:1971-2160.
 * Explicit null schema is the legacy message-only shape; no schema URI is fetched.
 */
export function readCodexMcpElicitation(input: unknown, item: unknown): { message: string } | undefined {
  if (!object(input) || !liveMcpAction(item) || input.serverName !== item.server ||
    typeof input.mode !== "string" || !["form", "openai/form", "openaiForm"].includes(input.mode) ||
    !object(input._meta) || input._meta.codex_approval_kind !== "mcp_tool_call" ||
    typeof input.message !== "string" || !input.message.trim()) return;
  const schema = input.requestedSchema;
  if (schema !== null && (!object(schema) || schema.type !== "object" || !object(schema.properties) ||
    Object.keys(schema.properties).length !== 0 ||
    schema.required != null && (!Array.isArray(schema.required) || schema.required.length !== 0) ||
    schema.$schema != null && typeof schema.$schema !== "string" ||
    Object.keys(schema).some(key => !["type", "properties", "required", "$schema"].includes(key)))) return;
  const message = mcpMessage(item, input.message);
  return message ? { message } : undefined;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Single-action/persistent permission separation adapted from Lody's permissions/mcp.ts
 * (acp-extension-codex 60f1dc4, Apache-2.0; Copyright 2025 JetBrains s.r.o.).
 * Native envelope/labels: OpenAI Codex rust-v0.159.2, core/src/mcp_tool_call.rs:1460,1906.
 * Modified: bind the legacy question to a live action and expose only Allow/Cancel.
 * See README.md#credits for source and license details.
 */
export function readCodexMcpApproval(input: unknown, item: unknown): { questionId: string; message: string } | undefined {
  if (!object(item) || item.type !== "mcpToolCall" || item.status !== "inProgress" ||
    typeof item.id !== "string" || !item.id.trim() || typeof item.server !== "string" || !item.server.trim() ||
    typeof item.tool !== "string" || !item.tool.trim() || item.arguments === undefined ||
    !Array.isArray(input) || input.length !== 1) return;
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
  const message = JSON.stringify({ server: item.server, tool: item.tool, arguments: item.arguments, request: q.question }, null, 2)
    + "\nOnly a single call may be approved. Session/persistent grants are not supported. Cancel returns the native cancellation choice; the CLI decides whether the turn continues.";
  if (message.length > 12_000) return;
  return { questionId: q.id, message };
}

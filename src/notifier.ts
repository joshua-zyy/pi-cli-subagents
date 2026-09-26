import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./manager.js";

export const customType = "cli-subagents-report";

export function deliveredIds(ctx: Pick<ExtensionContext, "sessionManager">): Set<string> {
  const ids = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom_message" || entry.customType !== customType) continue;
    const details = entry.details as { ids?: unknown } | undefined;
    if (Array.isArray(details?.ids)) for (const id of details.ids) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** Completion events are stored by the worker. The session's own custom messages are the receipt. */
export function deliverReports(
  manager: Pick<AgentManager, "reports">,
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: Pick<ExtensionContext, "sessionManager">,
  pending: Set<string>,
): void {
  const delivered = deliveredIds(ctx);
  for (const id of pending) if (delivered.has(id)) pending.delete(id);
  const reports = manager.reports().filter((report) => !delivered.has(report.notificationId) && !pending.has(report.notificationId));
  if (!reports.length) return;
  const ids = reports.map((report) => report.notificationId);
  const content = reports.map((report) => [
    `[Subagent ${report.agentId} · ${report.status}]`,
    report.error ? `Error: ${report.error}` : "",
    report.text || (report.error ? "" : report.status === "waiting" ? "Waiting for a response; inspect with list_pending_permissions or /agent-reply." : "No text response; inspect with list_agents or /agents."),
  ].filter(Boolean).join("\n")).join("\n\n");
  for (const id of ids) pending.add(id);
  try {
    pi.sendMessage({ customType, content, display: true, details: { ids } }, { triggerTurn: true, deliverAs: "followUp" });
  } catch (error) {
    for (const id of ids) pending.delete(id);
    throw error;
  }
}

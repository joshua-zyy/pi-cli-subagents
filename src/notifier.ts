import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./manager.js";
import type { AgentView } from "./types.js";

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
  now = Date.now(),
  states?: readonly AgentView[],
): void {
  const delivered = deliveredIds(ctx);
  for (const id of pending) if (delivered.has(id)) pending.delete(id);
  const reports = manager.reports(now, states).filter((report) => !delivered.has(report.notificationId) && !pending.has(report.notificationId));
  if (!reports.length) return;
  // Old reports (including those found on reconnect) are ready immediately. New
  // successful runs share a short window; attention events flush the window.
  const urgent = reports.some((report) => report.status !== "completed");
  const firstSuccess = reports.find((report) => report.status === "completed");
  if (!urgent && firstSuccess && now < firstSuccess.time + 2000) return;
  const ids = reports.map((report) => report.notificationId);
  const content = reports.map((report) => {
    let raw = report.text;
    if (report.error) raw = `Error: ${report.error}\n${raw}`.trim();
    if (!raw) raw = report.status === "waiting"
      ? "Waiting for a response; inspect with list_pending_permissions or /agent-reply."
      : "No text response; inspect with list_agents or /agents.";
    const clipped = raw.length > 2400;
    const summary = clipped ? `${raw.slice(0, 1000)}\n…\n${raw.slice(-1300)}\n(truncated; inspect list_agents({id: \"${report.agentId}\"}) or /agents; raw log holds the full transcript)` : raw;
    const replyHint = report.status === "waiting" ? `\nQuestion ID: ${report.questionId ?? "inspect pending requests"}; use list_pending_permissions and respond_to_permission, or /agent-reply.` : "";
    return `[Subagent ${report.agentId} · ${report.status}]\n${summary}${replyHint}`;
  }).join("\n\n");
  for (const id of ids) pending.add(id);
  try {
    pi.sendMessage({ customType, content, display: true, details: { ids } }, { triggerTurn: true, deliverAs: "steer" });
  } catch (error) {
    for (const id of ids) pending.delete(id);
    throw error;
  }
}

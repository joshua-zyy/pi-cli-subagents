import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./manager.js";
import type { AgentView, Report } from "./types.js";

export const customType = "cli-subagents-report";

/**
 * Notifications are bounded previews, not complete evidence. Keep more of the original tail than
 * the head, count omitted characters, and link to the exact run so every omitted part is retrievable.
 */
const REPORT_HEAD = 2000;
const REPORT_TAIL = 3600;
const REPORT_LIMIT = REPORT_HEAD + REPORT_TAIL;
const WAITING_STATUS_KEY = "subagent-waiting";

/** A request may offer many values, so the rendered list stays bounded. */
const OFFERED_LIMIT = 12;
const quoted = (values: readonly string[]): string =>
  `${values.slice(0, OFFERED_LIMIT).map((value) => JSON.stringify(value)).join(", ")}${values.length > OFFERED_LIMIT ? ", …" : ""}`;

/** A native human-only policy can still list refusal choices the parent may submit. */
function needsHumanApproval(request: Report["request"]): boolean {
  return request?.humanOnly === true || !(request?.method === "confirm"
    ? request.parentPolicy?.confirm === true : request?.parentPolicy?.values?.length);
}

/**
 * What the parent needs in order to answer on the first attempt: the request kind, the values it
 * offers, and which of them this extension has established the parent may submit. Values outside
 * that set are named rather than summarised, because a standing grant is exactly what the parent
 * must not choose by accident.
 */
function waitingAnswerLine(report: Report): string {
  const id = report.questionId ?? "inspect the instance with subagent_query";
  const request = report.request;
  if (!request) return `\nQuestion ID: ${id}; inspect the request with subagent_query before answering, then use subagent_reply or /agent-reply.`;
  const offered = request.options?.length ? `; offered: ${quoted(request.options)}` : "";
  const human = `/agent-reply ${report.agentId} ${id}`;
  const header = `\nQuestion ID: ${id} (${request.method}${offered}).`;
  const review = " Handle this request now with subagent_reply within the user's task authorization; do not wait for routine human approval.";
  if (request.method === "confirm") return !needsHumanApproval(request)
    ? `${header} You may submit confirmed: true or false, or cancelled.${review}`
    : `${header} You may only refuse it (confirmed: false or cancelled); the human answers it with ${human}.`;
  const allowed = request.parentPolicy?.values ?? [];
  if (!allowed.length) return `${header} You may only refuse it (cancelled); the human answers it with ${human}.`;
  const permitted = `${header} You may submit ${quoted(allowed)}, or cancelled.`;
  if (needsHumanApproval(request)) return `${permitted} Approval requires the human: ${human}.`;
  const rest = (request.options ?? []).filter((value) => !allowed.includes(value));
  return `${permitted}${review}${rest.length ? ` The other options (${quoted(rest)}) require a wider grant; involve the human only if that grant is needed: ${human}.` : ""}`;
}

/**
 * Keep pending requests visible without asking the human to take over routine parent decisions.
 * Only requests that require human approval raise a warning. The status follows live questions,
 * not notification receipts: receiving a request does not mean it has been answered.
 */
function surfaceWaitingForHuman(
  ui: Pick<ExtensionContext["ui"], "setStatus" | "notify">,
  states: readonly AgentView[] | undefined,
  reports: readonly Report[],
): void {
  const waiting = (states ?? []).filter((state) => state.questions.length);
  const human = waiting.flatMap((state) => state.questions.flatMap((question) =>
    needsHumanApproval(question) ? [{ id: state.id, questionId: question.id }] : []));
  let status: string | undefined;
  if (human.length) status = `${human.length} child request${human.length === 1 ? " needs" : "s need"} your decision: /agent-reply ${human[0].id} ${human[0].questionId}`;
  else if (waiting.length) status = `${waiting.length} subagent${waiting.length === 1 ? "" : "s"} waiting for parent review; /agents to inspect or intervene`;
  ui.setStatus(WAITING_STATUS_KEY, status);
  for (const report of reports) {
    if (report.status !== "waiting" || !needsHumanApproval(report.request)) continue;
    ui.notify(`Subagent ${report.agentId} is waiting for an answer: /agent-reply ${report.agentId} ${report.questionId ?? "<questionId>"}`, "warning");
  }
}

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
  manager: Pick<AgentManager, "reports" | "getResult">,
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: Pick<ExtensionContext, "sessionManager" | "ui">,
  pending: Set<string>,
  now = Date.now(),
  states?: readonly AgentView[],
): void {
  const delivered = deliveredIds(ctx);
  for (const id of pending) if (delivered.has(id)) pending.delete(id);
  const reports = manager.reports(now, states).filter((report) => !delivered.has(report.notificationId) && !pending.has(report.notificationId));
  // Runs even when nothing new is delivered, so the status clears once a request is answered. The
  // caller already guards report delivery, so a UI failure cannot lose a report.
  surfaceWaitingForHuman(ctx.ui, states, reports);
  if (!reports.length) return;
  // Old reports (including those found on reconnect) are ready immediately. New
  // successful runs share a short window; attention events flush the window.
  const urgent = reports.some((report) => report.status !== "completed");
  const firstSuccess = reports.find((report) => report.status === "completed");
  if (!urgent && firstSuccess && now < firstSuccess.time + 2000) return;
  const prepared = reports.flatMap((report) => {
    try {
      // Only final reports have this stable ID; waiting/inactivity/unreachable are attention events.
      const final = report.notificationId === `${report.runId}-result`;
      // Load full text only after receipt filtering and coalescing; never grow the history cache.
      const source = final ? manager.getResult(report.agentId, report.runId) : report;
      let raw = source.text;
      if (source.error) raw = `Error: ${source.error}\n${raw}`.trim();
      if (!raw) raw = report.status === "waiting"
        ? "Waiting for a response; inspect it with subagent_query or /agent-reply."
        : "No text response; inspect with subagent_query or /agents.";
      const clipped = raw.length > REPORT_LIMIT;
      const summary = clipped ? `${raw.slice(0, REPORT_HEAD)}\n… ${raw.length - REPORT_LIMIT} characters omitted …\n${raw.slice(-REPORT_TAIL)}\n(truncated preview)` : raw;
      const resultHint = final ? `\nRead result: subagent_query(${JSON.stringify({ action: "result", id: report.agentId, runId: report.runId })})` : "";
      const replyHint = report.status === "waiting" ? waitingAnswerLine(report) : "";
      return [{ report, content: `[Subagent ${report.agentId} · ${report.status}]\n${summary}${resultHint}${replyHint}` }];
    } catch (error) {
      console.error(`[pi-cli-subagents] Could not prepare report ${report.notificationId} (subagent ${report.agentId}, run ${report.runId}); left undelivered:`, error);
      return [];
    }
  });
  if (!prepared.length) return;
  const ids = prepared.map(({ report }) => report.notificationId);
  const content = prepared.map(({ content }) => content).join("\n\n");
  for (const id of ids) pending.add(id);
  try {
    // Display metadata is separate from model-facing content and the receipt IDs.
    const displayReports = prepared.map(({ report: { agentId, status } }) => ({ agentId, status }));
    // A blocked child needs a decision before the parent's next model request, not after it
    // finishes all work. Other batches remain follow-ups; neither mode aborts a running tool.
    const deliverAs = prepared.some(({ report }) => report.status === "waiting") ? "steer" : "followUp";
    pi.sendMessage({ customType, content, display: true, details: { ids, reports: displayReports } }, { triggerTurn: true, deliverAs });
  } catch (error) {
    for (const id of ids) pending.delete(id);
    throw error;
  }
}

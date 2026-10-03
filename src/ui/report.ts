import { getMarkdownTheme, keyText, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import type { Report } from "../types.js";
import { oneLine } from "./format.js";

type DisplayReport = Pick<Report, "agentId" | "status">;
const STATUS_ORDER: Report["status"][] = ["failed", "waiting", "stalled", "stopped", "completed"];

/** Presentation only: Pi owns expansion, and the original message/receipt is never changed. */
export const renderReportMessage: MessageRenderer = (message, { expanded, outputPad }, theme) => {
  const candidates = (message.details as { reports?: DisplayReport[] } | undefined)?.reports;
  // Old notifications have receipts but no display metadata. Do not guess their status from prose.
  const reports = Array.isArray(candidates) && candidates.every(report => report && typeof report.agentId === "string" && STATUS_ORDER.includes(report.status))
    ? candidates : [];
  const failed = reports.some(report => report.status === "failed");
  const attention = !reports.length || reports.some(report => report.status !== "completed");
  const color = failed ? "error" : attention ? "warning" : "success";
  const icon = failed ? "✗" : attention ? "⚠" : "✓";
  const statuses = STATUS_ORDER.flatMap(status => {
    const count = reports.filter(report => report.status === status).length;
    return count ? [`${count} ${status}`] : [];
  });
  const label = reports.length === 1
    ? `Subagent ${oneLine(reports[0].agentId, 8)} · ${reports[0].status}`
    : reports.length ? `Subagents · ${statuses.join(" · ")}` : "Subagent report · status unavailable";
  const key = keyText("app.tools.expand");
  const hint = key ? `${key} to ${expanded ? "collapse" : "expand"}` : "expand key unbound";
  const title = `${theme.fg(color, `${expanded ? "▾" : "▸"} ${icon} ${label}`)}${attention ? theme.fg("warning", " · /agents") : ""}${theme.fg("dim", ` · ${hint}`)}`;
  const card = new Container();
  card.addChild({
    render(width: number): string[] {
      if (width <= 0) return [];
      const padding = Math.min(outputPad, Math.floor((width - 1) / 2));
      const pad = " ".repeat(padding);
      return [`${pad}${truncateToWidth(title, width - 2 * padding)}${pad}`];
    },
    invalidate() {},
  });
  if (expanded) {
    const text = typeof message.content === "string" ? message.content
      : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    card.addChild(new Spacer(1));
    card.addChild(new Markdown(stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""), outputPad, 0,
      getMarkdownTheme(), { color: value => theme.fg("customMessageText", value) }));
  }
  return card;
};

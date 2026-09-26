import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentView } from "../types.js";
import { canMessage, canSteer, formatElapsed, isActive, isTerminal, oneLine, phaseColor, phaseIcon, phaseLabel, rightAlign, viewElapsed, SPINNER, type UiColor, type UiTheme } from "./format.js";

export type PanelAction =
  | { kind: "view"; id: string }
  | { kind: "message"; id: string; resume: boolean }
  | { kind: "stop"; id: string }
  | { kind: "reply"; id: string; questionId: string };

export const PANEL_MAX_ROWS = 8;
const RESULT_VIEW_LINES = 8;
const TASK_VIEW_LINES = 4;
const QUESTION_VIEW_LINES = 4;
/** Reserve space for scroll indicators, questions and keyboard hints below the result. */
const PANEL_RESERVED_LINES = 8;

const isText = (value: string | undefined): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Snapshot-based /agents selector.
 * It returns actions; the command handler performs send/close/reply after the panel closes.
 */
export class AgentsPanel {
  private readonly agents: AgentView[];
  private readonly now: number;
  private readonly maxRows: number;
  private readonly rowLimit: () => number;
  private view: "list" | "detail" = "list";
  private index = 0;
  private scroll = 0;
  private bodyLines = 0;
  private pageLines = RESULT_VIEW_LINES;
  private settled = false;

  constructor(
    agents: AgentView[],
    private readonly theme: UiTheme,
    private readonly done: (action: PanelAction | undefined) => void,
    options: { now?: number; maxRows?: number; rows?: number | (() => number) } = {},
  ) {
    this.agents = [...(Array.isArray(agents) ? agents : [])]
      .sort((a, b) => (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt));
    this.now = options.now ?? Date.now();
    this.maxRows = options.maxRows ?? PANEL_MAX_ROWS;
    const rows = options.rows;
    this.rowLimit = typeof rows === "function" ? rows : () => rows ?? 0;
  }

  private get rows(): number {
    const rows = this.rowLimit();
    return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
  }

  get mode(): "list" | "detail" { return this.view; }
  get selection(): number { return this.index; }

  invalidate(): void { /* No cache */ }

  handleInput(data: string): void {
    if (this.settled) return;
    const agent = this.agents[this.index];
    if (this.view === "list") {
      if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, "down")) this.index = Math.min(this.agents.length - 1, this.index + 1);
      else if (agent && (matchesKey(data, "return") || matchesKey(data, "v"))) this.finish({ kind: "view", id: agent.id });
      else if (agent && matchesKey(data, "i")) { this.view = "detail"; this.scroll = 0; }
      else if (matchesKey(data, "escape") || matchesKey(data, "q")) this.finish(undefined);
      return;
    }
    // Waiting children require /agent-reply; completed instances resume as a new run in the same session.
    const question = agent?.phase === "waiting" ? agent.questions?.[0] : undefined;
    const steerable = agent ? canSteer(agent.phase) : false;
    if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "h")) this.view = "list";
    else if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "down")) this.scroll = Math.min(Math.max(0, this.bodyLines - this.pageLines), this.scroll + 1);
    else if (agent && matchesKey(data, "s") && canMessage(agent.phase)) this.finish({ kind: "message", id: agent.id, resume: !steerable });
    else if (agent && matchesKey(data, "v")) this.finish({ kind: "view", id: agent.id });
    else if (agent && matchesKey(data, "x") && !isTerminal(agent.phase)) this.finish({ kind: "stop", id: agent.id });
    else if (agent && question && matchesKey(data, "r")) this.finish({ kind: "reply", id: agent.id, questionId: question.id });
    else if (matchesKey(data, "q")) this.finish(undefined);
  }

  render(width: number): string[] {
    let lines = this.view === "list" ? this.renderList(width) : this.renderDetail(width);
    const rows = this.rows;
    if (rows > 0 && lines.length > rows) {
      lines = [...lines.slice(0, Math.max(0, rows - 2)), ...(rows > 1 ? [this.theme.fg("dim", "... (v opens the conversation)")] : []), lines[this.view === "list" ? 1 : lines.length - 1]];
    }
    return width > 0 ? lines.map((line) => truncateToWidth(line, width)) : lines;
  }

  private finish(action: PanelAction | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.done(action);
  }

  private hint(items: [string, string][]): string {
    return items.map(([key, label]) => `${this.theme.fg("dim", key)}${this.theme.fg("muted", ` ${label}`)}`)
      .join(this.theme.fg("dim", " · "));
  }
  private field(label: string, value: string): string {
    return `${this.theme.fg("dim", `${label} `)}${this.theme.fg("text", oneLine(value, 400))}`;
  }
  private section(title: string): string {
    return this.theme.bold(this.theme.fg("accent", title));
  }
  /** Wrap by visible terminal width, indent, and cap exceptionally long results. */
  private wrapBody(text: string, width: number, limit: number): string[] {
    const room = Math.max(1, width - 2);
    return stripTerminalSequences(text)
      .split(/\r?\n/)
      .flatMap((line) => (line.trim() ? wrapTextWithAnsi(line.trimEnd(), room) : [""]))
      .slice(0, limit)
      .map((line) => `  ${line}`);
  }

  private renderList(width: number): string[] {
    const lines = [this.theme.bold(this.theme.fg("accent", `Subagents (${this.agents.length})`))];
    if (!this.agents.length) {
      lines.push(this.theme.fg("dim", "No subagents in this session"));
      lines.push(this.hint([["esc", "close"]]));
      return lines;
    }
    lines.push(this.hint([["↑↓", "select"], ["enter/v", "conversation"], ["i", "details"], ["esc", "close"]]));
    const selected = Math.min(this.index, this.agents.length - 1);
    const visible = Math.min(this.maxRows, this.agents.length, this.rows > 0 ? Math.max(1, this.rows - 4) : this.maxRows);
    const start = selected < visible ? 0 : selected - visible + 1;
    const hiddenAbove = start;
    if (hiddenAbove > 0) lines.push(rightAlign("", this.theme.fg("dim", `↑ ${hiddenAbove} more`), width));
    for (let index = start; index < start + visible; index++) lines.push(this.agentRow(index, selected, width));
    const hiddenBelow = this.agents.length - start - visible;
    if (hiddenBelow > 0) lines.push(rightAlign("", this.theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    return lines;
  }

  private agentRow(index: number, selected: number, width: number): string {
    const agent = this.agents[index];
    const current = index === selected;
    const bullet = current ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○");
    const icon = isActive(agent.phase) ? SPINNER[0] : phaseIcon(agent.phase);
    const role = current ? this.theme.bold(this.theme.fg("text", agent.role)) : this.theme.fg("muted", agent.role);
    const task = oneLine(agent.task, 80) || "(No task summary)";
    const stats = `${phaseLabel(agent.phase)} · ${formatElapsed(viewElapsed(agent, this.now))}`;
    const left = `  ${bullet} ${this.theme.fg(phaseColor(agent.phase), icon)} ${role}  ${current ? this.theme.fg("text", task) : this.theme.fg("dim", task)}`;
    return rightAlign(left, current ? this.theme.fg("text", stats) : this.theme.fg("dim", stats), width);
  }

  private renderDetail(width: number): string[] {
    const agent = this.agents[this.index];
    if (!agent) { this.view = "list"; return this.renderList(width); }
    const lines = [
      this.theme.bold(this.theme.fg("accent", `Subagent ${agent.role} · ${phaseLabel(agent.phase)}`)),
      this.field("ID", agent.id),
      this.field("Directory", agent.cwd),
      this.field("Elapsed", formatElapsed(viewElapsed(agent, this.now))),
      this.field("Session", agent.sessionId ?? "None"),
      this.field("Log", agent.logFile),
      "",
      this.section("Task"),
      ...this.wrapBody(isText(agent.task) ? agent.task : "(No task summary)", width, TASK_VIEW_LINES),
      "",
      this.section("Latest activity"),
      ...this.wrapBody(isText(agent.lastActivity) ? oneLine(agent.lastActivity, 200) : "None", width, 1),
      "",
    ];

    const question = agent.phase === "waiting" ? agent.questions?.[0] : undefined;
    if (question && this.rows > 0 && this.rows < 26) {
      return [lines[0], this.field("ID", agent.id), this.section("Waiting for a response"),
        ...this.wrapBody(question.title, width, Math.max(1, this.rows - 6)),
        this.theme.fg("dim", `  /agent-reply ${agent.id} ${question.id}`),
        this.hint([["r", "reply"], ["v", "conversation"], ["esc", "back"], ["q", "close"]])];
    }
    if (question) {
      lines.push(this.section("Waiting for a response"));
      lines.push(...this.wrapBody(question.title, width, QUESTION_VIEW_LINES));
      lines.push(this.theme.fg("dim", `  /agent-reply ${agent.id} ${question.id}`), "");
    }

    const error = isText(agent.error) ? agent.error : undefined;
    const source = [error, isText(agent.text) ? agent.text : undefined].filter(Boolean).join("\n\n") || undefined;
    const color: UiColor = error === undefined ? "text" : "error";
    const body = source === undefined ? [] : this.wrapBody(source, width, 10_000);
    const page = this.rows > 0 ? Math.max(2, Math.min(RESULT_VIEW_LINES, this.rows - lines.length - PANEL_RESERVED_LINES)) : RESULT_VIEW_LINES;
    this.bodyLines = body.length;
    this.pageLines = page;
    lines.push(this.section(error === undefined ? "Result" : "Error"));
    if (!body.length) lines.push(this.theme.fg("dim", "  No text response; open the conversation or inspect the log."));
    this.scroll = Math.min(Math.max(0, this.scroll), Math.max(0, body.length - page));
    if (this.scroll > 0) lines.push(this.theme.fg("dim", `  ↑ ${this.scroll} lines above`));
    lines.push(...body.slice(this.scroll, this.scroll + page).map((line) => this.theme.fg(color, line)));
    const below = body.length - this.scroll - page;
    if (below > 0) lines.push(this.theme.fg("dim", `  ↓ ${below} lines below`));
    if (agent.truncated) lines.push(this.theme.fg("dim", "  ... (Result clipped; see the result file for full content)"));

    const hint: [string, string][] = [["esc/←", "back"], ["↑↓", "scroll"], ["v", "conversation"]];
    if (canSteer(agent.phase)) hint.push(["s", "message"]);
    else if (canMessage(agent.phase)) hint.push(["s", "resume"]);
    if (!isTerminal(agent.phase)) hint.push(["x", "stop"]);
    if (question) hint.push(["r", "reply"]);
    hint.push(["q", "close"]);
    lines.push("", this.hint(hint));
    return lines;
  }
}

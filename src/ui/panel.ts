import { matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentView } from "../types.js";
import { canInterrupt, canMessage, canResume, canRelease, isReleased, formatElapsed, framePane, isActive, oneLine, rightAlign, shortId, viewElapsed, viewStatus, PANE_FRAME_COLS, PANE_FRAME_MIN_WIDTH, PANE_FRAME_ROWS, SPINNER, type UiColor, type UiTheme } from "./format.js";

export type PanelAction =
  | { kind: "view"; id: string }
  | { kind: "message"; id: string; resume: boolean; message?: string }
  | { kind: "stop"; id: string; expected: { runId: string; runtimeId: string } }
  | { kind: "close-idle"; targets: AgentView[] }
  | { kind: "interrupt"; id: string }
  | { kind: "reply"; id: string; questionId: string };

export const PANEL_MAX_ROWS = 8;
const RESULT_VIEW_LINES = 8;
const TASK_VIEW_LINES = 4;
/** A short pane keeps only the head of the task, so the result keeps its own room. */
const COMPACT_TASK_LINES = 2;
const QUESTION_VIEW_LINES = 4;
/** Reserve space for scroll indicators, questions and keyboard hints below the result. */
const PANEL_RESERVED_LINES = 8;
/** Under this the detail view drops its metadata block, so the task and the result stay visible. */
const DETAIL_FULL_ROWS = 30;
const DETAIL_MIN_ROWS = 12;
const DETAIL_SHARE = 0.7;

/**
 * How many rows the pane above the editor may take. The roster stays as compact as the role editor;
 * the detail view carries a result to read, so it takes a share of the terminal instead of a block.
 */
export function paneRows(terminalRows: number, mode: "list" | "detail"): number {
  const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? Math.floor(terminalRows) : 24;
  const wanted = mode === "detail"
    ? Math.max(DETAIL_MIN_ROWS, Math.floor(rows * DETAIL_SHARE))
    : Math.max(6, Math.min(PANEL_MAX_ROWS + 4, Math.floor(rows / 3)));
  // Never take so much that the input box and its status line disappear.
  return Math.min(rows - 4, wanted);
}

const isText = (value: string | undefined): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Snapshot-based /agents roster, rendered as a pane above the editor like the role editor.
 * It returns actions; the command handler performs send/close/reply after the pane closes.
 */
export class AgentsPanel {
  private agents: AgentView[];
  private readonly allAgents: AgentView[];
  private showReleased = false;
  private readonly idleTargets: AgentView[];
  private readonly now: number;
  private readonly maxRows: number;
  private readonly rowLimit: () => number;
  private readonly frameColor?: (text: string) => string;
  private view: "list" | "detail" = "list";
  private index = 0;
  private scroll = 0;
  private bodyLines = 0;
  private pageLines = RESULT_VIEW_LINES;
  private framed = false;
  private settled = false;

  constructor(
    agents: AgentView[],
    private readonly theme: UiTheme,
    private readonly done: (action: PanelAction | undefined) => void,
    options: { now?: number; maxRows?: number; rows?: number | (() => number); frameColor?: (text: string) => string } = {},
  ) {
    this.allAgents = [...(Array.isArray(agents) ? agents : [])]
      .sort((a, b) => (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt));
    this.agents = this.allAgents.filter(agent => !isReleased(agent));
    this.idleTargets = this.agents.filter(canRelease);
    this.now = options.now ?? Date.now();
    this.maxRows = options.maxRows ?? PANEL_MAX_ROWS;
    this.frameColor = options.frameColor;
    const rows = options.rows;
    this.rowLimit = typeof rows === "function" ? rows : () => rows ?? 0;
  }

  private get rows(): number {
    const rows = this.rowLimit();
    return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 0;
  }

  /** Rows left for content once the frame is drawn; the pane height itself when unbounded. */
  private get room(): number {
    const rows = this.rows;
    if (rows <= 0) return 0;
    return this.framed ? Math.max(0, rows - PANE_FRAME_ROWS) : rows;
  }

  get mode(): "list" | "detail" { return this.view; }
  get selection(): number { return this.index; }

  invalidate(): void { /* No cache */ }

  handleInput(data: string): void {
    if (this.settled) return;
    const agent = this.agents[this.index];
    if (agent && matchesKey(data, "t") && canInterrupt(agent)) { this.finish({ kind: "interrupt", id: agent.id }); return; }
    if (this.view === "list") {
      if (matchesKey(data, "c") && this.idleTargets.length) { this.finish({ kind: "close-idle", targets: this.idleTargets }); return; }
      if (matchesKey(data, "h")) {
        this.showReleased = !this.showReleased;
        this.agents = this.showReleased ? this.allAgents : this.allAgents.filter(agent => !isReleased(agent));
        this.index = 0;
      }
      else if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, "down")) this.index = Math.min(this.agents.length - 1, this.index + 1);
      else if (agent && (matchesKey(data, "return") || matchesKey(data, "v"))) this.finish({ kind: "view", id: agent.id });
      else if (agent && matchesKey(data, "i")) { this.view = "detail"; this.scroll = 0; }
      else if (matchesKey(data, "escape") || matchesKey(data, "q")) this.finish(undefined);
      return;
    }
    // Waiting children require /agent-reply; idle starts a new run without native resume.
    const question = agent?.phase === "waiting" ? agent.questions?.[0] : undefined;
    if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "h")) this.view = "list";
    else if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "down")) this.scroll = Math.min(Math.max(0, this.bodyLines - this.pageLines), this.scroll + 1);
    else if (agent && matchesKey(data, "s") && canMessage(agent.phase)) this.finish({ kind: "message", id: agent.id, resume: canResume(agent.phase) });
    else if (agent && matchesKey(data, "v")) this.finish({ kind: "view", id: agent.id });
    else if (agent && matchesKey(data, "x") && canRelease(agent)) this.finish({ kind: "stop", id: agent.id, expected: { runId: agent.runId, runtimeId: agent.runtimeId } });
    else if (agent && question && matchesKey(data, "r")) this.finish({ kind: "reply", id: agent.id, questionId: question.id });
    else if (matchesKey(data, "q")) this.finish(undefined);
  }

  render(width: number): string[] {
    // The frame takes its columns from the content, so the body is laid out inside it.
    this.framed = width >= PANE_FRAME_MIN_WIDTH && (this.rows === 0 || this.rows > PANE_FRAME_ROWS);
    const inner = this.framed ? Math.max(1, width - PANE_FRAME_COLS) : width;
    let lines = this.view === "list" ? this.renderList(inner) : this.renderDetail(inner);
    const room = this.room;
    if (room > 0 && lines.length > room) {
      lines = [...lines.slice(0, Math.max(0, room - 2)), ...(room > 1 ? [this.theme.fg("dim", "…")] : []), lines[lines.length - 1]];
    }
    if (!this.framed) return width > 0 ? lines.map((line) => truncateToWidth(line, width)) : lines;
    return framePane(lines, width, this.frameColor ?? ((text: string) => this.theme.fg("dim", text)));
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
      lines.push(this.hint(this.allAgents.some(isReleased) ? [["h", "history"], ["esc", "close"]] : [["esc", "close"]]));
      return this.room > 0 ? lines.slice(0, this.room) : lines;
    }
    const selected = Math.min(this.index, this.agents.length - 1);
    const hints: [string, string][] = [["↑↓", "select"], ["enter/v", "conversation"], ["i", "details"], ["esc", "close"]];
    if (this.allAgents.some(isReleased)) hints.unshift(["h", this.showReleased ? "hide released" : "history"]);
    if (canInterrupt(this.agents[selected])) hints.unshift(["t", "interrupt"]);
    if (this.idleTargets.length) hints.unshift(["c", `release idle (${this.idleTargets.length})`]);
    lines.push(this.hint(hints));
    const limit = this.room || this.maxRows + lines.length + 2;
    // Keep one selectable row before headers, then charge only indicators that actually exist.
    const header = lines.slice(0, Math.max(0, limit - 1)), budget = limit - header.length;
    let visible = Math.max(1, Math.min(this.maxRows, this.agents.length, budget));
    let start = Math.max(0, selected - visible + 1);
    while (visible > 1 && visible + Number(start > 0) + Number(start + visible < this.agents.length) > budget) {
      visible--; start = Math.max(0, selected - visible + 1);
    }
    let spare = budget - visible;
    if (start > 0 && spare > 0) { header.push(rightAlign("", this.theme.fg("dim", `↑ ${start} more`), width)); spare--; }
    for (let index = start; index < start + visible; index++) header.push(this.agentRow(index, selected, width));
    const below = this.agents.length - start - visible;
    if (below > 0 && spare > 0) header.push(rightAlign("", this.theme.fg("dim", `↓ ${below} more`), width));
    return header;
  }

  private agentRow(index: number, selected: number, width: number): string {
    const agent = this.agents[index];
    const current = index === selected;
    // The cursor matches the role editor's, so the two panes read the same way.
    const cursor = current ? this.theme.fg("accent", "›") : " ";
    const status = viewStatus(agent);
    const icon = isActive(agent.phase) ? SPINNER[0] : status.icon;
    const role = current ? this.theme.bold(this.theme.fg("text", agent.role)) : this.theme.fg("muted", agent.role);
    const task = oneLine(agent.task, 80) || "(No task summary)";
    const stats = `${status.label} · ${formatElapsed(viewElapsed(agent, this.now))}`;
    const identity = `  ${cursor} ${this.theme.fg(status.color, icon)} ${role} ${this.theme.fg("dim", shortId(agent.id))}`;
    const left = `${identity}  ${current ? this.theme.fg("text", task) : this.theme.fg("dim", task)}`;
    // A long idle/outcome label must not crowd out the cursor or the instance's identity.
    if (width > 0 && visibleWidth(identity) + 2 + visibleWidth(stats) > width) return truncateToWidth(left, width, "");
    return rightAlign(left, current ? this.theme.fg("text", stats) : this.theme.fg("dim", stats), width);
  }

  private renderDetail(width: number): string[] {
    const agent = this.agents[this.index];
    if (!agent) { this.view = "list"; return this.renderList(width); }
    const room = this.room;
    // A short pane drops the metadata block first: the task, the question and the result matter
    // more, and `v` still shows the full record next to the transcript.
    const compact = room > 0 && room < DETAIL_FULL_ROWS;
    const status = viewStatus(agent);
    const title = this.theme.bold(this.theme.fg(status.color, `Subagent ${agent.role} · ${status.label}`));
    const lines = compact
      ? [title, this.field("ID", agent.id), ""]
      : [title,
        this.field("ID", agent.id),
        this.field("Directory", agent.cwd),
        this.field("Elapsed", formatElapsed(viewElapsed(agent, this.now))),
        this.field("Session", agent.sessionId ?? "None"),
        this.field("Log", agent.logFile),
        ""];
    lines.push(this.section("Task"));
    lines.push(...this.wrapBody(isText(agent.task) ? agent.task : "(No task summary)", width, compact ? COMPACT_TASK_LINES : TASK_VIEW_LINES));
    lines.push("", this.section("Latest activity"));
    lines.push(...this.wrapBody(isText(agent.lastActivity) ? oneLine(agent.lastActivity, 200) : "None", width, 1), "");

    const questions = agent.phase === "waiting" ? agent.questions ?? [] : [];
    const question = questions[0];
    // Answering needs no IDs: `r` takes the request on screen, and the next one after that.
    // Only the queue depth is worth stating, because the panel shows one request at a time.
    const queue = questions.length > 1
      ? [this.theme.fg("dim", `  ${questions.length} requests pending; r answers them one at a time`)] : [];
    if (question && room > 0 && room < DETAIL_FULL_ROWS) {
      const hints: [string, string][] = [["r", "reply"], ["v", "conversation"], ["esc", "back"], ["q", "close"]];
      if (canInterrupt(agent)) hints.unshift(["t", "interrupt"]);
      return [lines[0], this.field("ID", agent.id), this.section("Waiting for a response"),
        ...this.wrapBody(question.title, width, Math.max(1, room - 6)),
        ...queue,
        this.hint(hints)];
    }
    if (question) {
      lines.push(this.section("Waiting for a response"));
      lines.push(...this.wrapBody(question.title, width, QUESTION_VIEW_LINES));
      lines.push(...queue, "");
    }

    const error = isText(agent.error) ? agent.error : undefined;
    const source = [error, isText(agent.text) ? agent.text : undefined].filter(Boolean).join("\n\n") || undefined;
    const color: UiColor = error === undefined ? "text" : "error";
    const body = source === undefined ? [] : this.wrapBody(source, width, 10_000);
    const page = room > 0 ? Math.max(2, Math.min(RESULT_VIEW_LINES, room - lines.length - PANEL_RESERVED_LINES)) : RESULT_VIEW_LINES;
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
    if (canInterrupt(agent)) hint.unshift(["t", "interrupt"]);
    if (canRelease(agent)) hint.unshift(["x", "release"]);
    if (canMessage(agent.phase)) hint.push(["s", canResume(agent.phase) ? "resume" : agent.phase === "idle" ? "new task" : "message"]);
    if (question) hint.push(["r", "reply"]);
    hint.push(["q", "close"]);
    lines.push("", this.hint(hint));
    return lines;
  }
}

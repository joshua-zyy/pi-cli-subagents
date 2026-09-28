import { Input, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type KeyId, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { AgentView } from "../types.js";
import type { PanelAction } from "./panel.js";
import type { TranscriptEntry, TranscriptSnapshot } from "./transcript.js";
import { canMessage, canSteer, formatElapsed, formatTokens, isTerminal, oneLine, phaseColor, phaseIcon, phaseLabel, rightAlign, shortId, viewElapsed } from "./format.js";

export interface ConversationSnapshot extends TranscriptSnapshot {
  agent: Pick<AgentView, "id" | "role" | "phase" | "runId"> & Partial<Pick<AgentView, "startedAt" | "updatedAt">>;
}
/** Structural subset of Pi's theme; tests can pass a minimal object. */
export interface ViewerTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  italic?(text: string): string;
}
export interface ViewerMarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  codeBlockIndent?: string;
}
interface ViewerTui { terminal: { rows: number; columns: number }; requestRender(): void }
export interface ConversationViewerOptions {
  intervalMs?: number;
  keybindings?: KeybindingsManager;
  markdownTheme?: ViewerMarkdownTheme;
  /** Frame color, normally Pi's editor border so the overlay matches the input box. */
  frameColor?: (text: string) => string;
  /** Deliver inline, or return an action to close the overlay before opening a decision dialog. */
  onSend?: (message: string) => Promise<void | PanelAction> | void | PanelAction;
}

/** Border, header, two separators, footer and bottom border. */
const CHROME_LINES = 6;
const MAX_TOOL_OUTPUT_LINES = 12;
const clean = (value: string): string => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/**
 * A read-only live transcript overlay styled like Pi's own conversation view.
 * It shows the child's user/assistant messages, tool calls and output without touching the child.
 */
export class ConversationViewer {
  private snapshot?: ConversationSnapshot;
  private error?: string;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private scroll = 0;
  private follow = true;
  private totalLines = 0;
  private viewport = 1;
  private cache?: { width: number; lines: string[] };
  private readonly intervalMs: number;
  private readonly keybindings?: KeybindingsManager;
  private readonly markdownTheme?: ViewerMarkdownTheme;
  private readonly frameColor?: (text: string) => string;
  private readonly onSend?: ConversationViewerOptions["onSend"];
  private composer?: Input;
  private notice?: { text: string; color: string; revision?: number };
  private sending = false;

  constructor(
    private readonly tui: ViewerTui,
    private readonly theme: ViewerTheme,
    private readonly done: (action: PanelAction | undefined) => void,
    private readonly load: () => Promise<ConversationSnapshot>,
    options: ConversationViewerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 500;
    this.keybindings = options.keybindings;
    this.markdownTheme = options.markdownTheme;
    this.frameColor = options.frameColor;
    this.onSend = options.onSend;
    void this.refresh();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  invalidate(): void { this.cache = undefined; }
  private finish(action?: PanelAction): void {
    if (this.closed) return;
    this.dispose(); this.done(action);
  }
  private async refresh(): Promise<void> {
    try {
      const next = await this.load();
      if (this.closed) return;
      if (next.revision === undefined || next.revision !== this.snapshot?.revision) this.invalidate();
      // A delivery note only stays until the child itself produces new output.
      if (this.notice && next.revision !== undefined && next.revision !== this.notice.revision && !this.sending) this.notice = undefined;
      this.snapshot = next; this.error = undefined;
    } catch (error) {
      if (this.closed) return;
      this.error = `Unable to update transcript: ${(error as Error).message}`;
    }
    if (this.closed) return;
    try { this.tui.requestRender(); } catch { this.finish(); return; }
    // Catch up in bounded batches without blocking rendering or overlapping reads.
    this.timer = setTimeout(() => { void this.refresh(); }, this.error || !this.snapshot?.loading ? this.intervalMs : 0);
    this.timer.unref?.();
  }

  /** Pi's transcript bindings, with the plain key names as fallback for unconfigured terminals. */
  private matches(data: string, keybinding: "tui.altScreen.pageUp" | "tui.altScreen.pageDown" | "tui.altScreen.top" | "tui.altScreen.bottom", fallback: KeyId): boolean {
    if (this.keybindings?.matches(data, keybinding)) return true;
    return matchesKey(data, fallback);
  }

  /** Open the inline composer; it owns every key until it submits or is cancelled. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) void this.send(message);
      else this.tui.requestRender();
    };
    input.onEscape = () => { this.composer = undefined; this.tui.requestRender(); };
    this.composer = input;
    this.notice = undefined;
    this.tui.requestRender();
  }

  private async send(message: string): Promise<void> {
    const agent = this.snapshot?.agent;
    if (!agent || !this.onSend) return;
    const resuming = !canSteer(agent.phase);
    this.sending = true;
    this.notice = { text: resuming ? "Starting a new turn in the original session..." : "Delivering to the running child...", color: "dim", revision: this.snapshot?.revision };
    this.tui.requestRender();
    try {
      const action = await this.onSend(message);
      if (action) { this.finish(action); return; }
      this.notice = { text: resuming ? "Turn accepted in the original session; a report will follow." : "Message accepted; the child continues in the same session.", color: "success", revision: this.snapshot?.revision };
    } catch (error) {
      this.notice = { text: `Send failed: ${(error as Error).message}`, color: "error" };
    } finally {
      this.sending = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    // While composing, the input owns all keys (Enter sends, Esc cancels).
    if (this.composer) { this.composer.handleInput(data); this.tui.requestRender(); return; }
    const agent = this.snapshot?.agent;
    const max = Math.max(0, this.totalLines - this.viewport);
    const page = Math.max(1, this.viewport);
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.finish(); return; }
    if (agent && this.onSend && canMessage(agent.phase) && matchesKey(data, "return")) { this.openComposer(); return; }
    if (this.matches(data, "tui.altScreen.top", "home")) { this.scroll = 0; this.follow = false; }
    else if (this.matches(data, "tui.altScreen.bottom", "end")) { this.scroll = max; this.follow = true; }
    else if (this.matches(data, "tui.altScreen.pageUp", "pageUp")) { this.scroll = Math.max(0, this.scroll - page); this.follow = false; }
    else if (this.matches(data, "tui.altScreen.pageDown", "pageDown")) { this.scroll = Math.min(max, this.scroll + page); this.follow = this.scroll >= max; }
    else if (matchesKey(data, "up") || matchesKey(data, "shift+up") || data === "k") { this.scroll = Math.max(0, this.scroll - 1); this.follow = false; }
    else if (matchesKey(data, "down") || matchesKey(data, "shift+down") || data === "j") { this.scroll = Math.min(max, this.scroll + 1); this.follow = this.scroll >= max; }
    else if (agent && matchesKey(data, "s") && (canSteer(agent.phase) || isTerminal(agent.phase))) {
      this.finish({ kind: "message", id: agent.id, resume: !canSteer(agent.phase) }); return;
    } else if (agent && matchesKey(data, "x") && !isTerminal(agent.phase)) { this.finish({ kind: "stop", id: agent.id }); return; }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const rows = Math.max(3, Number.isFinite(this.tui.terminal.rows) ? this.tui.terminal.rows - 2 : 22);
    const inner = Math.max(1, width - 4);
    // Very short terminals drop the frame instead of overflowing the host view.
    const extra = (this.composer ? 1 : 0) + (this.notice ? 1 : 0);
    const framed = rows >= CHROME_LINES + extra + 1;
    this.viewport = Math.max(1, framed ? rows - CHROME_LINES - extra : rows - 2 - extra);
    const frame = this.frameColor ?? ((text: string) => this.theme.fg("borderMuted", text));
    const border = frame("│");
    const row = (content: string): string => {
      const clipped = truncateToWidth(content, inner);
      return `${border} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${border}`;
    };
    const bar = (left: string, right: string): string => {
      const room = Math.max(0, width - visibleWidth(right) - 1);
      if (visibleWidth(left) > room) return truncateToWidth(left, width);
      const clipped = truncateToWidth(left, room);
      return `${clipped}${" ".repeat(Math.max(0, room - visibleWidth(clipped)))} ${right}`;
    };

    const agent = this.snapshot?.agent;
    const stats = [this.snapshot?.usage ? `${formatTokens(this.snapshot.usage.input + this.snapshot.usage.output + this.snapshot.usage.cacheRead + this.snapshot.usage.cacheWrite)} tokens` : undefined,
      this.snapshot?.model ? oneLine(this.snapshot.model, 40) : undefined].filter(Boolean).join(" · ");
    const header = agent
      ? rightAlign(`${this.theme.fg(phaseColor(agent.phase), isTerminal(agent.phase) ? phaseIcon(agent.phase) : "●")} ${this.theme.bold(this.theme.fg("text", oneLine(agent.role, 40)))} ${this.theme.fg("dim", shortId(agent.id))}${this.theme.fg("muted", ` · ${phaseLabel(agent.phase)}`)}${agent.startedAt ? this.theme.fg("dim", ` · ${formatElapsed(viewElapsed(agent as AgentView, Date.now()))}`) : ""}`,
        this.theme.fg("dim", stats), inner)
      : this.theme.fg("muted", "Loading child session...");

    const body = this.content(inner);
    this.totalLines = body.length;
    const max = Math.max(0, body.length - this.viewport);
    this.scroll = this.follow ? max : Math.min(max, this.scroll);
    const visible = body.slice(this.scroll, this.scroll + this.viewport);
    while (visible.length < this.viewport) visible.push("");

    const percent = body.length <= this.viewport ? 100 : Math.round(((this.scroll + this.viewport) / Math.max(1, body.length)) * 100);
    const status = this.error
      ? this.theme.fg("error", oneLine(this.error, 120))
      : this.snapshot?.notice ? this.theme.fg("warning", oneLine(this.snapshot.notice, 120))
        : this.snapshot?.loading ? this.theme.fg("dim", "Loading history...")
          : this.theme.fg("dim", `${this.follow ? "Following" : "Paused"} · ${body.length} lines · ${Math.min(100, percent)}%`);
    const hints: string[] = ["↑↓ scroll", "PgUp/PgDn", "Home/End"];
    if (agent && this.onSend && canSteer(agent.phase)) hints.push("Enter message");
    else if (agent && this.onSend && canMessage(agent.phase)) hints.push("Enter resume");
    if (agent && !isTerminal(agent.phase)) hints.push("x stop");
    hints.push("Esc close");
    // Keep the most useful hints when the width is limited: dismissal and actions first, then scrolling.
    const styled = (items: string[]): string => this.theme.fg("dim", items.join(" · "));
    const priority = [...hints].sort((a, b) => rank(a) - rank(b));
    let chosen = new Set<string>();
    for (const hint of priority) {
      const candidate = hints.filter((item) => chosen.has(item) || item === hint);
      if (visibleWidth(status) + 1 + visibleWidth(styled(candidate)) <= width) chosen.add(hint);
    }
    const shown = hints.filter((hint) => chosen.has(hint));
    const footer = shown.length ? bar(status, styled(shown)) : truncateToWidth(status, width);
    const bottomRows = this.composer
      ? [row(this.composer.render(inner)[0] ?? ""), bar(this.theme.fg("accent", "✎ message"), this.theme.fg("dim", "Enter send · Esc cancel"))]
      : [footer];
    if (this.notice) bottomRows.push(this.theme.fg(this.notice.color, oneLine(this.notice.text, width)));
    const rule = frame(`├${"─".repeat(Math.max(0, width - 2))}┤`);
    if (!framed) return [row(header), ...visible.map((line) => row(line)), ...bottomRows].map((line) => truncateToWidth(line, width));
    return [
      frame(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
      row(header),
      rule,
      ...visible.map((line) => row(line)),
      rule,
      ...bottomRows,
      frame(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ].map((line) => truncateToWidth(line, width));
  }

  /** Build the scrollable transcript once per width and revision. */
  private content(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines: string[] = [];
    for (const entry of this.snapshot?.entries ?? []) {
      const rendered = this.renderEntry(entry, width);
      if (rendered.length) lines.push(...rendered, "");
    }
    if (!lines.length) lines.push(this.theme.fg("dim", "No messages yet. Waiting for the child to emit events."));
    this.cache = { width, lines };
    return lines;
  }

  private markdown(text: string, width: number, color?: string): string[] {
    if (!this.markdownTheme) return clean(text).split(/\r?\n/).flatMap((line) => wrapPlain(line, width));
    const component = new Markdown(text, 0, 0, this.markdownTheme as never, color ? { color: (value: string) => this.theme.fg(color, value) } : undefined);
    return component.render(width).map((line) => truncateToWidth(line, width));
  }

  private renderEntry(entry: TranscriptEntry, width: number): string[] {
    const title = oneLine(entry.title, 80);
    if (entry.kind === "user") {
      const block = this.markdown(clean(entry.text || ""), Math.max(1, width - 2), "userMessageText");
      // Pi renders user prompts on their own background band.
      return block.map((line) => this.theme.bg?.("userMessageBg", ` ${line}${" ".repeat(Math.max(0, width - 2 - visibleWidth(line)))} `) ?? ` ${line}`);
    }
    if (entry.kind === "tool") {
      const color = entry.status === "error" ? "error" : entry.status === "running" ? "warning" : "toolTitle";
      const args = formatArgs(entry.input);
      const out: string[] = [`${this.theme.fg(color, "⏺")} ${this.theme.bold(this.theme.fg("toolTitle", title))}${args ? this.theme.fg("muted", args) : ""}${entry.status ? this.theme.fg("dim", ` [${entry.status}]`) : ""}`];
      const output = entry.text ? clean(entry.text).split(/\r?\n/) : [];
      const shown = output.slice(-MAX_TOOL_OUTPUT_LINES);
      if (output.length > shown.length) out.push(this.theme.fg("dim", `  … ${output.length - shown.length} earlier lines`));
      for (const line of shown) out.push(...wrapPlain(line, Math.max(1, width - 4)).map((value) => `  ${this.theme.fg(entry.status === "error" ? "error" : "toolOutput", value)}`));
      if (!entry.text && entry.status !== "error") out.push(this.theme.fg("dim", "  … running"));
      return out;
    }
    if (entry.kind === "assistant") {
      if (!entry.text) return [];
      return this.markdown(clean(entry.text), width, "text");
    }
    const color = entry.status === "error" ? "error" : "warning";
    return [`${this.theme.fg(color, "!")} ${this.theme.fg(color, title)}`, ...(entry.text ? wrapPlain(clean(entry.text), Math.max(1, width - 2)).map((line) => `  ${this.theme.fg("dim", line)}`) : [])];
  }
}

/** Compact tool arguments into `(k: v, …)` like Pi's transcript; fall back to raw clipped text. */
function formatArgs(input: string | undefined): string {
  if (!input) return "";
  const raw = clean(input).trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
        if (value === null || typeof value !== "object") return `${key}: ${String(value)}`;
        return `${key}: …`;
      });
      if (parts.length && parts.length <= 6) return `(${oneLine(parts.join(", "), 120)})`;
    }
  } catch { /* not JSON: keep the raw text below */ }
  return `(${oneLine(raw.split(/\r?\n/).slice(0, 2).join(" "), 120)})`;
}

/** Hint priority when the footer is too narrow: dismissal, actions, then scrolling. */
function rank(hint: string): number {
  if (hint === "Esc close") return 0;
  if (hint.startsWith("Enter ")) return 1;
  if (hint === "x stop") return 2;
  return 3;
}

/** Wrap a plain (already sanitized) line to the given visible width. */
function wrapPlain(line: string, width: number): string[] {
  const limit = Math.max(1, width);
  if (!line) return [""];
  const out: string[] = [];
  let rest = line;
  while (visibleWidth(rest) > limit) {
    let cut = rest.length;
    while (cut > 1 && visibleWidth(rest.slice(0, cut)) > limit) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

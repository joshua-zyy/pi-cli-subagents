import { matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentView } from "../types.js";
import type { PanelAction } from "./panel.js";
import type { TranscriptSnapshot } from "./transcript.js";
import { canSteer, isTerminal, oneLine, phaseLabel, type UiTheme } from "./format.js";

export interface ConversationSnapshot extends TranscriptSnapshot {
  agent: Pick<AgentView, "id" | "role" | "phase" | "runId">;
}
interface ViewerTui { terminal: { rows: number; columns: number }; requestRender(): void }
const clean = (value: string): string => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** A read-only live transcript with optional actions returned to the command handler. */
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

  constructor(
    private readonly tui: ViewerTui,
    private readonly theme: UiTheme,
    private readonly done: (action: PanelAction | undefined) => void,
    private readonly load: () => Promise<ConversationSnapshot>,
    options: { intervalMs?: number } = {},
  ) {
    this.intervalMs = options.intervalMs ?? 500;
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

  handleInput(data: string): void {
    if (this.closed) return;
    const agent = this.snapshot?.agent;
    const max = Math.max(0, this.totalLines - this.viewport);
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.finish(); return; }
    if (matchesKey(data, "home")) { this.scroll = 0; this.follow = false; }
    else if (matchesKey(data, "end")) { this.scroll = max; this.follow = true; }
    else if (matchesKey(data, "up") || data === "k") { this.scroll = Math.max(0, this.scroll - 1); this.follow = false; }
    else if (matchesKey(data, "down") || data === "j") { this.scroll = Math.min(max, this.scroll + 1); this.follow = this.scroll >= max; }
    else if (matchesKey(data, "pageUp")) { this.scroll = Math.max(0, this.scroll - this.viewport); this.follow = false; }
    else if (matchesKey(data, "pageDown")) { this.scroll = Math.min(max, this.scroll + this.viewport); this.follow = this.scroll >= max; }
    else if (agent && matchesKey(data, "s") && (canSteer(agent.phase) || isTerminal(agent.phase))) {
      this.finish({ kind: "message", id: agent.id, resume: !canSteer(agent.phase) }); return;
    } else if (agent && matchesKey(data, "x") && !isTerminal(agent.phase)) { this.finish({ kind: "stop", id: agent.id }); return; }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const rows = Math.max(1, Number.isFinite(this.tui.terminal.rows) ? this.tui.terminal.rows - 2 : 22);
    const inner = Math.max(1, width - 2);
    const agent = this.snapshot?.agent;
    const label = agent ? `${oneLine(agent.role, 60)} / ${oneLine(agent.id, 8)} / ${phaseLabel(agent.phase)}` : "Loading";
    const header = this.theme.bold(this.theme.fg("accent", `Conversation | ${label}`));
    const state = `${this.follow ? "Following" : "Paused"}${this.snapshot?.loading ? " | Loading history..." : ""}`;
    const note = this.error ?? this.snapshot?.notice;
    const chrome = [header, this.theme.fg("dim", state)];
    if (note) chrome.push(this.theme.fg("warning", oneLine(note, 1000)));
    const keys = ["Esc back", "Up/Down scroll", "PgUp/PgDn page", "Home/End"];
    if (agent && (canSteer(agent.phase) || isTerminal(agent.phase))) keys.push(canSteer(agent.phase) ? "s message" : "s resume");
    if (agent && !isTerminal(agent.phase)) keys.push("x stop");
    const footer = this.theme.fg("dim", keys.join(" | "));
    this.viewport = Math.max(1, rows - chrome.length - 1);
    const body = this.content(inner);
    this.totalLines = body.length;
    const max = Math.max(0, body.length - this.viewport);
    this.scroll = this.follow ? max : Math.min(max, this.scroll);
    const visible = body.slice(this.scroll, this.scroll + this.viewport);
    const output = [...chrome, ...visible, footer];
    // Tiny terminals still get a dismissal hint instead of overflowing the host.
    const fitted = output.length > rows ? [...output.slice(0, Math.max(0, rows - 1)), footer] : output;
    return fitted.map(line => truncateToWidth(line, width));
  }

  private content(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines: string[] = [];
    for (const entry of this.snapshot?.entries ?? []) {
      if (entry.kind === "assistant" && !entry.text) continue;
      const color = entry.status === "error" ? "error" : entry.kind === "user" ? "accent" : entry.kind === "tool" ? "muted" : "text";
      lines.push(this.theme.bold(this.theme.fg(color, `${oneLine(entry.title, 200)}${entry.status ? ` [${entry.status}]` : ""}`)));
      const blocks = [entry.input === undefined ? undefined : `Input:\n${entry.input}`, entry.text || (entry.kind === "tool" ? "Waiting for output..." : undefined)];
      for (const block of blocks) if (block) {
        for (const line of clean(block).split(/\r?\n/)) lines.push(...wrapTextWithAnsi(line, width).map(value => `  ${value}`));
      }
      lines.push("");
    }
    if (!lines.length) lines.push(this.theme.fg("dim", "No messages yet. Waiting for the child to emit events."));
    this.cache = { width, lines };
    return lines;
  }
}

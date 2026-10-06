import { Input, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type KeyId, type KeybindingsManager } from "@earendil-works/pi-tui";
import type { AgentView } from "../types.js";
import type { PanelAction } from "./panel.js";
import type { TranscriptEntry, TranscriptPageBoundary, TranscriptSnapshot } from "./transcript.js";
import { ConversationHistory } from "./conversation-history.js";
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
  /** On-demand history: called only while the reader walks past a loaded edge, never in the background. */
  paging?: {
    older(boundary?: TranscriptPageBoundary): Promise<ConversationSnapshot>;
    newer(boundary?: TranscriptPageBoundary): Promise<ConversationSnapshot>;
    latest(): Promise<ConversationSnapshot>;
  };
}

/** Border, header, two separators, footer and bottom border. */
const CHROME_LINES = 6;
/** A paused viewport anchor: its entry, the line offset inside it, and where its records are. */
interface ViewerAnchor { id: string; offset: number; kind: TranscriptEntry["kind"]; span?: TranscriptEntry["span"]; partial?: TranscriptEntry["partial"] }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clean = (value: string): string => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/**
 * A read-only live transcript overlay styled like Pi's own conversation view.
 * It shows the child's user/assistant messages, tool calls and output without touching the child.
 */
export class ConversationViewer {
  private snapshot?: ConversationSnapshot;
  private readonly history = new ConversationHistory<ConversationSnapshot>();
  private agent?: ConversationSnapshot["agent"];
  private error?: string;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private scroll = 0;
  private pendingScrollAdjustment?: number;
  private contentWidth?: number;
  private follow = true;
  private totalLines = 0;
  private viewport = 1;
  private toolsExpanded = false;
  private blockWidth?: number;
  private blocks = new Map<string, { signature: (string | undefined)[]; lines: string[] }>();
  private cache?: { width: number; lines: string[]; entries: { id: string; start: number; end: number }[] };
  private readonly intervalMs: number;
  private readonly keybindings?: KeybindingsManager;
  private readonly markdownTheme?: ViewerMarkdownTheme;
  private readonly frameColor?: (text: string) => string;
  private readonly onSend?: ConversationViewerOptions["onSend"];
  private composer?: Input;
  private notice?: { text: string; color: string; revision?: number };
  private sending = false;
  private readonly paging?: ConversationViewerOptions["paging"];
  private pagingInFlight?: "older" | "newer" | "latest";
  private pagingQueued?: "older" | "newer" | "latest";
  private pagingError?: string;
  /** Upward key presses beyond the loaded edge, waiting for the in-flight older page. */
  private pendingUpRows = 0;

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
    this.paging = options.paging;
    void this.refresh();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  invalidate(): void { this.cache = undefined; this.blocks.clear(); }
  private finish(action?: PanelAction): void {
    if (this.closed) return;
    this.dispose(); this.done(action);
  }
  private async refresh(): Promise<void> {
    let loading = false;
    try {
      const next = await this.load();
      if (this.closed) return;
      loading = next.loading;
      this.agent = next.agent; // Keep status and controls live while the transcript catches up.
      // The first content frame must land at the actual end, not at the end of an old replay batch.
      if ((this.snapshot || !loading) && !this.pagingInFlight && !this.pagingQueued) this.adopt(next);
      this.error = undefined;
    } catch (error) {
      if (this.closed) return;
      this.error = `Unable to update transcript: ${(error as Error).message}`;
    }
    if (this.closed) return;
    try { this.tui.requestRender(); } catch { this.finish(); return; }
    // Tail catch-up stays fast; background history yields between bounded batches instead of spinning.
    let delay = this.intervalMs;
    if (!this.error) {
      if (loading) delay = 0;
      else if (this.snapshot?.historyLoading) delay = Math.min(this.intervalMs, 50);
    }
    this.timer = setTimeout(() => { void this.refresh(); }, delay);
    this.timer.unref?.();
  }

  /**
   * Publish one snapshot. A paused viewport stays on the entry it is showing, so a prepended older
   * page, a live append or a replayed window never moves the reader's place.
   */
  private adopt(incoming: ConversationSnapshot, kind: "refresh" | "older" | "newer" | "latest" = "refresh"): void {
    const width = this.contentWidth;
    const pinned = new Set<string>();
    if (!this.follow && width !== undefined && this.snapshot) {
      this.content(width);
      for (const entry of this.cache!.entries) if (entry.start < this.scroll + this.viewport && entry.end > this.scroll) pinned.add(entry.id);
      const top = this.topVisibleEntry();
      if (top) pinned.add(top.id);
    }
    const next = this.paging ? this.history.accept(incoming, kind, pinned) : incoming;
    const reset = !!this.snapshot && next.sourceEpoch !== this.snapshot.sourceEpoch;
    if (reset) {
      this.scroll = 0; this.pendingScrollAdjustment = undefined; this.pendingUpRows = 0;
    }
    const changed = reset || next.revision === undefined || next.revision !== this.snapshot?.revision;
    let anchor: ViewerAnchor | undefined;
    let before: number | undefined;
    let handoff = false;
    if (this.snapshot && width !== undefined && changed) {
      // A host may coalesce frames, so apply a pending adjustment before measuring the viewport.
      if (this.pendingScrollAdjustment !== undefined) {
        this.scroll = Math.max(0, this.scroll + this.pendingScrollAdjustment);
        this.pendingScrollAdjustment = undefined;
      }
      if (!this.follow && !reset) {
        before = this.content(width).length;
        anchor = this.topVisibleEntry();
        handoff = !!this.snapshot.historyLoading && !next.historyLoading;
      }
    }
    // A log update invalidates layout, not unchanged per-entry renderings.
    // Host/theme invalidation still clears both caches via invalidate().
    if (changed) this.cache = undefined;
    this.snapshot = next;
    // Historical reconstruction changes the display, but is not new output from the child.
    const outputRevision = next.outputRevision ?? next.revision;
    if (this.notice && outputRevision !== undefined) {
      if (this.notice.revision === undefined) this.notice.revision = outputRevision;
      else if (outputRevision !== this.notice.revision && !this.sending) this.notice = undefined;
    }
    if (width === undefined || !changed) return;
    const rebuilt = anchor || handoff ? (this.content(width), this.cache) : undefined;
    const entry = anchor && rebuilt ? rebuilt.entries.find(candidate => candidate.id === anchor.id) ?? this.spanFallback(rebuilt, anchor) : undefined;
    if (entry && anchor) {
      const removedHead = anchor.partial === "head" && this.snapshot.entries.find(item => item.id === entry.id)?.partial !== "head";
      const offset = Math.max(0, anchor.offset - (removedHead ? 1 : 0));
      this.scroll = entry.start + Math.min(offset, Math.max(0, entry.end - entry.start - 1));
      this.pendingScrollAdjustment = undefined;
    } else if (handoff && before !== undefined && rebuilt) {
      // Legacy snapshots without stable ids fall back to the previous line-delta handoff.
      this.pendingScrollAdjustment = rebuilt.lines.length - before;
    }
  }

  /**
   * Positioning fallback for a paused viewport whose entry was re-keyed by earlier context: match the
   * entry that still covers the anchored byte span, same source and kind, and only when it is unique.
   * This never merges entries or treats different native tool calls as the same item.
   */
  private spanFallback(rebuilt: { entries: { id: string; start: number; end: number }[] }, anchor: ViewerAnchor): { id: string; start: number; end: number } | undefined {
    const span = anchor.span;
    if (!span || (anchor.kind !== "assistant" && anchor.kind !== "user" && anchor.kind !== "notice")) return undefined;
    const reference = span.start;
    const candidates = (this.snapshot?.entries ?? []).filter(candidate => candidate.kind === anchor.kind && candidate.span
      && candidate.span.start.source === reference.source && candidate.span.start.offset <= reference.offset && candidate.span.end.offset > reference.offset);
    if (candidates.length !== 1) return undefined;
    return rebuilt.entries.find(candidate => candidate.id === candidates[0].id);
  }

  /** The entry under the top of the viewport, used to keep a paused view in place. */
  private topVisibleEntry(): ViewerAnchor | undefined {
    if (this.contentWidth === undefined) return undefined;
    this.content(this.contentWidth);
    const byId = new Map((this.snapshot?.entries ?? []).map(entry => [entry.id, entry]));
    let anchor: ViewerAnchor | undefined;
    for (const entry of this.cache!.entries) {
      if (entry.start > this.scroll) break;
      const visible = byId.get(entry.id);
      anchor = { id: entry.id, offset: this.scroll - entry.start, kind: visible?.kind ?? "assistant", partial: visible?.partial, ...(visible?.span ? { span: visible.span } : {}) };
    }
    return anchor;
  }

  private scrollUp(rows: number): void {
    const wanted = this.scroll - rows;
    if (wanted < 0 && this.paging && this.snapshot?.window && !this.snapshot.window.atStart) this.pendingUpRows += -wanted;
    this.scroll = Math.max(0, wanted);
    this.follow = false;
  }

  /** Prefetch only the edge the reader is moving towards, while two screens of content remain. */
  private maybePage(direction?: "older" | "newer"): void {
    const window = this.snapshot?.window;
    if (!window || !this.paging) return;
    const max = Math.max(0, this.totalLines - this.viewport);
    const margin = Math.max(1, this.viewport * 2);
    if (direction === "older" && this.scroll <= margin && !window.atStart) this.requestPage("older");
    else if (direction === "newer" && this.scroll >= max - margin && !window.atEnd) this.requestPage("newer");
  }
  /** One request at a time: duplicates are dropped, while End is always queued behind a page. */
  private requestPage(kind: "older" | "newer" | "latest"): void {
    if (this.closed || !this.paging) return;
    if (this.pagingInFlight) {
      if (kind === "latest" && this.pagingInFlight !== "latest") this.pagingQueued = "latest";
      return;
    }
    void this.runPage(kind);
  }
  private async runPage(kind: "older" | "newer" | "latest"): Promise<void> {
    const paging = this.paging;
    if (!paging) return;
    this.pagingInFlight = kind;
    this.pagingError = undefined;
    try { this.tui.requestRender(); } catch { this.finish(); return; }
    try {
      const window = this.snapshot?.window;
      const boundary = window ? { position: kind === "older" ? window.from : window.to,
        id: kind === "older" ? this.snapshot?.entries[0]?.id : this.snapshot?.entries.at(-1)?.id } : undefined;
      const next = kind === "older" ? await paging.older(boundary) : kind === "newer" ? await paging.newer(boundary) : await paging.latest();
      if (!this.closed && this.pagingQueued !== "latest") {
        this.adopt(next, kind);
        if (kind === "older" && this.pendingUpRows > 0) {
          const moved = Math.min(this.pendingUpRows, this.scroll);
          this.scroll -= moved;
          this.pendingUpRows -= moved;
          // Only unconsumed explicit key presses can request another page. A stalled boundary
          // must not turn prefetch into an automatic scan of the whole history.
          if (moved > 0 && this.pendingUpRows > 0 && next.window && !next.window.atStart) this.pagingQueued = "older";
          else this.pendingUpRows = 0;
        }
      }
    } catch (error) {
      this.pendingUpRows = 0;
      if (!this.closed) this.pagingError = `Unable to read history: ${(error as Error).message}`;
    } finally {
      this.pagingInFlight = undefined;
      const queued = this.pagingQueued;
      this.pagingQueued = undefined;
      if (!this.closed) {
        if (queued) void this.runPage(queued);
        try { this.tui.requestRender(); } catch { this.finish(); }
      }
    }
  }

  /** Pi's transcript bindings, with the plain key names as fallback for unconfigured terminals. */
  private matches(data: string, keybinding: "tui.altScreen.pageUp" | "tui.altScreen.pageDown" | "tui.altScreen.top" | "tui.altScreen.bottom", fallback: KeyId): boolean {
    if (this.keybindings?.matches(data, keybinding)) return true;
    return matchesKey(data, fallback);
  }

  /** Use the injected host manager, not a potentially separate package's global registry. */
  private toolKeys(): KeyId[] {
    return this.keybindings?.getKeys?.("app.tools.expand") ?? ["ctrl+o"];
  }

  private toggleTools(): void {
    const width = this.contentWidth;
    let anchor: { id: string; offset: number } | undefined;
    if (!this.follow && width !== undefined) {
      this.content(width);
      this.scroll = Math.max(0, this.scroll + (this.pendingScrollAdjustment ?? 0));
      this.pendingScrollAdjustment = undefined;
      for (const entry of this.cache!.entries) {
        if (entry.start > this.scroll) break;
        anchor = { id: entry.id, offset: this.scroll - entry.start };
      }
    }
    this.toolsExpanded = !this.toolsExpanded;
    this.invalidate();
    if (anchor && width !== undefined) {
      this.content(width);
      const entry = this.cache!.entries.find(entry => entry.id === anchor.id);
      if (entry) this.scroll = entry.start + Math.min(anchor.offset, entry.end - entry.start - 1);
    }
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
    const agent = this.agent;
    if (!agent || !this.onSend) return;
    const resuming = !canSteer(agent.phase);
    this.sending = true;
    this.notice = { text: resuming ? "Starting a new turn in the original session..." : "Delivering to the running child...", color: "dim", revision: this.snapshot?.outputRevision ?? this.snapshot?.revision };
    this.tui.requestRender();
    try {
      const action = await this.onSend(message);
      if (action) { this.finish(action); return; }
      this.notice = { text: resuming ? "Turn accepted in the original session; a report will follow." : "Message accepted; the child continues in the same session.", color: "success", revision: this.snapshot?.outputRevision ?? this.snapshot?.revision };
    } catch (error) {
      this.notice = { text: `Send failed: ${(error as Error).message}`, color: "error" };
    } finally {
      this.sending = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    // Like tintinweb/pi-subagents, derive scroll bounds from current content, never the last paint.
    // requestRender is asynchronous: several key presses and a page can share a single host frame.
    this.syncScroll();
    const wasFollowing = this.follow;
    // While composing, the input owns all keys (Enter sends, Esc cancels).
    if (this.composer) { this.composer.handleInput(data); this.tui.requestRender(); return; }
    const agent = this.agent;
    const max = Math.max(0, this.totalLines - this.viewport);
    const page = Math.max(1, this.viewport);
    let direction: "older" | "newer" | undefined;
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.finish(); return; }
    if (agent && this.onSend && canMessage(agent.phase) && matchesKey(data, "return")) { this.openComposer(); return; }
    if (this.toolKeys().some(key => matchesKey(data, key))) {
      this.toggleTools(); this.tui.requestRender(); return;
    }
    // Scrolling the loading placeholder must not disable the initial follow-to-end position.
    if (this.snapshot && this.matches(data, "tui.altScreen.top", "home")) {
      this.scroll = 0; this.follow = false; this.pendingScrollAdjustment = undefined; this.pendingUpRows = 0; direction = "older";
    } else if (this.snapshot && this.matches(data, "tui.altScreen.bottom", "end")) {
      this.scroll = max; this.follow = true; this.pendingScrollAdjustment = undefined; this.pendingUpRows = 0;
      // A pending page may move the reader away from the live tail even when the displayed
      // snapshot is still atEnd. End supersedes that result and restores the real tail.
      if (this.snapshot.window && (!this.snapshot.window.atEnd || !this.history.readerWindow?.atEnd || this.pagingInFlight)) this.requestPage("latest");
    }
    else if (this.snapshot && this.matches(data, "tui.altScreen.pageUp", "pageUp")) { this.scrollUp(page); direction = "older"; }
    else if (this.snapshot && this.matches(data, "tui.altScreen.pageDown", "pageDown")) {
      this.pendingUpRows = 0; this.scroll = Math.min(max, this.scroll + page);
      this.follow = this.scroll >= max && (this.snapshot.window?.atEnd ?? true); direction = "newer";
    }
    else if (this.snapshot && (matchesKey(data, "up") || matchesKey(data, "shift+up") || data === "k")) { this.scrollUp(1); direction = "older"; }
    else if (this.snapshot && (matchesKey(data, "down") || matchesKey(data, "shift+down") || data === "j")) {
      this.pendingUpRows = 0; this.scroll = Math.min(max, this.scroll + 1);
      this.follow = this.scroll >= max && (this.snapshot.window?.atEnd ?? true); direction = "newer";
    }
    else if (agent && matchesKey(data, "s") && (canSteer(agent.phase) || isTerminal(agent.phase))) {
      this.finish({ kind: "message", id: agent.id, resume: !canSteer(agent.phase) }); return;
    } else if (agent && matchesKey(data, "x") && !isTerminal(agent.phase)) { this.finish({ kind: "stop", id: agent.id }); return; }
    if (direction === "newer" && this.follow && (this.pagingInFlight === "older" || this.history.readerWindow?.atEnd === false)) this.requestPage("latest");
    if (this.follow && !wasFollowing && !this.pagingInFlight && !this.pagingQueued && this.history.readerSnapshot) {
      this.adopt(this.history.readerSnapshot);
      this.syncScroll();
    }
    this.maybePage(direction);
    this.tui.requestRender();
  }

  /** Shared by input and paint, including terminal resizes that arrive before the next frame. */
  private geometry(): { framed: boolean; viewport: number } {
    const rows = Math.max(3, Number.isFinite(this.tui.terminal.rows) ? this.tui.terminal.rows - 2 : 22);
    const extra = (this.composer ? 1 : 0) + (this.notice ? 1 : 0);
    const framed = rows >= CHROME_LINES + extra + 1;
    return { framed, viewport: Math.max(1, framed ? rows - CHROME_LINES - extra : rows - 2 - extra) };
  }

  private syncScroll(): void {
    this.viewport = this.geometry().viewport;
    if (this.contentWidth === undefined) return;
    this.totalLines = this.content(this.contentWidth).length;
    if (this.pendingScrollAdjustment !== undefined) {
      this.scroll = Math.max(0, this.scroll + this.pendingScrollAdjustment);
      this.pendingScrollAdjustment = undefined;
    }
    const max = Math.max(0, this.totalLines - this.viewport);
    this.scroll = this.follow ? max : Math.min(max, this.scroll);
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const inner = Math.max(1, width - 4);
    const { framed } = this.geometry();
    const frame = this.frameColor ?? ((text: string) => this.theme.fg("borderMuted", text));
    const border = frame("│");
    const row = (content: string): string => {
      const clipped = truncateToWidth(content, inner);
      return `${border} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${border}`;
    };
    const bar = (left: string, right: string): string => {
      const room = Math.max(0, inner - visibleWidth(right) - 1);
      if (visibleWidth(left) > room) return truncateToWidth(left, inner);
      const clipped = truncateToWidth(left, room);
      return `${clipped}${" ".repeat(Math.max(0, room - visibleWidth(clipped)))} ${right}`;
    };

    const agent = this.agent;
    // Whole-log totals are only shown when the loaded window really covered every run; otherwise the
    // reader is told the figures are incomplete instead of seeing a number that looks finished.
    const tokens = this.snapshot?.usage && this.snapshot.usageComplete !== false
      ? `${formatTokens(this.snapshot.usage.input + this.snapshot.usage.output + this.snapshot.usage.cacheRead + this.snapshot.usage.cacheWrite)} tokens` : undefined;
    const stats = [tokens, this.snapshot?.usageComplete === false ? "Stats incomplete" : undefined,
      this.snapshot?.model ? oneLine(this.snapshot.model, 40) : undefined].filter(Boolean).join(" · ");
    const header = agent
      ? rightAlign(`${this.theme.fg(phaseColor(agent.phase), isTerminal(agent.phase) ? phaseIcon(agent.phase) : "●")} ${this.theme.bold(this.theme.fg("text", oneLine(agent.role, 40)))} ${this.theme.fg("dim", shortId(agent.id))}${this.theme.fg("muted", ` · ${phaseLabel(agent.phase)}`)}${agent.startedAt ? this.theme.fg("dim", ` · ${formatElapsed(viewElapsed(agent as AgentView, Date.now()))}`) : ""}`,
        this.theme.fg("dim", stats), inner)
      : this.theme.fg("muted", "Loading child session...");

    this.contentWidth = inner;
    const body = this.content(inner);
    this.syncScroll();
    const visible = body.slice(this.scroll, this.scroll + this.viewport);
    while (visible.length < this.viewport) visible.push("");

    const percent = body.length <= this.viewport ? 100 : Math.round(((this.scroll + this.viewport) / Math.max(1, body.length)) * 100);
    const status = this.error
      ? this.theme.fg("error", oneLine(this.error, 120))
      : this.pagingError ? this.theme.fg("error", oneLine(this.pagingError, 120))
        : this.pagingInFlight ? this.theme.fg("dim", this.pagingInFlight === "older" ? "Loading older history..." : this.pagingInFlight === "newer" ? "Loading newer history..." : "Returning to the latest output...")
          : this.snapshot?.historyLoading ? this.theme.fg(this.snapshot.notice ? "warning" : "dim", `Recent preview · loading history/totals${this.snapshot.notice ? ` · ${oneLine(this.snapshot.notice, 120)}` : ""}`)
            : this.snapshot?.notice ? this.theme.fg("warning", oneLine(this.snapshot.notice, 120))
              : !this.snapshot || this.snapshot.loading ? this.theme.fg("dim", "Loading history...")
                : this.theme.fg("dim", `${this.follow ? "Following" : "Paused"} · ${body.length} lines · ${Math.min(100, percent)}%`);
    const hints: string[] = this.snapshot ? ["↑↓ scroll", "PgUp/PgDn", "Home/End"] : [];
    if (this.snapshot?.window && !this.snapshot.window.atStart) hints.push("PgUp older");
    if (this.snapshot?.window && !this.snapshot.window.atEnd) hints.push("End latest");
    const toolKey = this.toolKeys()[0];
    if (toolKey && this.snapshot?.entries.some(entry => entry.kind === "tool")) hints.push(`${toolKey} tools`);
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
      if (visibleWidth(status) + 1 + visibleWidth(styled(candidate)) <= inner) chosen.add(hint);
    }
    const shown = hints.filter((hint) => chosen.has(hint));
    const footer = shown.length ? bar(status, styled(shown)) : status;
    // Every chrome row is framed, so the footer cannot spill past the border it belongs to.
    const bottomRows = this.composer
      ? [row(this.composer.render(inner)[0] ?? ""), row(bar(this.theme.fg("accent", "✎ message"), this.theme.fg("dim", "Enter send · Esc cancel")))]
      : [row(footer)];
    if (this.notice) bottomRows.push(row(this.theme.fg(this.notice.color, oneLine(this.notice.text, inner))));
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
    if (this.blockWidth !== width) { this.blocks.clear(); this.blockWidth = width; }
    const retained = new Map<string, { signature: (string | undefined)[]; lines: string[] }>();
    const lines: string[] = [];
    const entries: { id: string; start: number; end: number }[] = [];
    let compactTool = false;
    for (const entry of this.snapshot?.entries ?? []) {
      // Copy values, not the mutable entry object; collapsed tools never inspect output.
      const signature = [entry.kind, entry.title, entry.input, entry.status, entry.partial,
        entry.kind === "tool" && !this.toolsExpanded ? undefined : entry.text];
      const previous = this.blocks.get(entry.id);
      const block = previous && signature.every((value, i) => value === previous.signature[i])
        ? previous : { signature, lines: this.renderEntry(entry, width) };
      retained.set(entry.id, block);
      const rendered = block.lines;
      if (!rendered.length) continue;
      if (compactTool && entry.kind !== "tool") lines.push("");
      const start = lines.length;
      lines.push(...rendered);
      entries.push({ id: entry.id, start, end: lines.length });
      compactTool = entry.kind === "tool" && !this.toolsExpanded;
      if (!compactTool) lines.push("");
    }
    if (compactTool) lines.push("");
    if (!lines.length) lines.push(this.theme.fg("dim", this.snapshot
      ? "No messages yet. Waiting for the child to emit events." : "Loading recent messages..."));
    this.blocks = retained; // Bound retained blocks to the current snapshot, not the session lifetime.
    this.cache = { width, lines, entries };
    return lines;
  }

  private markdown(text: string, width: number, color?: string): string[] {
    if (!this.markdownTheme) return clean(text).split(/\r?\n/).flatMap((line) => wrapPlain(line, width));
    const component = new Markdown(text, 0, 0, this.markdownTheme as never, color ? { color: (value: string) => this.theme.fg(color, value) } : undefined);
    return component.render(width).map((line) => truncateToWidth(line, width));
  }

  /** Rendered entry plus an explicit marker when the loaded window cut this entry's group short. */
  private renderEntry(entry: TranscriptEntry, width: number): string[] {
    const lines = this.renderBody(entry, width);
    if (!entry.partial || !lines.length) return lines;
    const marker = this.theme.fg("dim", entry.partial === "head" ? "… continues from earlier history" : "… continues below");
    return entry.partial === "head" ? [marker, ...lines] : [...lines, marker];
  }

  private renderBody(entry: TranscriptEntry, width: number): string[] {
    const title = oneLine(entry.title, 80);
    if (entry.kind === "user") {
      const block = this.markdown(clean(entry.text || ""), Math.max(1, width - 2), "userMessageText");
      // Pi renders user prompts on their own background band.
      return block.map((line) => this.theme.bg?.("userMessageBg", ` ${line}${" ".repeat(Math.max(0, width - 2 - visibleWidth(line)))} `) ?? ` ${line}`);
    }
    if (entry.kind === "tool") {
      const color = entry.status === "error" ? "error" : entry.status === "running" ? "warning" : "toolTitle";
      const args = formatArgs(entry.input);
      const icon = entry.status === "error" ? "✗" : entry.status === "done" ? "✓" : entry.status === "running" ? "●" : "·";
      const out: string[] = [`${this.theme.fg("dim", this.toolsExpanded ? "▾" : "▸")} ${this.theme.fg(color, icon)} ${this.theme.bold(this.theme.fg(color, title))}${args ? this.theme.fg("muted", args) : ""}${entry.status ? this.theme.fg("dim", ` [${entry.status}]`) : ""}`];
      // Collapsed rows must not even lay out large output strings, including failures.
      if (!this.toolsExpanded) return out;
      if (entry.input) {
        out.push(this.theme.fg("dim", "  Input:"));
        for (const line of clean(entry.input).split(/\r?\n/)) out.push(...wrapPlain(line, Math.max(1, width - 4)).map(value => `  ${this.theme.fg("muted", value)}`));
      }
      const output = entry.text ? clean(entry.text).split(/\r?\n/) : [];
      if (output.length) out.push(this.theme.fg("dim", "  Output:"));
      for (const line of output) out.push(...wrapPlain(line, Math.max(1, width - 4)).map((value) => `  ${this.theme.fg(entry.status === "error" ? "error" : "toolOutput", value)}`));
      if (!entry.text && entry.status === "running") out.push(this.theme.fg("dim", "  … running"));
      return out;
    }
    if (entry.kind === "assistant") {
      if (!entry.text) return [];
      return this.markdown(clean(entry.text), width, "text");
    }
    const color = entry.status === "error" ? "error" : "warning";
    return [`${this.theme.fg(color, "!")} ${this.theme.fg(color, title)}`, ...(entry.text ? clean(entry.text).split(/\r?\n/)
      .flatMap((line) => wrapPlain(line, Math.max(1, width - 2))).map((line) => `  ${this.theme.fg("dim", line)}`) : [])];
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
  if (hint.endsWith(" tools")) return 1;
  if (hint.startsWith("Enter ")) return 2;
  if (hint === "x stop") return 3;
  return 4;
}

/** Hard-wrap sanitized text without dropping whitespace or splitting graphemes. */
function wrapPlain(line: string, width: number): string[] {
  const limit = Math.max(1, width);
  if (visibleWidth(line) <= limit) return [line];
  // Expanded tools can contain many long code/log lines. Printable ASCII has one
  // column per code unit; avoid a grapheme iterator without changing Unicode wrapping.
  if (/^[\x20-\x7e]+$/.test(line)) {
    const chunks: string[] = [];
    for (let offset = 0; offset < line.length; offset += limit) chunks.push(line.slice(offset, offset + limit));
    return chunks;
  }
  const out: string[] = [];
  let current = "", columns = 0;
  for (const { segment } of graphemes.segment(line)) {
    const size = visibleWidth(segment);
    if (current && columns + size > limit) {
      out.push(current); current = ""; columns = 0;
    }
    current += segment; columns += size;
  }
  out.push(current);
  return out;
}

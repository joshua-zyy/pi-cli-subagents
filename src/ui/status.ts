import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentView } from "../types.js";
import { SPINNER, formatElapsed, isActive, isTerminal, oneLine, phaseColor, phaseIcon, phaseLabel, rightAlign, shortId, viewElapsed, viewStartedAt, type UiColor, type UiTheme } from "./format.js";

export const STATUS_KEY = "cli-subagents";
export const MAX_STATUS_LINES = 10;
export const FINISHED_LINGER_MS = 30_000;

export interface StatusLinesOptions {
  now: number;
  frame: number;
  width: number;
  theme: UiTheme;
  lingerMs?: number;
}

export interface WidgetTui { terminal: { columns: number }; requestRender(): void }
export interface WidgetComponent { render(width: number): string[]; invalidate(): void }
export interface WidgetHost {
  setWidget(
    key: string,
    content: undefined | ((tui: WidgetTui, theme: UiTheme) => WidgetComponent),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

const HEAD_LIMIT = 40;
const BODY_LIMIT = 60;
const byStart = (a: AgentView, b: AgentView): number => viewStartedAt(a) - viewStartedAt(b);
const shorten = (text: string, width: number): string => (width > 0 ? truncateToWidth(text, width) : text);

interface Row { head: string; body?: string }

/** Render a snapshot without side effects; return no lines when there is nothing to display. */
export function statusLines(agents: AgentView[], options: StatusLinesOptions): string[] {
  const { now, theme, width } = options;
  const lingerMs = options.lingerMs ?? FINISHED_LINGER_MS;
  const list = Array.isArray(agents) ? agents : [];
  const waiting = list.filter((agent) => agent.phase === "waiting").sort(byStart);
  const active = list.filter((agent) => isActive(agent.phase) && agent.phase !== "waiting").sort(byStart);
  const finished = list.filter((agent) => isTerminal(agent.phase) && now - agent.updatedAt <= lingerMs).sort(byStart);
  // Prefer the most recently finished instances when space is limited.
  const recent = [...finished].reverse();

  const details = (agent: AgentView): string => {
    const error = oneLine(agent.error, BODY_LIMIT);
    return error ? `${phaseLabel(agent.phase)}: ${error}` : phaseLabel(agent.phase);
  };
  const row = (icon: string, color: UiColor, agent: AgentView, detail: string, activity?: string): Row => {
    const task = oneLine(agent.task, HEAD_LIMIT);
    const role = theme.fg("text", theme.bold(agent.role));
    const left = `${theme.fg("dim", "├─")} ${theme.fg(color, icon)} ${role} ${theme.fg("dim", shortId(agent.id))}${task ? `  ${theme.fg("muted", task)}` : ""}`;
    // Status and elapsed time take priority over the task summary on narrow terminals.
    const stats = theme.fg("dim", `· ${detail} · ${formatElapsed(viewElapsed(agent, now))}`);
    return {
      head: rightAlign(left, stats, width),
      ...(activity === undefined ? {} : { body: `${theme.fg("dim", "│    ")}${theme.fg("muted", "⎿ ")}${theme.fg("dim", activity)}` }),
    };
  };

  // Display priority: waiting for a response, active, then recently finished.
  const groups: { rows: Row[] }[] = [
    { rows: waiting.map((agent) => row(phaseIcon("waiting"), "warning", agent, "Waiting", oneLine(agent.questions?.[0]?.title, BODY_LIMIT) || "Waiting for a response")) },
    { rows: active.map((agent) => row(SPINNER[Math.abs(options.frame) % SPINNER.length], "accent", agent, phaseLabel(agent.phase), oneLine(agent.lastActivity, BODY_LIMIT) || "Starting...")) },
    { rows: recent.map((agent) => row(phaseIcon(agent.phase), phaseColor(agent.phase), agent, details(agent))) },
  ];

  const heading = (): string => {
    const counts = [[active.length, "running"], [waiting.length, "waiting"], [finished.length, "ended"]]
      .filter(([count]) => Number(count) > 0).map(([count, label]) => `${count} ${label}`);
    const color = waiting.length || active.length ? "accent" : "dim";
    return theme.fg(color, `${waiting.length || active.length ? "●" : "○"} Subagents`) +
      (counts.length ? theme.fg("dim", ` · ${counts.join(" · ")}`) : "") +
      theme.fg("dim", " · Ctrl+Alt+A view");
  };
  if (!waiting.length && !active.length && !finished.length) return [];

  const budget = MAX_STATUS_LINES - 1 - 1; // One line each for heading and overflow hint
  const rows: Row[] = [];
  let used = 0;
  let hidden = 0;
  for (const group of groups) {
    for (const [index, entry] of group.rows.entries()) {
      const size = entry.body ? 2 : 1;
      if (used + size > budget) { hidden += group.rows.length - index; break; }
      used += size;
      rows.push(entry);
    }
  }

  const lastIndex = rows.length - 1;
  const body = rows.flatMap((entry, index) => {
    const isLast = index === lastIndex;
    return entry.body
      ? [isLast ? entry.head.replace("├─", "└─") : entry.head, isLast ? entry.body.replace("│    ", "   ") : entry.body]
      : [isLast ? entry.head.replace("├─", "└─") : entry.head];
  });
  const overflow = hidden > 0 ? [theme.fg("dim", `+ ${hidden} more (/agents)`)] : [];
  return [heading(), ...body, ...overflow].map((line) => shorten(line, width));
}

/**
 * Register only while there is visible content; remove the widget after the linger period.
 * Pi renders the component. The timer advances activity frames and refreshes active snapshots.
 */
export class StatusWidget {
  private snapshot: AgentView[] = [];
  private frame = 0;
  private tui: WidgetTui | undefined;
  private registered = false;
  private interval: NodeJS.Timeout | undefined;
  private disposed = false;
  private lastError: string | undefined;
  private readonly key: string;
  private readonly lingerMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly host: WidgetHost,
    private readonly read: () => AgentView[],
    options: { key?: string; lingerMs?: number; intervalMs?: number } = {},
  ) {
    this.key = options.key ?? STATUS_KEY;
    this.lingerMs = options.lingerMs ?? FINISHED_LINGER_MS;
    this.intervalMs = options.intervalMs ?? 500;
  }

  update(): void {
    if (this.disposed) return;
    this.refresh();
    if (this.hasActive()) {
      this.register();
      this.startTick();
      this.tui?.requestRender();
      return;
    }
    this.stopTick();
    if (this.hasContent(Date.now())) { this.register(); this.tui?.requestRender(); }
    else this.unregister();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTick();
    this.unregister();
    this.snapshot = [];
  }

  /** Keep the last good snapshot on read failure; never throw into the render loop. */
  private refresh(): void {
    try {
      const next = this.read();
      if (Array.isArray(next)) { this.snapshot = next; this.lastError = undefined; }
    } catch (error) {
      const message = (error as Error).message;
      if (message !== this.lastError) { this.lastError = message; console.error("[pi-cli-subagents] Status snapshot unavailable:", message); }
    }
  }
  private hasActive(): boolean { return this.snapshot.some((agent) => isActive(agent.phase)); }
  private hasContent(now: number): boolean {
    return this.snapshot.some((agent) => isActive(agent.phase) || now - agent.updatedAt <= this.lingerMs);
  }
  private register(): void {
    if (this.registered || this.disposed) return;
    this.host.setWidget(this.key, (tui, theme) => {
      this.tui = tui;
      return {
        render: (width: number) => statusLines(this.snapshot, { now: Date.now(), frame: this.frame, width, theme, lingerMs: this.lingerMs }),
        invalidate: () => {},
      };
    });
    this.registered = true;
  }
  private unregister(): void {
    this.tui = undefined;
    if (!this.registered) return;
    this.registered = false;
    this.host.setWidget(this.key, undefined);
  }
  private startTick(): void {
    if (this.interval || this.disposed) return;
    this.interval = setInterval(() => {
      if (this.disposed) return;
      try {
        this.frame = (this.frame + 1) % SPINNER.length;
        this.refresh();
        if (!this.hasActive()) { this.stopTick(); if (!this.hasContent(Date.now())) { this.unregister(); return; } }
        this.tui?.requestRender();
      } catch (error) { console.error("[pi-cli-subagents] Status refresh failed:", error); }
    }, this.intervalMs);
    this.interval.unref?.();
  }
  private stopTick(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }
}

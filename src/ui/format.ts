import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentView, Phase } from "../types.js";

/** The UI depends only on these theme methods, allowing tests to use a minimal theme. */
export type UiColor = "accent" | "border" | "dim" | "error" | "muted" | "success" | "text" | "warning";
export interface UiTheme {
  fg(color: UiColor, text: string): string;
  bold(text: string): string;
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Below this the frame would leave no room for content, so a pane renders unframed. */
export const PANE_FRAME_MIN_WIDTH = 12;
/** Rows (top and bottom rule) and columns (two borders plus their padding) the frame costs. */
export const PANE_FRAME_ROWS = 2;
export const PANE_FRAME_COLS = 4;

/**
 * Draw Pi's editor border around a pane above the editor. Every pane shares this one definition,
 * so the roster cannot drift from the role editor it is meant to match.
 */
export function framePane(lines: string[], width: number, paint: (text: string) => string): string[] {
  const inner = Math.max(1, width - PANE_FRAME_COLS);
  const rule = (left: string, right: string) => paint(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
  const body = lines.map((line) => {
    const clipped = truncateToWidth(line, inner);
    return `${paint("│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${paint("│")}`;
  });
  return [rule("╭", "╮"), ...body, rule("╰", "╯")];
}

export const PHASE_LABEL: Record<Phase, string> = {
  starting: "Starting", running: "Running", waiting: "Waiting", stopping: "Stopping",
  completed: "Completed", failed: "Failed", stopped: "Stopped", idle: "Idle", closed: "Closed", unreachable: "Unreachable",
};

export const isActive = (phase: Phase): boolean => ["starting", "running", "waiting", "stopping"].includes(phase);
export const isTerminal = (phase: Phase): boolean => ["completed", "failed", "stopped", "closed", "unreachable"].includes(phase);

/** Idle has no active run, but still owns processes which can be explicitly released. */
export const canStop = (phase: Phase): boolean => isActive(phase) || phase === "idle";
export const canResume = (phase: Phase): boolean => ["completed", "failed", "stopped", "closed"].includes(phase);

/** Only resident v2 backends expose current-run interruption; closing is a different operation. */
export const canInterrupt = (view: Pick<AgentView, "protocolVersion" | "cli" | "phase">): boolean =>
  view.protocolVersion === 2 && (view.cli === "pi" || view.cli === "codex") && ["starting", "running", "waiting"].includes(view.phase);

/** Waiting children do not accept messages; their questions must go through /agent-reply. */
export const canSteer = (phase: Phase): boolean => phase === "starting" || phase === "running";

/**
 * Running instances are steered, idle ones start a new run in the resident runtime, and closed
 * ones resume their native session. Waiting, stopping and unreachable instances cannot accept input.
 */
export const canMessage = (phase: Phase): boolean => canSteer(phase) || phase === "idle" || canResume(phase);

/** Unknown phases from old or manually edited records should remain visible. */
export const phaseLabel = (phase: Phase): string => PHASE_LABEL[phase] ?? String(phase);

export function phaseIcon(phase: Phase): string {
  if (phase === "completed") return "✓";
  if (phase === "failed") return "✗";
  if (phase === "stopped" || phase === "closed") return "■";
  if (phase === "idle") return "○";
  if (phase === "waiting" || phase === "unreachable") return "⚠";
  return "·";
}

export function phaseColor(phase: Phase): UiColor {
  if (phase === "completed") return "success";
  if (phase === "failed") return "error";
  if (phase === "stopped" || phase === "stopping" || phase === "closed") return "muted";
  if (phase === "waiting" || phase === "unreachable") return "warning";
  return "accent";
}

/** A previous failed run must not turn a new running input into a failed receipt. */
export const hasFailure = (view: Pick<AgentView, "phase" | "lastStatus" | "error">): boolean =>
  view.phase === "failed" || ((view.phase === "idle" || view.phase === "closed") && (view.lastStatus === "failed" || Boolean(view.error)));

/** Lifecycle and last-run outcome are separate: an idle/closed runtime can still show a failure. */
export function viewStatus(view: Pick<AgentView, "phase" | "lastStatus" | "error">): { label: string; icon: string; color: UiColor } {
  const settled = view.phase === "idle" || view.phase === "closed";
  const last = settled && view.lastStatus ? ` · last ${phaseLabel(view.lastStatus)}` : "";
  const error = settled && view.error && view.lastStatus !== "failed" ? " · Error" : "";
  return { label: `${phaseLabel(view.phase)}${last}${error}`,
    icon: hasFailure(view) ? phaseIcon("failed") : phaseIcon(view.phase),
    color: hasFailure(view) ? "error" : phaseColor(view.phase) };
}

/** Strip terminal sequences, collapse whitespace and clip user-supplied text. */
export function oneLine(text: string | undefined, limit: number): string {
  if (typeof text !== "string") return "";
  const flat = stripTerminalSequences(text).replace(/\s+/g, " ").trim();
  return limit > 0 ? flat.slice(0, limit) : flat;
}

/** `512`, `12.3k`, `1.2M` — compact token counts for status lines. */
export function formatTokens(count: number): string {
  const value = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number): string {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const seconds = Math.floor(value / 1000);
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  if (value < 3_600_000) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export const viewStartedAt = (view: AgentView): number => view.startedAt ?? view.updatedAt;

/**
 * Same-role instances are only distinguishable by identity, and a full UUID crowds out the task
 * summary on narrow terminals. Lists show this stable prefix; detail views keep the full ID.
 */
export const shortId = (id: string): string => (typeof id === "string" ? id.slice(0, 8) : "");

/** Run elapsed time stops while idle as well as after the runtime closes. */
export const viewElapsed = (view: AgentView, now: number): number =>
  (isActive(view.phase) ? now : view.updatedAt) - viewStartedAt(view);

/** Preserve right-aligned statistics by clipping the left text first. */
export function rightAlign(left: string, right: string, width: number): string {
  if (width <= 0) return left ? `${left} ${right}` : right;
  const room = width - visibleWidth(right) - 1;
  if (room < 1) return truncateToWidth(right, width);
  const head = truncateToWidth(left, room);
  return `${head}${" ".repeat(Math.max(0, room - visibleWidth(head)))} ${right}`;
}

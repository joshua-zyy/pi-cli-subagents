import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentView, Phase } from "../types.js";

/** The UI depends only on these theme methods, allowing tests to use a minimal theme. */
export type UiColor = "accent" | "border" | "dim" | "error" | "muted" | "success" | "text" | "warning";
export interface UiTheme {
  fg(color: UiColor, text: string): string;
  bold(text: string): string;
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const PHASE_LABEL: Record<Phase, string> = {
  starting: "Starting", running: "Running", waiting: "Waiting", stopping: "Stopping",
  completed: "Completed", failed: "Failed", stopped: "Stopped", unreachable: "Unreachable",
};

export const isActive = (phase: Phase): boolean => ["starting", "running", "waiting", "stopping"].includes(phase);
export const isTerminal = (phase: Phase): boolean => !isActive(phase);

/** Waiting children do not accept messages; their questions must go through /agent-reply. */
export const canSteer = (phase: Phase): boolean => phase === "starting" || phase === "running";

/** Unknown phases from old or manually edited records should remain visible. */
export const phaseLabel = (phase: Phase): string => PHASE_LABEL[phase] ?? String(phase);

export function phaseIcon(phase: Phase): string {
  if (phase === "completed") return "✓";
  if (phase === "failed") return "✗";
  if (phase === "stopped") return "■";
  if (phase === "waiting" || phase === "unreachable") return "⚠";
  return "·";
}

export function phaseColor(phase: Phase): UiColor {
  if (phase === "completed") return "success";
  if (phase === "failed") return "error";
  if (phase === "stopped" || phase === "stopping") return "muted";
  if (phase === "waiting" || phase === "unreachable") return "warning";
  return "accent";
}

/** Strip terminal sequences, collapse whitespace and clip user-supplied text. */
export function oneLine(text: string | undefined, limit: number): string {
  if (typeof text !== "string") return "";
  const flat = stripTerminalSequences(text).replace(/\s+/g, " ").trim();
  return limit > 0 ? flat.slice(0, limit) : flat;
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

/** Freeze elapsed time at updatedAt for terminal states. */
export const viewElapsed = (view: AgentView, now: number): number =>
  (isTerminal(view.phase) ? view.updatedAt : now) - viewStartedAt(view);

/** Preserve right-aligned statistics by clipping the left text first. */
export function rightAlign(left: string, right: string, width: number): string {
  if (width <= 0) return left ? `${left} ${right}` : right;
  const room = width - visibleWidth(right) - 1;
  if (room < 1) return truncateToWidth(right, width);
  const head = truncateToWidth(left, room);
  return `${head}${" ".repeat(Math.max(0, room - visibleWidth(head)))} ${right}`;
}

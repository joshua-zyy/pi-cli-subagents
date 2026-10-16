import type { TranscriptSnapshot } from "./transcript.js";
import type { Cli } from "./types.js";

/** Native-reported token totals; present only when one bounded read covered the whole retained log. */
export interface ReportedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Only when the native CLI reported a real amount; a placeholder zero stays absent. */
  cost?: number;
  /** These are native session totals, not one run's usage. */
  scope: "session";
}

export type UsageProjection = { usageComplete: false; usageNote?: string } | { usageComplete: true; usage: ReportedUsage };

/** Reasons a total may be missing, so a parent can tell "not readable here" from "not reported yet". */
export const USAGE_TOO_LARGE = "the retained log is larger than the bounded transcript window";
export const USAGE_UNREADABLE = "the retained log could not be read";
export const USAGE_INCOMPLETE = "the native session has not reported a complete token breakdown";

/**
 * Project the child's own reported usage for a query response.
 * The transcript layer publishes totals only for a parse that covered every retained run, and the Pi
 * reader marks totals that silently lack a counter; anything else must stay unknown rather than show
 * a partial sum, or an unreported field as zero, as if it were the session total.
 */
export function projectUsage(snapshot: TranscriptSnapshot, cli: Cli, unavailableNote?: string): UsageProjection {
  const totals = snapshot.usage;
  if (snapshot.usageComplete !== true || totals === undefined || totals.countersIncomplete === true)
    return { usageComplete: false, ...(unavailableNote === undefined ? {} : { usageNote: unavailableNote }) };
  return { usageComplete: true, usage: {
    input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite,
    // Codex reports a placeholder cost of zero and Pi may report none; only a real amount may appear.
    ...(cli === "claude" || (cli === "pi" && totals.cost > 0) ? { cost: totals.cost } : {}),
    scope: "session",
  } };
}

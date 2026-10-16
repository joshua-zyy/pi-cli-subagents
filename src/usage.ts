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
  /** Time of the newest readable event log when this projection was taken, if it could be read. */
  asOf?: string;
}

export type UsageProjection = { usageComplete: false } | { usageComplete: true; usage: ReportedUsage };

/**
 * Project the child's own reported usage for a query response.
 * The transcript layer publishes totals only for a parse that covered every retained run; anything
 * else must stay unknown rather than show a partial sum as if it were the session total.
 */
export function projectUsage(snapshot: TranscriptSnapshot, cli: Cli, asOf?: string): UsageProjection {
  const totals = snapshot.usage;
  if (snapshot.usageComplete !== true || totals === undefined) return { usageComplete: false };
  return { usageComplete: true, usage: {
    input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite,
    // Codex reports a placeholder cost of zero and Pi may report none; only a real amount may appear.
    ...(cli === "claude" || (cli === "pi" && totals.cost > 0) ? { cost: totals.cost } : {}),
    scope: "session",
    ...(asOf === undefined ? {} : { asOf }),
  } };
}

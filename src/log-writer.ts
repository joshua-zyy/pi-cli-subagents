import { createWriteStream, readdirSync, lstatSync, unlinkSync, type WriteStream } from "node:fs";
import path from "node:path";

/**
 * Raw CLI streams are diagnostic detail, not the durable record: reports, state and the native
 * session are. An instance drops the oldest runs' raw streams once they exceed this budget. Whole
 * files are removed, never rewritten, because the activity cursors and the transcript window
 * depend on surviving files keeping their bytes. A run whose stream is gone keeps its request
 * record, report and status.
 *
 * The budget is enforced when a run starts, so the run in progress and an instance that never runs
 * again may exceed it, and stderr companions are not counted.
 */
export const LOG_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * The raw stream of one runtime. The child's stderr stays on the launch run's file: it is small and
 * no reader lists it. Rotation points stdout at another run's file and leaves the old one intact.
 */
export class LogWriter {
  private output: WriteStream;
  private readonly errors: WriteStream;
  constructor(file: string, private readonly onError: (error: Error) => void) {
    this.output = createWriteStream(file, { flags: "a", mode: 0o600 });
    this.errors = createWriteStream(`${file}.stderr`, { flags: "a", mode: 0o600 });
    this.output.on("error", onError);
    this.errors.on("error", onError);
  }
  get stream(): WriteStream { return this.output; }
  get errorStream(): WriteStream { return this.errors; }
  rotate(file: string): void {
    const previous = this.output;
    this.output = createWriteStream(file, { flags: "a", mode: 0o600 });
    this.output.on("error", this.onError);
    previous.end();
    // end() flushes the buffer, so a source paused on this stream's backpressure may resume now.
    previous.emit("drain");
  }
  end(): void { this.output.end(); this.errors.end(); }
}

const runIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/**
 * Remove the oldest runs' raw streams until this instance fits the budget, and report what was
 * removed. Symlinked run directories and log files are skipped, the run that is starting is never
 * removed, and the protected run keeps its stderr companion because the live runtime still writes
 * there.
 */
export function pruneRunLogs(instanceDir: string, keepRunId: string, budget = LOG_BUDGET_BYTES, protectedRunId = keepRunId): string[] {
  const root = path.join(instanceDir, "runs");
  let names: string[];
  try { names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return []; }
  const logs = names.filter(runId => runIdPattern.test(runId)).flatMap(runId => {
    const file = path.join(root, runId, "events.jsonl");
    try {
      // lstat, not stat: a symlinked stream is not this instance's file to remove.
      const info = lstatSync(file);
      return info.isFile() ? [{ runId, file, size: info.size, age: info.mtimeMs }] : [];
    } catch { return []; }
  }).sort((a, b) => a.age - b.age);
  let total = logs.reduce((sum, log) => sum + log.size, 0);
  const removed: string[] = [];
  for (const log of logs) {
    if (total <= budget) break;
    if (log.runId === keepRunId) continue;
    try { unlinkSync(log.file); }
    catch { continue; }
    total -= log.size;
    removed.push(log.file);
    if (log.runId === protectedRunId) continue;
    try { unlinkSync(`${log.file}.stderr`); } catch { /* the companion may already be gone */ }
  }
  return removed;
}

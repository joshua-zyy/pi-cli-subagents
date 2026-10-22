import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const terminating = new WeakMap<ChildProcess, Promise<void>>();

interface PosixProcess { pid: number; parent: number; group: number; started: string }

/** Linux and macOS ps fields; no command lines or environment values are collected. */
async function processSnapshot(selection: string[], deadline: number): Promise<Map<number, PosixProcess>> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error("POSIX process-tree inspection timed out");
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("ps", [...selection, "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart="], {
      env: { ...process.env, LC_ALL: "C" }, shell: false, timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    }, (error, output) => error ? reject(error) : resolve(output));
  });
  const rows = new Map<number, PosixProcess>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("Invalid POSIX process-tree snapshot");
    const pid = Number(match[1]);
    rows.set(pid, { pid, parent: Number(match[2]), group: Number(match[3]), started: match[4] });
  }
  return rows;
}

function sameProcess(actual: PosixProcess | undefined, expected: PosixProcess): boolean {
  return actual !== undefined && actual.pid === expected.pid && actual.parent === expected.parent
    && actual.group === expected.group && actual.started === expected.started;
}

async function killPosixTree(child: ChildProcess, pid: number): Promise<void> {
  // One total inspection budget, not a fresh timeout multiplied by descendant count.
  const deadline = Date.now() + 1000;
  const snapshot = await processSnapshot(["-A"], deadline);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const root = snapshot.get(pid);
  if (!root || root.parent !== process.pid) throw new Error("POSIX root ownership could not be verified");
  const tree = [root], seen = new Set([pid]);
  for (let i = 0; i < tree.length; i++) for (const row of snapshot.values()) {
    if (row.parent === tree[i].pid && !seen.has(row.pid)) { seen.add(row.pid); tree.push(row); }
  }
  // A tool can setsid()/detach out of the CLI group. Kill only those captured
  // descendants individually, deepest first, before terminating the original group.
  for (let i = tree.length - 1; i > 0; i--) {
    const target = tree[i];
    if (target.group === pid) continue;
    const current = await processSnapshot(["-p", `${pid},${target.pid}`], deadline);
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!sameProcess(current.get(pid), root)) throw new Error("POSIX root identity changed during cleanup");
    const actual = current.get(target.pid);
    if (!actual) continue; // This captured descendant has already disappeared.
    if (!sameProcess(actual, target)) throw new Error(`POSIX descendant ${target.pid} identity changed during cleanup`);
    try { process.kill(target.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Never address an unrelated process group when this child was not its leader.
  if (root.group !== pid) {
    if (!child.kill("SIGKILL")) throw new Error("Direct-child SIGKILL failed");
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch { if (!child.kill("SIGKILL")) throw new Error("Process-group and direct-child SIGKILL failed"); }
  }
}

/** One in-flight attempt per child, not a permanent "already killed" flag. Callers still await close. */
export function killProcessTree(child: ChildProcess): Promise<void> {
  const existing = terminating.get(child);
  if (existing) return existing;
  // Defer the attempt until it is registered: child error events may re-enter termination.
  const operation = Promise.resolve().then(async () => {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        const [code, signal] = await once(killer, "close");
        if (code !== 0 && child.exitCode === null && child.signalCode === null) {
          throw new Error(`taskkill.exe exited with ${code ?? signal ?? "unknown status"}`);
        }
      } else {
        await killPosixTree(child, pid);
      }
    } catch (error) {
      // A Windows root-only fallback can leave descendants writing after the root exits.
      // Do not turn a failed tree kill into a stop receipt or reject an unobserved timer promise.
      console.error(`[pi-cli-subagents] Could not terminate process tree ${pid}: ${(error as Error).message}. Exit is unconfirmed; later cleanup may retry.`);
    }
  }).finally(() => terminating.delete(child));
  terminating.set(child, operation);
  return operation;
}

/**
 * Terminate this child's process tree and record that the shutdown was forced, unless the child
 * already exited: an exited child, or one without a pid, has nothing to kill and must not be
 * reported as forced. `onForced` runs before the termination is awaited on purpose — `end()` reads
 * the owner's forced marker after `closed` resolves, and the child's close event regularly arrives
 * while the termination command is still running.
 */
export async function terminateProcessTree(child: ChildProcess, onForced: () => void): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  onForced();
  await killProcessTree(child);
}

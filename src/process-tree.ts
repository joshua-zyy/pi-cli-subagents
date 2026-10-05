import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

const terminating = new WeakMap<ChildProcess, Promise<void>>();

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
        try { process.kill(-pid, "SIGKILL"); }
        catch { if (!child.kill("SIGKILL")) throw new Error("Process-group and direct-child SIGKILL failed"); }
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

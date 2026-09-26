import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  // Windows fails rename while another process holds the target open for reading.
  // Retry briefly instead of losing a state update to a concurrent poll.
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, file); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY" && code !== "ENOTEMPTY")) {
        try { unlinkSync(temporary); } catch { /* the retry loop already reported the real failure */ }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
export function directories(root: string): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function jsonFiles(root: string): string[] {
  try { return readdirSync(root).filter((file) => file.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function processAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
export async function waitUntil<T>(label: string, check: () => T | Promise<T>, timeout = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < end);
  throw new Error(`${label} timed out; inspect state and logs before retrying.`);
}
export function shorten(text: string, limit = 12_000): { text: string; truncated: boolean } {
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

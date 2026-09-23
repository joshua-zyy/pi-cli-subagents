import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
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
  renameSync(temporary, file);
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
  throw new Error(`${label} 超时；检查状态与日志，勿直接重复派发。`);
}
export function shorten(text: string, limit = 12_000): { text: string; truncated: boolean } {
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import type { Launch } from "./types.js";

// Minimal structural view of Pi RPC; event-specific fields belong to Pi's versioned protocol.
export interface WireRecord {
  type: string;
  id?: string;
  success?: boolean;
  error?: unknown;
  data?: Record<string, unknown>;
  message?: WireRecord | string;
  content?: WireRecord[];
  stopReason?: string;
  errorMessage?: string;
  text?: string;
  toolName?: string;
  method?: string;
  title?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  role?: string;
  [key: string]: unknown;
}
export interface Exit { code: number | null; signal: NodeJS.Signals | null }
export function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, PI_CLI_SUBAGENT: "1" };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"]) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}

export class PiProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<Exit>;
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private exitError?: Error;
  private buffer = "";
  private forced = false;

  constructor(launch: Launch, args: string[], cwd: string, logFile: string, onRecord: (record: WireRecord) => void) {
    const output = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    const stderr = createWriteStream(`${logFile}.stderr`, { flags: "a", mode: 0o600 });
    // The launch is a trusted CLI path, each option is a separate argv element; never invoke a shell.
    this.child = spawn(launch.command, [...launch.args, ...args], {
      cwd, env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"], shell: false,
      windowsHide: true, detached: process.platform !== "win32",
    });
    const fail = (error: Error) => {
      this.exitError = error;
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
    output.on("error", (error) => { fail(error); void this.kill(); });
    stderr.on("error", (error) => { fail(error); void this.kill(); });
    this.child.stderr.pipe(stderr);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (!output.write(chunk)) { this.child.stdout.pause(); output.once("drain", () => this.child.stdout.resume()); }
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const record: WireRecord = JSON.parse(line);
          if (!record || typeof record.type !== "string") throw new Error("Pi stdout 不是有效 RPC 记录");
          const entry = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
          if (record.type === "response" && entry) {
            this.pending.delete(record.id!);
            if (record.success === true) entry.resolve(record.data ?? {});
            else entry.reject(new Error(String(record.error ?? "RPC 命令失败")));
          } else onRecord(record);
        } catch (error) { fail(error as Error); void this.kill(); return; }
      }
    });
    this.child.once("error", fail);
    this.child.stdin.on("error", fail);
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        fail(this.exitError ?? new Error(`子 Pi 已退出 (${code ?? signal})`));
        output.end();
        resolve({ code, signal });
      });
    });
  }

  request<T = WireRecord>(command: WireRecord, timeout = 30_000): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = `cli-subagents-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} 超时，受理状态未知；请检查实例，不要重复派发。`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
      });
    });
  }

  async reply(record: Record<string, unknown>): Promise<void> {
    if (this.exitError) throw this.exitError;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify({ ...record, type: "extension_ui_response" })}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  async end(): Promise<{ exit: Exit; forced: boolean }> {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const timer = setTimeout(() => { void this.kill(); }, 5000);
    try { return { exit: await this.closed, forced: this.forced }; }
    finally { clearTimeout(timer); }
  }

  async stop(): Promise<{ exit: Exit; forced: boolean }> {
    try {
      await this.request({ type: "clear_queue" }, 5000);
      await this.request({ type: "abort" }, 10_000);
    } catch { await this.kill(); }
    return this.end();
  }

  private async kill(): Promise<void> {
    if (this.forced || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return;
    this.forced = true;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      try { await once(killer, "close"); } catch { this.child.kill("SIGKILL"); }
    } else {
      try { process.kill(-this.child.pid, "SIGKILL"); } catch { this.child.kill("SIGKILL"); }
    }
  }
}

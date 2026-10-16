import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LogWriter } from "./log-writer.js";
import { terminateProcessTree } from "./process-tree.js";
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
  private pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error, nativeRejected?: boolean) => void }>();
  private nextId = 0;
  private exitError?: Error;
  private buffer = "";
  private forced = false;
  private closing = false;
  private poisoned?: Error;
  private readonly log: LogWriter;

  /** Point the runtime's raw stream at another run's log file; the previous file keeps its bytes. */
  rotateLog(file: string): void { this.log.rotate(file); }
  private interrupting?: Promise<void>;
  private run?: { started: boolean; validating: boolean; inFlightInputs: number; deferredTerminal?: WireRecord; done: Promise<void>; resolve: () => void };

  constructor(launch: Launch, args: string[], cwd: string, logFile: string, private readonly onRecord: (record: WireRecord) => void, private readonly timeout = 30_000) {
    const fail = (error: Error) => {
      this.exitError = error;
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
    this.log = new LogWriter(logFile, (error) => { fail(error); void this.kill(); });
    // The launch is a trusted CLI path, each option is a separate argv element; never invoke a shell.
    this.child = spawn(launch.command, [...launch.args, ...args], {
      cwd, env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"], shell: false,
      windowsHide: true, detached: process.platform !== "win32",
    });
    this.child.stderr.pipe(this.log.errorStream);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      const output = this.log.stream;
      if (!output.write(chunk)) { this.child.stdout.pause(); output.once("drain", () => this.child.stdout.resume()); }
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const record: WireRecord = JSON.parse(line);
          if (!record || typeof record.type !== "string") throw new Error("Pi stdout is not a valid RPC record");
          const entry = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
          if (record.type === "response" && entry) {
            this.pending.delete(record.id!);
            if (record.success === true) entry.resolve(record.data ?? {});
            else entry.reject(new Error(String(record.error ?? "RPC command failed")), record.success === false);
          } else this.record(record);
        } catch (error) { fail(error as Error); void this.kill(); return; }
      }
    });
    this.child.once("error", fail);
    this.child.stdin.on("error", fail);
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        fail(this.exitError ?? new Error(`Child Pi exited (${code ?? signal})`));
        this.log.end();
        resolve({ code, signal });
      });
    });
  }

  private record(record: WireRecord): void {
    const run = this.run;
    if (record.type === "agent_start" && run) run.started = true;
    if (record.type === "agent_settled") {
      if (!run?.started) return;
      run.deferredTerminal = record;
      this.validateTerminal(run);
      return;
    }
    this.onRecord(record);
  }

  private validateTerminal(run = this.run): void {
    if (!run || this.run !== run || this.poisoned || this.exitError || run.validating || run.inFlightInputs || !run.deferredTerminal) return;
    const terminal = run.deferredTerminal;
    run.validating = true;
    // Pi 1.1.0 prompt awaits input handlers before acknowledging preflight. Its
    // get_state cannot see those inputs, which may start another internal turn.
    // Keep one host assignment until every input has an outcome and native is idle.
    void this.request<{ isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number }>({ type: "get_state" }).then(state => {
      run.validating = false;
      if (this.run !== run || this.poisoned || this.exitError) return;
      // A newer terminal can arrive while this snapshot is in flight. Validate
      // that event once, rather than publishing an older snapshot or polling.
      if (run.deferredTerminal !== terminal) { this.validateTerminal(run); return; }
      run.deferredTerminal = undefined;
      if (state.isStreaming !== false || state.isCompacting || state.pendingMessageCount) return;
      this.run = undefined;
      this.onRecord(terminal);
      run.resolve();
    }).catch(error => {
      run.validating = false;
      if (this.run && this.run !== run) return;
      this.poisoned ??= error; void this.kill();
    });
  }

  /** Check before an adapter resets its run-local buffers as well as before writing. */
  assertPromptAllowed(streaming = false): void {
    if (this.exitError) throw this.exitError;
    if (this.poisoned) throw this.poisoned;
    if (this.closing) throw new Error("Pi runtime is closing");
    if (this.interrupting) throw new Error("Pi interrupt is still pending");
    if (streaming && this.run?.validating) throw new Error("Pi terminal validation is still pending; wait for this run to settle");
    if (!streaming && this.run) throw new Error("Pi already has an active run");
    if (streaming && !this.run) throw new Error("Pi has no active run");
  }

  request<T = WireRecord>(command: WireRecord, timeout = this.timeout): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (command.type === "prompt") {
      try { this.assertPromptAllowed(!!command.streamingBehavior); } catch (error) { return Promise.reject(error); }
      if (!command.streamingBehavior) {
        let resolve!: () => void;
        const done = new Promise<void>(r => { resolve = r; });
        this.run = { started: false, validating: false, inFlightInputs: 0, done, resolve };
      }
    }
    const id = `cli-subagents-${++this.nextId}`, reserved = this.run;
    const input = command.type === "prompt" ? reserved : undefined;
    if (input) input.inFlightInputs++;
    let nativeRejected = false;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} timed out; acceptance is uncertain. Stop/release the runtime before retrying.`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error, confirmed = false) => { clearTimeout(timer); nativeRejected = confirmed; reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
      });
    }).catch(error => {
      if (command.type === "prompt") {
        // success:false is a preflight refusal for this input, not evidence that
        // another input in this assignment failed or that an old run restarted.
        if (nativeRejected && command.streamingBehavior) { /* No acceptance to undo or replay. */ }
        else if (nativeRejected && reserved && this.run === reserved && !reserved.started && reserved.inFlightInputs === 1) {
          this.run = undefined; reserved.resolve();
        } else this.poisoned = error;
      }
      throw error;
    }).finally(() => {
      if (input) { input.inFlightInputs--; this.validateTerminal(input); }
    });
  }

  interrupt(): Promise<void> {
    if (this.poisoned) return Promise.reject(this.poisoned);
    if (this.interrupting) return this.interrupting;
    const run = this.run;
    if (!run) return Promise.resolve();
    let timer: NodeJS.Timeout;
    const operation = (async () => {
      await this.request({ type: "clear_queue" });
      // Do not abort a replacement run after an asynchronous queue response.
      if (this.run === run) await this.request({ type: "abort" });
      await run.done;
    })();
    this.interrupting = Promise.race([operation, this.closed.then(() => {}), new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Pi interrupt timed out; runtime is uncertain. Stop/release before new work.")), this.timeout);
    })]).catch(error => { this.poisoned = error; throw error; }).finally(() => {
      clearTimeout(timer); this.interrupting = undefined;
    });
    return this.interrupting;
  }

  async reply(record: Record<string, unknown>): Promise<void> {
    if (this.exitError) throw this.exitError;
    if (this.poisoned) throw this.poisoned;
    if (this.interrupting || this.closing) throw new Error("Pi interrupt or shutdown pending; interaction is no longer active");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify({ ...record, type: "extension_ui_response" })}\n`, (error) => error ? reject(error) : resolve());
    }).catch(error => {
      this.poisoned = new Error(`Pi question delivery is uncertain; stop/release before new work: ${(error as Error).message}`);
      throw this.poisoned;
    });
  }

  async end(): Promise<{ exit: Exit; forced: boolean }> {
    this.closing = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const timer = setTimeout(() => { void this.kill(); }, 5000);
    try { return { exit: await this.closed, forced: this.forced }; }
    finally { clearTimeout(timer); }
  }

  async stop(): Promise<{ exit: Exit; forced: boolean }> {
    this.closing = true;
    const timer = setTimeout(() => { void this.kill(); }, 5000);
    try {
      // Release always clears queued work, even while already idle or poisoned.
      try {
        await this.request({ type: "clear_queue" }, Math.min(this.timeout, 5000));
        if (!this.poisoned) await this.interrupt();
      } catch { /* Closing stdin and the stop deadline still release the tree. */ }
      return await this.end();
    } finally { clearTimeout(timer); }
  }

  private async kill(): Promise<void> {
    await terminateProcessTree(this.child, () => { this.forced = true; });
  }
}

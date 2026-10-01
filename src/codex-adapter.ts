import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterOptions, CliAdapter, InteractionReply } from "./cli-adapter.js";
import { childEnvironment, type Exit } from "./pi-process.js";
import type { NativeSession, Delivery } from "./types.js";

type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const textInput = (text: string) => [{ type: "text", text }];
const requestKey = (id: string | number): string => `${typeof id}:${id}`;
type Approval = { id: string; rpcId: string | number; threadId: string; turnId: string;
  attempted: boolean; allowed?: Set<string>; resolved?: () => void; rejected?: (error: Error) => void }; 

/** One worker owns one app-server process and one thread at a time. */
export class CodexAdapter implements CliAdapter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<Exit>;
  private pending = new Map<number, { resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 0;
  private buffer = "";
  private exitError?: Error;
  private forced = false;
  private ending = false;
  private failed = false;
  private activeTurn?: string;
  private lastCompletedTurn?: string;
  private thread?: NativeSession & { cli: "codex" };
  private textByItem = new Map<string, string>();
  private completedItems = new Map<string, string>();
  private finalAnswerId?: string;
  private approvalItems = new Map<string, RecordValue>();
  private approvals = new Map<string, Approval>();
  private approvalByRpcId = new Map<string, Approval>();
  private completion = Promise.resolve();
  private turnEnded?: () => void;
  private readonly timeout: number;

  get pid(): number | undefined { return this.child.pid; }

  constructor(private readonly options: AdapterOptions) {
    if (options.spec.role.cli !== "codex" || !options.spec.role.model?.trim() || !options.spec.codexHome) throw new Error("Codex requires an explicit model and a pinned native home");
    if (options.session && (options.session.cli !== "codex" || options.session.codexHome !== options.spec.codexHome)) throw new Error("Codex native home or CLI differs from the original session");
    this.timeout = options.requestTimeout ?? 30_000;
    const output = createWriteStream(options.logFile, { flags: "a", mode: 0o600 });
    const stderr = createWriteStream(`${options.logFile}.stderr`, { flags: "a", mode: 0o600 });
    this.child = spawn(options.spec.launch.command, [...options.spec.launch.args, "app-server", "--listen", "stdio://"], {
      cwd: options.spec.cwd,
      env: { ...childEnvironment(), CODEX_HOME: options.spec.codexHome },
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32",
    });
    const fail = (error: Error) => {
      this.exitError ??= error;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(this.exitError); }
      this.pending.clear();
    };
    output.on("error", (error) => { fail(error); void this.kill(); });
    stderr.on("error", (error) => { fail(error); void this.kill(); });
    this.child.stderr.pipe(stderr);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (!output.write(chunk)) { this.child.stdout.pause(); output.once("drain", () => this.child.stdout.resume()); }
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024 && !this.buffer.includes("\n")) { fail(new Error("Codex RPC record exceeds 4 MiB")); void this.kill(); return; }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const record: unknown = JSON.parse(line);
          if (!object(record) || !("id" in record || typeof record.method === "string")) throw new Error("Codex stdout is not a JSON-RPC record");
          this.record(record);
        } catch (error) { fail(error instanceof SyntaxError ? new Error("Codex stdout is not a valid JSON-RPC record") : error as Error); void this.kill(); return; }
      }
    });
    this.child.once("error", fail);
    this.child.stdin.on("error", fail);
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => {
      fail(this.exitError ?? new Error(`Codex app-server exited (${code ?? signal})`));
      output.end(); resolve({ code, signal });
    }));
  }

  private write(record: RecordValue): Promise<void> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => this.child.stdin.write(`${JSON.stringify(record)}\n`, error => error ? reject(error) : resolve()));
  }

  private request(method: string, params: RecordValue = {}): Promise<RecordValue> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; acceptance is uncertain. Inspect the instance before retrying.`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(error => {
        const entry = this.pending.get(id);
        if (entry) { clearTimeout(entry.timer); this.pending.delete(id); entry.reject(error); }
      });
    });
  }

  private record(record: RecordValue): void {
    if (typeof record.method === "string" && "id" in record) {
      // Server-initiated requests can reuse a client ID; method takes precedence over ID.
      void this.serverRequest(record);
      return;
    }
    if ("id" in record) {
      const entry = this.pending.get(record.id);
      if (!entry) return;
      this.pending.delete(record.id); clearTimeout(entry.timer);
      if (object(record.error)) entry.reject(new Error(`Codex RPC: ${String(record.error.message ?? "unknown error")}`));
      else if (object(record.result)) entry.resolve(record.result);
      else entry.reject(new Error("Codex RPC response is missing a result"));
      return;
    }
    const params = object(record.params) ? record.params : {};
    if (record.method === "serverRequest/resolved" && params.threadId === this.thread?.threadId && (typeof params.requestId === "string" || typeof params.requestId === "number")) {
      const approval = this.approvalByRpcId.get(requestKey(params.requestId));
      if (approval) this.clearApproval(approval);
      return;
    }
    if (record.method === "turn/started" && params.threadId === this.thread?.threadId && typeof params.turn?.id === "string") {
      this.activeTurn = params.turn.id;
      this.options.onEvent({ type: "activity", detail: "turn/started" });
    }
    if (params.threadId !== this.thread?.threadId || !this.activeTurn || params.turnId !== this.activeTurn && params.turn?.id !== this.activeTurn) return;
    if (record.method === "item/started" && typeof params.item?.id === "string" && ["commandExecution", "fileChange"].includes(params.item.type)) {
      this.approvalItems.set(params.item.id, params.item);
    }
    if (record.method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      const id = params.itemId;
      this.textByItem.set(id, (this.textByItem.get(id) ?? "") + params.delta);
    } else if (record.method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.id === "string" && typeof params.item.text === "string") {
      this.completedItems.set(params.item.id, params.item.text);
      if (params.item.phase === "final_answer") this.finalAnswerId = params.item.id;
    } else if (record.method === "turn/completed") {
      const turn = params.turn;
      this.lastCompletedTurn = turn.id;
      for (const approval of [...this.approvals.values()]) this.clearApproval(approval, new Error("The Codex turn ended before this approval was confirmed"));
      this.activeTurn = undefined;
      this.turnEnded?.();
      this.completion = this.completion.then(async () => {
        if (this.ending || this.failed) return;
        const ids = new Set([...this.textByItem.keys(), ...this.completedItems.keys()]);
        const text = this.finalAnswerId ? this.completedItems.get(this.finalAnswerId) ?? "" :
          [...ids].map(id => this.completedItems.get(id) ?? this.textByItem.get(id) ?? "").join("\n");
        let result = text;
        if (!result && turn.status === "completed") {
          try {
            const reply = await this.request("thread/read", { threadId: this.thread!.threadId, includeTurns: true });
            if (reply.thread?.id !== this.thread!.threadId) throw new Error("thread/read returned a different thread");
            const saved = reply.thread.turns?.find((item: RecordValue) => item.id === turn.id);
            if (saved?.status !== "completed") throw new Error("Completed turn is absent from native history");
            const messages = (saved.items ?? []).filter((item: RecordValue) => item.type === "agentMessage" && typeof item.text === "string");
            const final = messages.filter((item: RecordValue) => item.phase === "final_answer");
            result = (final.length ? final : messages).map((item: RecordValue) => item.text).join("\n");
          } catch (error) { this.options.onEvent({ type: "settled", status: "failed", text: "", error: `Could not verify Codex's empty completion: ${(error as Error).message}` }); return; }
        }
        if (this.ending || this.failed) return;
        const status = turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "stopped" : "failed";
        this.options.onEvent({ type: "settled", status, text: result, ...(status === "failed" ? { error: String(turn.error?.message ?? `Codex turn status: ${turn.status}`) } : {}) });
      }).catch(error => this.options.onEvent({ type: "settled", status: "failed", text: "", error: (error as Error).message }));
    } else if (record.method === "item/started" || record.method === "item/completed") {
      this.options.onEvent({ type: "activity", detail: record.method });
    }
  }

  private clearApproval(approval: Approval, error?: Error): void {
    if (!this.approvals.delete(approval.id)) return;
    this.approvalByRpcId.delete(requestKey(approval.rpcId));
    this.options.onEvent({ type: "resolved", id: approval.id });
    if (error) approval.rejected?.(error);
    else approval.resolved?.();
  }

  private async serverRequest(record: RecordValue): Promise<void> {
    const rpcId = record.id;
    const command = record.method === "item/commandExecution/requestApproval";
    const file = record.method === "item/fileChange/requestApproval";
    const p = record.params;
    const item = object(p) ? this.approvalItems.get(p.itemId) : undefined;
    const scope = this.activeTurn?.trim() && this.thread && object(p) && p.threadId === this.thread.threadId && p.turnId === this.activeTurn && typeof p.itemId === "string";
    const decisions = object(p) && Array.isArray(p.availableDecisions) ? p.availableDecisions : undefined;
    const unsupportedDecisions = object(p) && p.availableDecisions != null &&
      (!decisions || !decisions.includes("accept") || !(decisions.includes("decline") || decisions.includes("cancel")));
    let details = "";
    if (scope && command && p.additionalPermissions == null && !unsupportedDecisions && (p.kind === undefined || p.kind === "command") && typeof p.command === "string" && p.command.trim() && typeof p.cwd === "string")
      details = `Command: ${p.command}\nDirectory: ${p.cwd}\nReason: ${String(p.reason ?? "Not provided")}`;
    if (scope && file && !p.grantRoot && item?.type === "fileChange" && Array.isArray(item.changes) && item.changes.length &&
      item.changes.every((change: RecordValue) => typeof change.path === "string" && typeof change.diff === "string"))
      details = `File changes:\n${item.changes.map((change: RecordValue) => `${JSON.stringify(change.kind)}: ${change.path}\n${change.diff}`).join("\n")}\nReason: ${String(p.reason ?? "Not provided")}`;
    if (details && scope && command && p.networkApprovalContext) details += `\nNetwork context: ${JSON.stringify(p.networkApprovalContext)}`;
    if (!scope || !(command || file) || !details || details.length > 12_000 || !(typeof rpcId === "string" || Number.isSafeInteger(rpcId)) || this.approvalByRpcId.has(requestKey(rpcId))) {
      await this.write({ id: rpcId, ...(scope && (command || file) && (!command || !object(p) || p.availableDecisions == null || decisions?.includes("decline"))
        ? { result: { decision: "decline" } } : { error: { code: -32601, message: "Unsupported or unscoped interaction" } }) }).catch(() => {});
      this.rejectInteraction(`Codex interaction ${record.method} is not supported or lacks reviewable action details; not approved`);
      return;
    }
    const id = randomUUID();
    const approval: Approval = { id, rpcId, threadId: p.threadId, turnId: p.turnId, attempted: false,
      ...(command && decisions ? { allowed: new Set(decisions.filter((value: unknown) => typeof value === "string")) } : {}) }; 
    this.approvals.set(id, approval); this.approvalByRpcId.set(requestKey(rpcId), approval);
    const cancelOnly = command && decisions && !decisions.includes("decline");
    this.options.onEvent({ type: "question", question: { id, method: cancelOnly ? "select" : "confirm",
      title: command ? "Approve one Codex command?" : "Approve one Codex file change?",
      message: details + (cancelOnly ? "\nThe native server offers no decline-and-continue option. Cancel turn ends this turn without approving the command." : ""),
      ...(cancelOnly ? { options: ["Approve once", "Cancel turn"] } : {}) } });
  }
  private rejectInteraction(error: string): void {
    if (this.failed || this.ending) return;
    this.failed = true;
    this.options.onEvent({ type: "settled", status: "failed", text: "", error, stop: true });
  }

  private checkedSession(thread: RecordValue | undefined): Extract<NativeSession, { cli: "codex" }> {
    const previous = this.options.session;
    if (!thread || typeof thread.id !== "string" || !thread.id || typeof thread.sessionId !== "string" || !thread.sessionId || thread.ephemeral !== false)
      throw new Error("Codex did not provide a persistent thread and session ID");
    if (typeof thread.cwd !== "string" || !thread.cwd || path.resolve(thread.cwd) !== path.resolve(this.options.spec.cwd)) throw new Error("Codex returned a different or missing working directory");
    if (previous && (previous.cli !== "codex" || thread.id !== previous.threadId || thread.sessionId !== previous.sessionId)) throw new Error("Codex returned a different thread or session; refusing to continue");
    return { cli: "codex", threadId: thread.id, sessionId: thread.sessionId, codexHome: this.options.spec.codexHome! };
  }

  /** Metadata-only preflight on a separate process. Never loads/resumes a thread or starts a turn. */
  async inspectSession(): Promise<void> {
    try {
      const previous = this.options.session;
      if (previous?.cli !== "codex") throw new Error("Original Codex session is required for preflight");
      await this.request("initialize", { clientInfo: { name: "pi_cli_subagents", title: "Pi CLI Subagents", version: "0.1.0" } });
      await this.write({ method: "initialized", params: {} });
      const { thread } = await this.request("thread/read", { threadId: previous.threadId, includeTurns: false });
      this.checkedSession(thread);
      if (!["idle", "notLoaded"].includes(thread?.status?.type)) throw new Error("Original Codex thread is not idle or its status is unknown; inspect before syncing");
      if (this.failed || this.exitError) throw new Error("Codex preflight failed; inspect the native event log");
    } finally {
      const result = await this.end();
      if (result.forced || result.exit.code !== 0 || this.failed) throw new Error("Codex preflight did not close cleanly; no synchronization was performed");
    }
  }

  async ready(): Promise<NativeSession> {
    await this.request("initialize", { clientInfo: { name: "pi_cli_subagents", title: "Pi CLI Subagents", version: "0.1.0" } });
    await this.write({ method: "initialized", params: {} });
    const previous = this.options.session;
    const params = { model: this.options.spec.role.model, cwd: this.options.spec.cwd,
      developerInstructions: `# Delegated role: ${this.options.spec.roleName}\n${this.options.spec.role.instructions}` };
    const result = previous ? await this.request("thread/resume", { ...params, threadId: (previous as Extract<NativeSession, { cli: "codex" }>).threadId }) :
      await this.request("thread/start", { ...params, allowProviderModelFallback: false });
    const session = this.checkedSession(result.thread);
    this.thread = session;
    return session;
  }

  async start(message: string): Promise<void> {
    if (!this.thread || this.activeTurn) throw new Error("Codex is not ready for a new turn");
    const result = await this.request("turn/start", { threadId: this.thread.threadId, input: textInput(message), ...(this.options.spec.role.effort ? { effort: this.options.spec.role.effort } : {}) });
    if (typeof result.turn?.id !== "string") throw new Error("Codex did not acknowledge a turn ID");
    if (this.activeTurn && result.turn.id !== this.activeTurn) throw new Error("Codex acknowledged a different active turn");
    // A fast turn may have completed before its start response arrives.
    if (!this.activeTurn && !this.ending && !this.failed && this.lastCompletedTurn !== result.turn.id && result.turn.status === "inProgress") this.activeTurn = result.turn.id;
  }

  async send(message: string, mode: Delivery): Promise<void> {
    if (mode === "followUp") throw new Error("Codex followUp while running is not supported; wait for this run to finish");
    if (!this.thread || !this.activeTurn) throw new Error("Codex has no active turn; inspect the instance before retrying");
    const expectedTurnId = this.activeTurn;
    const result = await this.request("turn/steer", { threadId: this.thread.threadId, expectedTurnId, input: textInput(message) });
    if (result.turnId !== expectedTurnId) throw new Error("Codex acknowledged a different steer target");
  }
  async reply(answer: InteractionReply): Promise<void> {
    const approval = this.approvals.get(answer.id);
    if (!this.activeTurn?.trim() || !approval || approval.attempted || approval.threadId !== this.thread?.threadId || approval.turnId !== this.activeTurn)
      throw new Error("Codex approval is no longer pending or was already answered; inspect before retrying");
    if (Number(answer.cancelled === true) + Number(typeof answer.confirmed === "boolean") + Number(typeof answer.value === "string") !== 1)
      throw new Error("Codex approvals require one explicit decision");
    const cancelOnly = approval.allowed && !approval.allowed.has("decline");
    if (cancelOnly ? answer.confirmed !== undefined || answer.value !== undefined && !["Approve once", "Cancel turn"].includes(answer.value) : answer.value !== undefined)
      throw new Error("Use the explicit choices offered by this Codex request");
    const decision = answer.cancelled || answer.value === "Cancel turn" ? "cancel" : answer.confirmed || answer.value === "Approve once" ? "accept" : "decline";
    if (approval.allowed && !approval.allowed.has(decision)) throw new Error(`Codex decision ${decision} was not offered for this request`);
    approval.attempted = true;
    let timer: NodeJS.Timeout | undefined;
    const resolved = new Promise<void>((resolve, reject) => {
      approval.resolved = resolve; approval.rejected = reject;
      timer = setTimeout(() => reject(new Error("Codex approval resolution timed out; delivery is uncertain. Do not retry this decision.")), this.timeout);
    });
    try {
      await this.write({ id: approval.rpcId, result: { decision } });
      await resolved;
    } finally { if (timer) clearTimeout(timer); }
  }
  async end(): Promise<{ exit: Exit; forced: boolean }> {
    this.ending = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const timer = setTimeout(() => { void this.kill(); }, 5000);
    try { return { exit: await this.closed, forced: this.forced }; }
    finally { clearTimeout(timer); }
  }
  async stop(): Promise<{ exit: Exit; forced: boolean }> {
    if (this.thread && this.activeTurn && !this.exitError) {
      const completed = new Promise<void>(resolve => { this.turnEnded = resolve; });
      try {
        await this.request("turn/interrupt", { threadId: this.thread.threadId, turnId: this.activeTurn });
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([completed, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]); }
        finally { if (timer) clearTimeout(timer); }
      } catch { /* Forced cleanup below still reaps the CLI tree. */ }
      this.turnEnded = undefined;
    }
    return this.end();
  }
  private async kill(): Promise<void> {
    if (this.forced || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return;
    this.forced = true;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      try { await once(killer, "close"); } catch { this.child.kill("SIGKILL"); }
    } else { try { process.kill(-this.child.pid, "SIGKILL"); } catch { this.child.kill("SIGKILL"); } }
  }
}

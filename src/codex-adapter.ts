import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { LogWriter } from "./log-writer.js";
import { terminateProcessTree } from "./process-tree.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterEvent, AdapterOptions, CliAdapter, InteractionReply } from "./cli-adapter.js";
import { childEnvironment, type Exit } from "./pi-process.js";
import { CODEX_MODE_PRESETS } from "./roles.js";
import type { CodexMode, NativeSession, Delivery, QuestionField } from "./types.js";
import { readCodexAsyncQuestionFields, readCodexQuestionFields, validateQuestionAnswers } from "./codex-question.js";
import { readCodexMcpApproval, readCodexMcpElicitation } from "./codex-mcp-approval.js";

// Legacy RPC envelope; a typed decoder migration is separate from the role capability gate.
// pi-lens-ignore: no-unsafe-dictionary-any
type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const textInput = (text: string) => [{ type: "text", text }];
const requestKey = (id: string | number): string => `${typeof id}:${id}`;
/** Human wording for the current step; a step label never uses the raw app-server method name. */
function codexActivity(item: unknown): string {
  if (!object(item)) return "Working";
  if (item.type === "reasoning") return "Thinking";
  if (item.type === "commandExecution") return "Running a command";
  if (item.type === "fileChange") return "Editing files";
  if (item.type === "mcpToolCall") {
    const tool = typeof item.tool === "string" ? item.tool.trim() : "";
    return tool ? `Calling ${tool}` : "Calling a tool";
  }
  if (item.type === "agentMessage") return "Writing a reply";
  if (item.type === "userMessage") return "Reading the task";
  return "Working";
}
// Async message questions have no RPC request ID; their answer is captured-turn text.
type Approval = { id: string; rpcId?: string | number; threadId: string; turnId: string;
  attempted: boolean; allowed?: Set<string>; fields?: QuestionField[];
  mcp?: { questionId?: string; item: RecordValue }; resolved?: () => void; rejected?: (error: Error) => void };

/** One worker owns one app-server process and one thread at a time. */
/** Delegation must not amplify itself: codex keeps its whole collaboration family only when asked. */
export function subagentArgs(role: { allowSubagents?: boolean }): string[] {
  return role.allowSubagents === true ? [] : ["-c", "agents.enabled=false"];
}

export class CodexAdapter implements CliAdapter {
  readonly resident = true;
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<Exit>;
  private pending = new Map<number, { resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly log: LogWriter;

  /** Point the runtime's raw stream at another run's log file; the previous file keeps its bytes. */
  rotateLog(file: string): void { this.log.rotate(file); }
  private nextId = 0;
  private buffer = "";
  private exitError?: Error;
  private forced = false;
  private ending = false;
  private activeTurn?: string;
  private run?: { runId?: string; settled: boolean; done: Promise<void>; resolve: () => void };
  private starting?: Promise<void>;
  private staged?: RecordValue[];
  private closing = false;
  private poisoned?: Error;
  private interrupting?: Promise<void>;
  private thread?: NativeSession & { cli: "codex" };
  private textByItem = new Map<string, string>();
  private completedItems = new Map<string, string>();
  private asyncMessageIds = new Set<string>();
  private finalAnswerId?: string;
  private approvalItems = new Map<string, RecordValue>();
  private approvals = new Map<string, Approval>();
  private approvalByRpcId = new Map<string, Approval>();
  private completion = Promise.resolve();
  private readonly timeout: number;

  get pid(): number | undefined { return this.child.pid; }

  constructor(private readonly options: AdapterOptions) {
    if (options.spec.role.cli !== "codex" || !options.spec.codexHome) throw new Error("Codex requires a pinned native home");
    if (options.session && (options.session.cli !== "codex" || options.session.codexHome !== options.spec.codexHome)) throw new Error("Codex native home or CLI differs from the original session");
    const { defaultModeQuestions } = options.spec.role;
    if (defaultModeQuestions !== undefined && typeof defaultModeQuestions !== "boolean") throw new Error("Codex defaultModeQuestions must be a boolean");
    this.timeout = options.requestTimeout ?? 30_000;
    const questionArgs = [...(defaultModeQuestions === undefined ? [] : ["-c", `features.default_mode_request_user_input=${defaultModeQuestions}`]), ...subagentArgs(options.spec.role)];
    const fail = (error: Error) => this.fail(error);
    this.log = new LogWriter(options.logFile, (error) => { fail(error); void this.kill(); });
    this.child = spawn(options.spec.launch.command, [...options.spec.launch.args, ...questionArgs, "app-server", "--listen", "stdio://"], {
      cwd: options.spec.cwd,
      env: { ...childEnvironment(), CODEX_HOME: options.spec.codexHome },
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32",
    });
    this.child.stderr.pipe(this.log.errorStream);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      const output = this.log.stream;
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
      this.log.end(); resolve({ code, signal });
    }));
  }

  private fail(error: Error): void {
    this.exitError ??= error;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(this.exitError); }
    this.pending.clear();
    for (const approval of [...this.approvals.values()]) {
      try { this.clearApproval(approval, this.exitError); }
      catch { /* A failed event sink must not prevent other waiters or native close from settling. */ }
    }
  }

  private write(record: RecordValue): Promise<void> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => this.child.stdin.write(`${JSON.stringify(record)}\n`, error => error ? reject(error) : resolve()));
  }

  private request(method: string, params: RecordValue = {}): Promise<RecordValue> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = ++this.nextId;
    const run = this.run;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex ${method} timed out; acceptance is uncertain. Inspect the instance before retrying.`);
        reject(method === "turn/steer" ? this.uncertainInput(error, run) : error);
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(error => {
        const entry = this.pending.get(id);
        if (entry) { clearTimeout(entry.timer); this.pending.delete(id); entry.reject(method === "turn/steer" ? this.uncertainInput(error, run) : error); }
      });
    });
  }

  private uncertainInput(error: Error, run = this.run): Error {
    if (this.run !== run) return error;
    this.poisoned ??= new Error(`Codex input delivery is uncertain; stop/release before new work: ${error.message}`);
    this.emit({ type: "uncertain", error: this.poisoned.message }, run);
    return this.poisoned;
  }

  private record(record: RecordValue): void {
    if (typeof record.method === "string" && "id" in record) {
      // Server-initiated requests can reuse a client ID; method takes precedence over ID.
      if (this.staged) { this.staged.push(record); return; }
      const run = this.run;
      void this.serverRequest(record).catch(error => {
        this.poisoned ??= error;
        this.fail(error);
        try { this.emit({ type: "settled", status: "failed", text: "", error: (error as Error).message, stop: true }, run); }
        catch {
          // If even failure publication is broken, close the CLI without claiming release.
          void this.kill().catch(error => console.error("[pi-cli-subagents] Codex release is uncertain:", error));
        }
      });
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
    if (this.staged) { this.staged.push(record); return; }
    const params = object(record.params) ? record.params : {};
    if (record.method === "serverRequest/resolved" && params.threadId === this.thread?.threadId && (typeof params.requestId === "string" || typeof params.requestId === "number")) {
      const approval = this.approvalByRpcId.get(requestKey(params.requestId));
      if (approval) this.clearApproval(approval);
      return;
    }
    if (record.method === "turn/started" && params.threadId === this.thread?.threadId && params.turn?.id === this.activeTurn && this.activeTurn) {
      this.emit({ type: "activity", detail: "Turn started" });
    }
    if (params.threadId !== this.thread?.threadId || !this.activeTurn || params.turnId !== this.activeTurn && params.turn?.id !== this.activeTurn) return;
    if ((record.method === "item/started" || record.method === "item/completed" && params.item?.type === "mcpToolCall") &&
      typeof params.item?.id === "string" && ["commandExecution", "fileChange", "mcpToolCall"].includes(params.item.type)) {
      this.approvalItems.set(params.item.id, params.item);
    }
    if (record.method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      const id = params.itemId;
      this.textByItem.set(id, (this.textByItem.get(id) ?? "") + params.delta);
    } else if (record.method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.id === "string" && typeof params.item.text === "string") {
      const fresh = !this.completedItems.has(params.item.id);
      this.completedItems.set(params.item.id, params.item.text);
      if (params.item.delivery === "async") this.asyncMessageIds.add(params.item.id);
      // Async final_answer messages are mid-turn output, not the terminal answer.
      if (params.item.delivery !== "async" && params.item.phase === "final_answer") this.finalAnswerId = params.item.id;
      const fields = fresh ? readCodexAsyncQuestionFields(params.item) : undefined;
      if (fields && JSON.stringify(fields).length <= 12_000) {
        const id = randomUUID();
        this.approvals.set(id, { id, threadId: params.threadId, turnId: this.activeTurn, fields, attempted: false });
        this.emit({ type: "question", question: { id, method: "form", kind: "question", fields,
          isBlocking: false, humanOnly: false, parentPolicy: { answers: true }, title: "Codex asynchronous task questions",
          message: `Answers are task context sent once via turn/steer to this active turn, not an RPC response or permission grant. The request expires when this turn ends.\n${JSON.stringify(fields, null, 2)}` } });
      }
    } else if (record.method === "turn/completed") {
      const turn = params.turn;
      const run = this.run!;
      for (const approval of [...this.approvals.values()]) this.clearApproval(approval, new Error("The Codex turn ended before this interaction was resolved"));
      this.activeTurn = undefined;
      run.resolve();
      this.completion = this.completion.then(async () => {
        if (this.ending || this.run !== run) return;
        const ids = new Set([...this.textByItem.keys(), ...this.completedItems.keys()]);
        const text = this.finalAnswerId ? this.completedItems.get(this.finalAnswerId) ?? "" :
          [...ids].filter(id => !this.asyncMessageIds.has(id)).map(id => this.completedItems.get(id) ?? this.textByItem.get(id) ?? "").join("\n");
        let result = text;
        if (!result && turn.status === "completed") {
          try {
            const reply = await this.request("thread/read", { threadId: this.thread!.threadId, includeTurns: true });
            if (reply.thread?.id !== this.thread!.threadId) throw new Error("thread/read returned a different thread");
            const saved = reply.thread.turns?.find((item: RecordValue) => item.id === turn.id);
            if (saved?.status !== "completed") throw new Error("Completed turn is absent from native history");
            const messages = (saved.items ?? []).filter((item: RecordValue) => item.type === "agentMessage" && item.delivery !== "async" && typeof item.text === "string");
            const final = messages.filter((item: RecordValue) => item.phase === "final_answer");
            result = (final.length ? final : messages).map((item: RecordValue) => item.text).join("\n");
          } catch (error) { this.emit({ type: "settled", status: "failed", text: "", error: `Could not verify Codex's empty completion: ${(error as Error).message}` }, run); return; }
        }
        if (this.ending || this.run !== run) return;
        const status = turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "stopped" : "failed";
        this.emit({ type: "settled", status, text: result, ...(status === "failed" ? { error: String(turn.error?.message ?? `Codex turn status: ${turn.status}`) } : {}) });
      }).catch(error => this.emit({ type: "settled", status: "failed", text: "", error: (error as Error).message }, run));
    } else if (record.method === "item/started" || record.method === "item/completed") {
      this.emit({ type: "activity", detail: codexActivity(params.item) });
    }
  }

  private emit(event: AdapterEvent, run = this.run): void {
    if (event.type === "settled" && run) {
      if (run.settled) return;
      run.settled = true;
    }
    this.options.onEvent({ ...event, ...(run?.runId === undefined ? {} : { runId: run.runId }) });
  }

  private clearApproval(approval: Approval, error?: Error): void {
    if (!this.approvals.delete(approval.id)) return;
    if (approval.rpcId !== undefined) this.approvalByRpcId.delete(requestKey(approval.rpcId));
    try { this.emit({ type: "resolved", id: approval.id }); }
    finally {
      if (error) approval.rejected?.(error);
      else approval.resolved?.();
    }
  }

  private async serverRequest(record: RecordValue): Promise<void> {
    const rpcId = record.id;
    const command = record.method === "item/commandExecution/requestApproval";
    const file = record.method === "item/fileChange/requestApproval";
    const p = record.params;
    const item = object(p) ? this.approvalItems.get(p.itemId) : undefined;
    const turnScope = this.activeTurn?.trim() && this.thread && object(p) && p.threadId === this.thread.threadId && p.turnId === this.activeTurn;
    const scope = turnScope && typeof p.itemId === "string";
    const openRequest = !this.ending && (typeof rpcId === "string" || Number.isSafeInteger(rpcId)) && !this.approvalByRpcId.has(requestKey(rpcId));
    // Form elicitation has no itemId. Only one live call on the named server may match;
    // never pick the first/last call when concurrent calls make attribution ambiguous.
    if (record.method === "mcpServer/elicitation/request" && turnScope && openRequest) {
      const candidates = [...this.approvalItems.values()].filter(candidate => candidate.type === "mcpToolCall" &&
        candidate.status === "inProgress" && candidate.server === p.serverName);
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      const elicitation = readCodexMcpElicitation(p, candidate);
      if (elicitation && candidate) {
        const id = randomUUID();
        const pending: Approval = { id, rpcId, threadId: p.threadId, turnId: p.turnId, attempted: false, mcp: { item: candidate } };
        this.approvals.set(id, pending); this.approvalByRpcId.set(requestKey(rpcId), pending);
        this.emit({ type: "question", question: { id, method: "confirm", title: "Approve one Codex MCP tool call?",
          message: elicitation.message, parentPolicy: { confirm: true } } });
        return;
      }
    }
    const question = record.method === "item/tool/requestUserInput" || record.method === "tool/requestUserInput";
    if (question && scope && p.itemId.trim() && typeof p.isBlocking === "boolean" && openRequest) {
      // Native MCP approval is an action, never an agent-answerable task form.
      const mcp = p.isBlocking ? readCodexMcpApproval(p.questions, item) : undefined;
      if (mcp && item) {
        const id = randomUUID();
        const pending: Approval = { id, rpcId, threadId: p.threadId, turnId: p.turnId, attempted: false,
          mcp: { questionId: mcp.questionId, item } };
        this.approvals.set(id, pending); this.approvalByRpcId.set(requestKey(rpcId), pending);
        this.emit({ type: "question", question: { id, method: "select", title: "Approve one Codex MCP tool call?",
          message: mcp.message, options: ["Allow", "Cancel"], parentPolicy: { values: ["Allow", "Cancel"] } } });
        return;
      }
      // Unknown action-owned input and reserved MCP IDs stay out of task questions.
      const fields = !item ? readCodexQuestionFields(p.questions) : undefined;
      if (fields && JSON.stringify(fields).length <= 12_000) {
        const id = randomUUID();
        const pending: Approval = { id, rpcId, threadId: p.threadId, turnId: p.turnId, attempted: false, fields };
        this.approvals.set(id, pending); this.approvalByRpcId.set(requestKey(rpcId), pending);
        this.emit({ type: "question", question: { id, method: "form", kind: "question", fields,
          isBlocking: p.isBlocking, humanOnly: false, parentPolicy: { answers: true }, title: "Codex task questions",
          message: `${p.isBlocking ? "The current turn is waiting for these answers." : "Non-blocking: the current turn may continue."}\n${JSON.stringify(fields, null, 2)}` } });
        return;
      }
    }
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
      // Refuse this request alone with a protocol-valid answer and keep the turn: Lody cancels per
      // request and a Paseo deny leaves the turn running (port plan §8.4). Transport faults stay fatal.
      const addressable = typeof rpcId === "string" || Number.isSafeInteger(rpcId);
      const duplicate = addressable && this.approvalByRpcId.has(requestKey(rpcId));
      if (addressable && !duplicate) await this.write({ id: rpcId, ...this.refusal(record.method, decisions) }).catch(() => {});
      this.emit({ type: "activity", detail: `interaction refused: ${String(record.method)}${duplicate ? " (duplicate request id ignored)" : ""}` });
      return;
    }
    const id = randomUUID();
    const approval: Approval = { id, rpcId, threadId: p.threadId, turnId: p.turnId, attempted: false,
      ...(command && decisions ? { allowed: new Set(decisions.filter((value: unknown) => typeof value === "string")) } : {}) }; 
    this.approvals.set(id, approval); this.approvalByRpcId.set(requestKey(rpcId), approval);
    const cancelOnly = command && decisions && !decisions.includes("decline");
    this.emit({ type: "question", question: { id, method: cancelOnly ? "select" : "confirm",
      title: command ? "Approve one Codex command?" : "Approve one Codex file change?",
      message: details + (cancelOnly ? "\nThe native server offers no decline-and-continue option. Cancel turn ends this turn without approving the command." : ""),
      // Codex offers a one-time accept, a decline and a cancel; its session-wide decision is never sent.
      ...(cancelOnly ? { options: ["Approve once", "Cancel turn"], parentPolicy: { values: ["Approve once", "Cancel turn"] } } : { parentPolicy: { confirm: true } }) } });
  }
  /** Protocol-valid refusal for a server request this adapter will not present. It never grants anything. */
  private refusal(method: unknown, decisions: unknown[] | undefined): RecordValue {
    const decline = !decisions || decisions.includes("decline");
    switch (method) {
      case "item/commandExecution/requestApproval": case "item/fileChange/requestApproval":
        return { result: { decision: decline ? "decline" : "cancel" } };
      case "item/permissions/requestApproval":
        return { result: { permissions: {}, scope: "turn", strictAutoReview: false } };
      case "item/tool/requestUserInput": case "tool/requestUserInput":
        return { result: { answers: {} } };
      case "mcpServer/elicitation/request":
        return { result: { action: "cancel", content: null, _meta: null } };
      default:
        return { error: { code: -32601, message: `Unsupported server request: ${String(method)}` } };
    }
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
      if (this.exitError) throw new Error("Codex preflight failed; inspect the native event log");
    } finally {
      const result = await this.end();
      if (result.forced || result.exit.code !== 0) throw new Error("Codex preflight did not close cleanly; no synchronization was performed");
    }
  }

  async ready(): Promise<NativeSession> {
    await this.request("initialize", { clientInfo: { name: "pi_cli_subagents", title: "Pi CLI Subagents", version: "0.1.0" } });
    await this.write({ method: "initialized", params: {} });
    const previous = this.options.session;
    const preset = this.options.spec.role.mode ? CODEX_MODE_PRESETS[this.options.spec.role.mode as CodexMode] : undefined;
    // An omitted role model inherits the native config.toml model; only an explicit choice is pinned without fallback.
    const model = this.options.spec.role.model?.trim();
    const params = { ...(model ? { model } : {}), cwd: this.options.spec.cwd,
      developerInstructions: `# Delegated role: ${this.options.spec.roleName}\n${this.options.spec.role.instructions}`,
      ...(preset ?? {}) };
    const result = previous ? await this.request("thread/resume", { ...params, threadId: (previous as Extract<NativeSession, { cli: "codex" }>).threadId }) :
      await this.request("thread/start", { ...params, ...(model ? { allowProviderModelFallback: false } : {}) });
    const session = this.checkedSession(result.thread);
    this.thread = session;
    return session;
  }

  async start(message: string, runId?: string): Promise<void> {
    if (this.poisoned) throw this.poisoned;
    if (!this.thread || this.activeTurn || this.starting || this.closing || this.ending || this.interrupting || this.run && !this.run.settled)
      throw new Error("Codex is not ready for a new turn (active, closing or interrupt pending)");
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    this.run = { runId, settled: false, done, resolve };
    this.textByItem.clear(); this.completedItems.clear(); this.asyncMessageIds.clear(); this.finalAnswerId = undefined;
    this.approvalItems.clear(); this.approvals.clear(); this.approvalByRpcId.clear();
    this.staged = [];
    this.starting = (async () => {
      const result = await this.request("turn/start", { threadId: this.thread!.threadId, input: textInput(message), ...(this.options.spec.role.effort ? { effort: this.options.spec.role.effort } : {}) });
      if (typeof result.turn?.id !== "string" || !result.turn.id.trim()) throw new Error("Codex did not acknowledge a turn ID");
      this.activeTurn = result.turn.id;
      // Events can beat acceptance. Replay only after the response binds the exact
      // turn; a stale turn/started must never switch our foreground identity.
      const staged = this.staged!; this.staged = undefined;
      for (const record of staged) this.record(record);
    })();
    try { await this.starting; }
    catch (error) { this.poisoned = new Error(`Codex start is uncertain; stop/release before new work: ${(error as Error).message}`); throw this.poisoned; }
    finally { this.starting = undefined; this.staged = undefined; }
  }

  async send(message: string, mode: Delivery): Promise<void> {
    if (this.poisoned) throw this.poisoned;
    if (this.interrupting || this.closing || this.ending) throw new Error("Codex interrupt or shutdown pending; cannot send");
    if (mode === "followUp") throw new Error("Codex followUp while running is not supported; wait for this run to finish");
    if (!this.thread || !this.activeTurn) throw new Error("Codex has no active turn; inspect the instance before retrying");
    const expectedTurnId = this.activeTurn;
    const run = this.run;
    const result = await this.request("turn/steer", { threadId: this.thread.threadId, expectedTurnId, input: textInput(message) });
    if (result.turnId !== expectedTurnId) throw this.uncertainInput(new Error("Codex acknowledged a different steer target"), run);
  }
  async reply(answer: InteractionReply): Promise<void> {
    const approval = this.approvals.get(answer.id);
    if (this.poisoned || this.interrupting || this.closing || !this.activeTurn?.trim() || !approval || approval.attempted || approval.threadId !== this.thread?.threadId || approval.turnId !== this.activeTurn)
      throw new Error("Codex approval is no longer pending or was already answered; inspect before retrying");
    let result: RecordValue;
    if (approval.mcp) {
      if (this.approvalItems.get(approval.mcp.item.id) !== approval.mcp.item || approval.mcp.item.status !== "inProgress")
        throw new Error("Codex MCP action is no longer pending or its details changed; inspect before replying");
      if (approval.mcp.questionId !== undefined) {
        if (answer.answers !== undefined || answer.confirmed !== undefined ||
          Number(answer.cancelled === true) + Number(typeof answer.value === "string") !== 1 ||
          answer.value !== undefined && !["Allow", "Cancel"].includes(answer.value))
          throw new Error("Codex MCP approvals require an explicit Allow/Cancel choice or cancellation; persistent grants are not supported");
        result = { answers: { [approval.mcp.questionId]: { answers: [answer.cancelled ? "Cancel" : answer.value] } } };
      } else {
        if (answer.answers !== undefined || answer.value !== undefined ||
          Number(answer.cancelled === true) + Number(typeof answer.confirmed === "boolean") !== 1)
          throw new Error("Codex MCP elicitation requires one confirmed decision or cancellation, not form content");
        result = { action: answer.cancelled ? "cancel" : answer.confirmed ? "accept" : "decline", content: null, _meta: null };
      }
    } else if (approval.fields) {
      if (Number(answer.cancelled === true) + Number(answer.answers !== undefined) !== 1 || answer.confirmed !== undefined || answer.value !== undefined)
        throw new Error("Codex task forms require answers or cancellation, not an approval");
      const answers = answer.cancelled ? {} : validateQuestionAnswers(approval.fields, answer.answers);
      if (approval.rpcId === undefined) {
        // Paseo's async-question reply (29db2b798..., Apache-2.0), adapted to
        // active-run scope: never start an idle follow-up or retry uncertain steering.
        approval.attempted = true;
        if (!answer.cancelled) {
          const text = "Answers to your questions:\n\n" + approval.fields.map(field => `${field.question}\n${answers[field.id][0]}`).join("\n\n");
          await this.send(text, "steer");
        }
        this.clearApproval(approval);
        return;
      }
      result = { answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }])) };
    } else {
      if (answer.answers !== undefined || Number(answer.cancelled === true) + Number(typeof answer.confirmed === "boolean") + Number(typeof answer.value === "string") !== 1)
        throw new Error("Codex approvals require one explicit decision");
      const cancelOnly = approval.allowed && !approval.allowed.has("decline");
      if (cancelOnly ? answer.confirmed !== undefined || answer.value !== undefined && !["Approve once", "Cancel turn"].includes(answer.value) : answer.value !== undefined)
        throw new Error("Use the explicit choices offered by this Codex request");
      const decision = answer.cancelled || answer.value === "Cancel turn" ? "cancel" : answer.confirmed || answer.value === "Approve once" ? "accept" : "decline";
      if (approval.allowed && !approval.allowed.has(decision)) throw new Error(`Codex decision ${decision} was not offered for this request`);
      result = { decision };
    }
    approval.attempted = true;
    let timer: NodeJS.Timeout | undefined;
    const resolved = new Promise<void>((resolve, reject) => {
      approval.resolved = resolve; approval.rejected = reject;
      timer = setTimeout(() => reject(new Error("Codex interaction resolution timed out; delivery is uncertain. Do not retry this response.")), this.timeout);
    });
    // Resolution can fail while write is still pending, or write can fail before its await.
    // Observe immediately; awaiting the original promise below still propagates the failure.
    void resolved.catch(() => {});
    try {
      await this.write({ id: approval.rpcId, result });
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
  interrupt(): Promise<void> {
    if (this.poisoned) return Promise.reject(this.poisoned);
    if (this.interrupting) return this.interrupting;
    const run = this.run, starting = this.starting;
    if (!run || run.settled && !this.activeTurn) return Promise.resolve();
    let timer: NodeJS.Timeout;
    const operation = (async () => {
      await starting;
      if (this.run !== run) throw new Error("Codex interrupt target changed; runtime is uncertain");
      const turnId = this.activeTurn;
      if (turnId) await this.request("turn/interrupt", { threadId: this.thread!.threadId, turnId });
      // A native response only acknowledges the command, not completion.
      await run.done;
      await this.completion;
    })();
    this.interrupting = Promise.race([operation, this.closed.then(() => {}), new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Codex interrupt timed out; runtime is uncertain. Stop/release before new work.")), this.timeout);
    })]).catch(error => { this.poisoned = error; throw error; }).finally(() => {
      clearTimeout(timer); this.interrupting = undefined;
    });
    return this.interrupting;
  }
  async stop(): Promise<{ exit: Exit; forced: boolean }> {
    this.closing = true;
    const deadline = setTimeout(() => { void this.kill(); }, 5000);
    try {
      try { await this.interrupt(); } catch { /* Only resource release recovers uncertainty. */ }
      return await this.end();
    } finally { clearTimeout(deadline); }
  }
  private async kill(): Promise<void> {
    await terminateProcessTree(this.child, () => { this.forced = true; });
  }
}

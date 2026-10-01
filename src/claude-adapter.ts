import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, readdirSync, lstatSync, fstatSync, openSync, readSync, closeSync } from "node:fs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AdapterOptions, CliAdapter, InteractionReply } from "./cli-adapter.js";
import { childEnvironment, type Exit } from "./pi-process.js";
import type { AgentSpec, NativeSession, Delivery } from "./types.js";

type Json = Record<string, any>;
const object = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
type ClaudeSession = Extract<NativeSession, { cli: "claude" }>;

/** Bounded, read-only identity check. This does not assert that an external Claude process is idle. */
export function inspectClaudeSession(spec: AgentSpec, session: ClaudeSession): string {
  if (!spec.claudeHome || session.claudeHome !== spec.claudeHome || !uuid.test(session.sessionId)) throw new Error("Claude native home or session identity changed");
  const root = path.join(spec.claudeHome, "projects");
  const files: string[] = [];
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const file = path.join(root, dir.name, `${session.sessionId}.jsonl`);
      try { if (lstatSync(file).isFile()) files.push(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (files.length !== 1) throw new Error(`Original Claude session is ${files.length ? "ambiguous" : "missing"}; will not create a replacement`);
  const fd = openSync(files[0], "r");
  let identified = false;
  try {
    const size = fstatSync(fd).size;
    for (const offset of size > 65_536 ? [0, Math.max(65_536, size - 65_536)] : [0]) {
      const buffer = Buffer.alloc(Math.min(65_536, size - offset));
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      let text = buffer.subarray(0, count).toString("utf8");
      if (offset) text = text.slice(text.indexOf("\n") + 1);
      if (offset + count < size) text = text.slice(0, text.lastIndexOf("\n") + 1);
      for (const line of text.split("\n").filter(line => line.trim())) {
        const row: unknown = JSON.parse(line);
        if (!object(row)) throw new Error("Malformed Claude session metadata");
        if (row.sessionId !== undefined && row.sessionId !== session.sessionId) throw new Error("Claude session identity mismatch");
        if (row.cwd !== undefined && (typeof row.cwd !== "string" || !row.cwd.trim() || path.resolve(row.cwd) !== path.resolve(spec.cwd))) throw new Error("Original Claude working directory differs");
        if (row.sessionId === session.sessionId && row.cwd && row.isSidechain !== true && ["user", "assistant"].includes(row.type)) identified = true;
      }
    }
  } finally { closeSync(fd); }
  if (!identified) throw new Error("Original Claude session lacks verifiable identity and cwd metadata");
  return files[0];
}

type Approval = { id: string; requestId: string; toolId: string; input: Json; messageId: string; humanOnly: boolean; attempted: boolean };
/** Native stream-json stays inside this adapter; the worker retains ownership and audit. */
export class ClaudeAdapter implements CliAdapter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<Exit>;
  private readonly session: ClaudeSession;
  private readonly timeout: number;
  private pending = new Map<string, { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private gates = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private observed = new Set<string>();
  private buffer = "";
  private error?: Error;
  private forced = false;
  private ending = false;
  private settled = false;
  private initialized = false;
  private activeMessage?: string;
  private result?: Json;
  private tools = new Map<string, string>();
  private approvals = new Map<string, Approval>();
  private seenRequests = new Set<string>();
  private background = new Set<string>();
  private capabilities = new Set<string>();
  get pid(): number | undefined { return this.child.pid; }

  constructor(private readonly options: AdapterOptions) {
    const { spec, session } = options;
    if (spec.role.cli !== "claude" || !spec.claudeHome) throw new Error("Claude requires a pinned native home");
    if (session && (session.cli !== "claude" || session.claudeHome !== spec.claudeHome)) throw new Error("Claude native home or CLI differs from original session");
    this.session = session?.cli === "claude" ? session : { cli: "claude", sessionId: randomUUID(), claudeHome: spec.claudeHome };
    if (session) inspectClaudeSession(spec, this.session);
    this.timeout = options.requestTimeout ?? 30_000;
    const output = createWriteStream(options.logFile, { flags: "a", mode: 0o600 });
    const stderr = createWriteStream(`${options.logFile}.stderr`, { flags: "a", mode: 0o600 });
    const env = { ...childEnvironment(), CLAUDE_CONFIG_DIR: spec.claudeHome };
    // A delegated run submits its own task; never auto-rerun an interrupted task during resume.
    delete (env as NodeJS.ProcessEnv).CLAUDE_CODE_RESUME_INTERRUPTED_TURN;
    this.child = spawn(spec.launch.command, [...spec.launch.args, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--replay-user-messages", "--permission-prompt-tool", "stdio", "--await-initialize",
      session ? "--resume" : "--session-id", this.session.sessionId, ...(spec.role.model ? ["--model", spec.role.model] : [])], {
      cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32",
    });
    output.on("error", error => this.fail(error)); stderr.on("error", error => this.fail(error));
    this.child.stderr.pipe(stderr);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      if (!output.write(chunk)) { this.child.stdout.pause(); output.once("drain", () => this.child.stdout.resume()); }
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("Claude record exceeds 4 MiB");
          const record: unknown = JSON.parse(line);
          if (!object(record) || typeof record.type !== "string") throw new Error("Invalid Claude stream-json record");
          this.record(record);
        } catch (error) { this.fail(error instanceof SyntaxError ? new Error("Claude stdout is not valid JSON") : error as Error); return; }
      }
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) this.fail(new Error("Claude record exceeds 4 MiB"));
    });
    this.child.once("error", error => this.fail(error)); this.child.stdin.on("error", error => this.fail(error));
    this.closed = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.rejectPending(this.error ?? new Error(`Claude exited (${code ?? signal})`));
      output.end(); resolve({ code, signal });
    }));
  }
  private rejectPending(error: Error): void {
    this.error ??= error;
    for (const map of [this.pending, this.gates]) { for (const p of map.values()) { clearTimeout(p.timer); p.reject(error); } map.clear(); }
  }
  private fail(error: Error): void {
    this.rejectPending(error);
    if (!this.settled && !this.ending) {
      this.settled = true; this.clearApprovals();
      this.options.onEvent({ type: "settled", status: "failed", text: "", error: error.message, stop: true });
    }
    void this.kill();
  }
  private write(record: Json): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.child.stdin.write(`${JSON.stringify(record)}\n`, error => error ? reject(error) : resolve()));
  }
  private request(request: Json): Promise<Json> {
    if (this.error) return Promise.reject(this.error);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Claude ${request.subtype} timed out; acceptance is uncertain. Do not retry blindly.`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ type: "control_request", request_id: id, request }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
    });
  }
  private mark(name: string): void {
    this.observed.add(name); const gate = this.gates.get(name);
    if (gate) { clearTimeout(gate.timer); this.gates.delete(name); gate.resolve(); }
  }
  private wait(name: string): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (this.observed.has(name)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.gates.delete(name); reject(new Error(`Claude ${name} timed out; inspect the original session before retrying`)); }, this.timeout);
      this.gates.set(name, { resolve, reject, timer });
    });
  }
  private clearApprovals(): void { for (const a of this.approvals.values()) this.options.onEvent({ type: "resolved", id: a.id }); this.approvals.clear(); }
  private record(record: Json): void {
    if (this.error || this.ending) return;
    if (record.type === "control_response") {
      const response = record.response, p = this.pending.get(response?.request_id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(response.request_id);
      if (response.subtype !== "success" || !object(response.response)) p.reject(new Error(`Claude control failed: ${String(response.error ?? "missing response")}`));
      else if (response.pending_permission_requests?.length || response.pending_user_dialog_requests?.length) p.reject(new Error("Claude resumed pending interactions; inspect the original session manually"));
      else p.resolve(response.response);
      return;
    }
    if (record.type === "control_request") { this.permission(record); return; }
    if (record.type === "control_cancel_request") {
      for (const a of this.approvals.values()) if (a.requestId === record.request_id) { this.approvals.delete(a.id); this.options.onEvent({ type: "resolved", id: a.id }); }
      return;
    }
    if (record.parent_tool_use_id != null) return;
    if (record.session_id !== undefined && record.session_id !== this.session.sessionId) throw new Error("Claude returned a different native session identity");
    if (record.type === "system" && record.subtype === "init") {
      if (record.session_id !== this.session.sessionId || typeof record.cwd !== "string" || path.resolve(record.cwd) !== path.resolve(this.options.spec.cwd)) throw new Error("Claude init has a different session or working directory");
      this.initialized = true; this.capabilities = new Set(Array.isArray(record.capabilities) ? record.capabilities : []); this.mark("init");
    }
    if (record.type === "system" && record.subtype === "task_started" && record.is_backgrounded !== false && !record.ambient && !record.skip_transcript && typeof record.task_id === "string") this.background.add(record.task_id);
    if (record.type === "system" && record.subtype === "task_updated" && record.patch?.is_backgrounded === true && typeof record.task_id === "string") this.background.add(record.task_id);
    if (record.type === "system" && (record.subtype === "task_notification" || record.subtype === "task_updated" && ["completed", "failed", "killed"].includes(record.patch?.status))) { this.background.delete(record.task_id); this.maybeSettle(); }
    if (record.type === "assistant" && Array.isArray(record.message?.content)) {
      for (const part of record.message.content) if (part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") this.tools.set(part.id, part.name);
    }
    if (record.type === "stream_event" && record.event?.type === "content_block_start") {
      const part = record.event.content_block;
      if (part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") this.tools.set(part.id, part.name);
    }
    if (record.type === "result") {
      const ids = Array.isArray(record.user_message_uuids) ? record.user_message_uuids : [record.user_message_uuid];
      if (!this.initialized && (record.is_error === true || record.subtype !== "success")) throw new Error(`Claude startup failed: ${String(record.result ?? record.errors?.join("\n") ?? "unknown failure")}`);
      if (record.session_id !== this.session.sessionId || !this.activeMessage || !ids.includes(this.activeMessage)) return;
      this.clearApprovals(); this.result = record; this.maybeSettle();
    }
    if (!this.settled && this.activeMessage && ["assistant", "stream_event", "tool_progress", "user"].includes(record.type)) this.options.onEvent({ type: "activity", detail: record.type });
  }
  private maybeSettle(): void {
    // Local stream-json may omit session_state_changed entirely. The matching result is
    // the turn-complete signal; retain the explicit queue and background-work barriers.
    if (!this.result || this.background.size || this.settled || this.ending) return;
    const r = this.result;
    if (!Number.isSafeInteger(r.queued_turn_count) || r.queued_turn_count < 0) throw new Error("Claude result lacks a verifiable queue boundary");
    if (r.queued_turn_count) return;
    const stopped = ["aborted_tools", "aborted_streaming"].includes(r.terminal_reason);
    const failed = r.subtype !== "success" || r.is_error !== false || r.terminal_reason && !["completed", "aborted_tools", "aborted_streaming"].includes(r.terminal_reason);
    this.settled = true; this.activeMessage = undefined; this.clearApprovals(); this.mark("terminal");
    this.options.onEvent({ type: "settled", status: stopped ? "stopped" : failed ? "failed" : "completed", text: typeof r.result === "string" ? r.result : "",
      ...(failed && !stopped ? { error: String(r.errors?.join("\n") || r.result || `Claude terminal reason: ${r.terminal_reason}`) } : {}) });
  }
  private permission(record: Json): void {
    const p = record.request, requestId = record.request_id;
    const scoped = this.initialized && this.activeMessage && !this.result && !this.settled && object(p) && p.subtype === "can_use_tool" &&
      typeof requestId === "string" && requestId.trim() && !this.seenRequests.has(requestId) && !p.agent_id &&
      typeof p.tool_use_id === "string" && p.tool_use_id.trim() && typeof p.tool_name === "string" && p.tool_name.trim() &&
      this.tools.has(p.tool_use_id) && this.tools.get(p.tool_use_id) === p.tool_name && object(p.input);
    const details = object(p) ? JSON.stringify({ tool: p.tool_name, input: p.input, reason: p.decision_reason, matchedAskRule: p.matched_ask_rule }, null, 2)
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16)}`) : "";
    if (!scoped || p.requires_user_interaction !== undefined && p.requires_user_interaction !== false ||
      p.classifier_approvable !== undefined && typeof p.classifier_approvable !== "boolean" || details.length > 12_000) {
      // No allow response, including for dialogs whose consent disclosure is not carried by this wire.
      void this.write({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "Unsupported or unscoped interaction; open the original Claude session to inspect" } }).catch(() => {});
      this.fail(new Error("Claude interaction is unsupported, unscoped or requires a dedicated user dialog; not approved")); return;
    }
    this.seenRequests.add(requestId);
    const humanOnly = p.classifier_approvable === false || p.decision_reason_type === "rule" || p.matched_ask_rule != null;
    const approval: Approval = { id: randomUUID(), requestId, toolId: p.tool_use_id, input: structuredClone(p.input), messageId: this.activeMessage!, humanOnly, attempted: false };
    this.approvals.set(approval.id, approval);
    this.options.onEvent({ type: "question", question: { id: approval.id, method: "select", title: "Approve one Claude tool call?",
      message: `${humanOnly ? "Human approval required; the parent may only deny or cancel.\n" : ""}${details}`, options: ["Deny once", "Approve once", "Cancel turn"], ...(humanOnly ? { humanOnly: true } : {}) } });
  }
  async ready(): Promise<NativeSession> {
    const result = await this.request({ subtype: "initialize", appendSystemPrompt: `# Delegated role: ${this.options.spec.roleName}\n${this.options.spec.role.instructions}`,
      title: `Delegated ${this.options.spec.roleName}`, supportedDialogKinds: [], promptSuggestions: false, agentProgressSummaries: false });
    if (result.session_state !== "idle") throw new Error("Claude startup state is not idle; inspect the original session");
    const version = await this.request({ subtype: "get_binary_version" });
    if (!/^2\.1\.(\d+)$/.test(version.version) || Number(version.version.split(".")[2]) < 283) throw new Error("Claude Code 2.1.283 or newer 2.1.x is required");
    const permissions = await this.request({ subtype: "list_permission_rules" });
    if (typeof permissions.state?.originalCwd !== "string" || path.resolve(permissions.state.originalCwd) !== path.resolve(this.options.spec.cwd)) throw new Error("Claude returned a different working directory");
    if (permissions.state.errors?.length) throw new Error("Claude skipped invalid permission settings; refusing to run");
    // commands_changed/other pre-prompt identity notifications are optional, including on resume.
    // This is the requested native target, not task acceptance: start() must verify system/init.
    this.mark("ready");
    return this.session;
  }
  async start(message: string): Promise<void> {
    if (!this.observed.has("ready") || this.activeMessage || this.settled) throw new Error("Claude is not ready for a new task");
    this.activeMessage = randomUUID();
    await this.write({ type: "user", uuid: this.activeMessage, session_id: this.session.sessionId, parent_tool_use_id: null, message: { role: "user", content: message } });
    await this.wait("init");
  }
  async send(_message: string, mode: Delivery): Promise<void> {
    throw new Error(`Claude ${mode} while running is not supported; wait for this run to finish and continue the same instance`);
  }
  async reply(answer: InteractionReply): Promise<void> {
    const a = this.approvals.get(answer.id);
    if (!a || a.attempted || !this.activeMessage || a.messageId !== this.activeMessage || this.result || this.settled || this.ending) throw new Error("Claude approval is no longer pending or was already answered");
    if (Number(answer.cancelled === true) + Number(typeof answer.value === "string") !== 1 || answer.confirmed !== undefined || answer.value !== undefined && !["Deny once", "Approve once", "Cancel turn"].includes(answer.value)) throw new Error("Claude requires one of the explicit choices offered");
    const allow = answer.value === "Approve once";
    if (allow && a.humanOnly && answer.actor !== "human") throw new Error("This Claude request requires human approval");
    a.attempted = true;
    await this.write({ type: "control_response", response: { subtype: "success", request_id: a.requestId,
      response: allow ? { behavior: "allow", updatedInput: a.input, toolUseID: a.toolId } : { behavior: "deny", message: "Denied by delegated-task controller", interrupt: answer.cancelled === true || answer.value === "Cancel turn", toolUseID: a.toolId } } });
    // Native stdio has no approval receipt. A successful write is not proof of tool execution.
    if (this.approvals.delete(a.id)) this.options.onEvent({ type: "resolved", id: a.id });
  }
  async end(): Promise<{ exit: Exit; forced: boolean }> {
    this.ending = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const timer = setTimeout(() => { void this.kill(); }, 5000);
    try { return { exit: await this.closed, forced: this.forced }; } finally { clearTimeout(timer); }
  }
  async stop(): Promise<{ exit: Exit; forced: boolean }> {
    if (this.activeMessage && !this.error && !this.ending) {
      // One stop budget, not two sequential request/event timeouts beyond the parent's deadline.
      const timer = setTimeout(() => { void this.kill(); }, 5000);
      try {
        await this.request({ subtype: "interrupt", ...(this.capabilities.has("interrupt_cancel_queued_v1") ? { cancel_queued: true } : {}) });
        await this.wait("terminal");
      } catch { await this.kill(); }
      finally { clearTimeout(timer); }
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

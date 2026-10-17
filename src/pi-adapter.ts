import path from "node:path";
import { mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { PiProcess, type WireRecord, type Exit } from "./pi-process.js";
import { ASK_PARENT_TOOL, parentQuestionDialog, readParentQuestion, type ParentQuestion } from "./pi-question.js";
import type { AdapterEvent, AdapterOptions, CliAdapter, InteractionReply } from "./cli-adapter.js";
import type { Delivery, NativeSession, Question, SessionHandle, RoleToolTrim } from "./types.js";

/** Human wording for the current step; a step label never uses the raw Pi event type. */
function piActivity(type: string, toolName: unknown): string {
  const tool = typeof toolName === "string" && toolName.trim() ? toolName : undefined;
  if (type === "agent_start") return "Starting";
  if (type === "tool_execution_start") return tool ? `Using ${tool}` : "Using a tool";
  if (type === "tool_execution_end") return tool ? `Finished ${tool}` : "Finished a tool";
  return "Working";
}

/** Read only the original header: opening a SessionManager can migrate or repair the file. */
export async function inspectPiSession(session: SessionHandle): Promise<void> {
  const file = await open(session.sessionFile, "r");
  try {
    // Match Pi's bounded header discovery, not an unbounded transcript scan.
    const limit = 1024 * 1024, buffer = Buffer.alloc(4096), decoder = new StringDecoder("utf8");
    let scanned = 0, pending = "";
    while (scanned <= limit) {
      // One extra byte distinguishes EOF at the limit from a truncated header.
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, limit - scanned + 1), null);
      scanned += bytesRead;
      if (scanned > limit) throw new Error(`Pi session header exceeds ${limit}-byte scan limit`);
      pending += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end();
      const lines = pending.split("\n");
      pending = bytesRead ? lines.pop() ?? "" : "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let header: { type?: unknown; id?: unknown } | null;
        try { header = JSON.parse(line); } catch { continue; }
        // Pi skips malformed and falsy entries, but the first parsed entry must be a header.
        if (!header) continue;
        if (header.type !== "session" || typeof header.id !== "string") throw new Error("Invalid original Pi session header");
        if (header.id !== session.sessionId) throw new Error("Original Pi session file belongs to a different session; refusing to synchronize");
        return;
      }
      if (!bytesRead) break;
    }
    throw new Error("No valid original Pi session header");
  } finally { await file.close(); }
}

/** Pi's native trimming flags. Validation already refused this field for Codex and Claude roles. */
export function trimArgs(role: { tools?: RoleToolTrim; skills?: boolean; mcp?: boolean }): string[] {
  const args: string[] = [];
  if (role.tools?.allow?.length) args.push("--tools", role.tools.allow.join(","));
  if (role.tools?.deny?.length) args.push("--exclude-tools", role.tools.deny.join(","));
  if (role.skills === false) args.push("--no-skills");
  if (role.mcp === false) args.push("--no-mcp");
  return args;
}

export class PiAdapter implements CliAdapter {
  readonly resident = true;
  private active = false;
  private runId?: string;
  // null = independent session UI; undefined = a legacy run without a supplied runId.
  private questions?: Map<string, string | undefined | null>;
  readonly rpc: PiProcess;

  /** Point the runtime's raw stream at another run's log file; the previous file keeps its bytes. */
  rotateLog(file: string): void { this.rpc.rotateLog(file); }
  readonly closed: Promise<Exit>;
  private assistant?: WireRecord;
  private readonly sessionDir: string;
  private readonly parentCalls = new Map<string, {
    id: string;
    question: ParentQuestion;
    next: "select" | "input" | undefined;
    answer?: Pick<InteractionReply, "value" | "cancelled">;
    deferred?: { id: string; options?: string[] };
  }>();
  get pid(): number | undefined { return this.rpc.child.pid; }

  constructor(private readonly options: AdapterOptions) {
    if (options.session && options.session.cli !== "pi") throw new Error("The saved native session belongs to a different CLI; refusing to create a replacement");
    this.sessionDir = path.join(path.dirname(options.logFile), "..", "..", "sessions");
    mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    const { spec } = options;
    const args = ["--mode", "rpc", "--session-dir", this.sessionDir,
      "--extension", fileURLToPath(new URL("./pi-question-tool.js", import.meta.url)), "--append-system-prompt", `# Delegated role: ${spec.roleName}\n${spec.role.instructions}`];
    if (options.session?.cli === "pi") args.push("--session", options.session.sessionFile);
    else args.push("--name", `${spec.roleName}:${spec.id}`);
    if (spec.role.provider) args.push("--provider", spec.role.provider);
    if (spec.role.model) args.push("--model", spec.role.model);
    if (spec.role.thinking) args.push("--thinking", spec.role.thinking);
    args.push(...trimArgs(spec.role));
    this.rpc = new PiProcess(spec.launch, args, spec.cwd, options.logFile, record => this.event(record), options.requestTimeout);
    this.closed = this.rpc.closed;
  }

  private emit(event: AdapterEvent, runId: string | undefined | null = this.runId): void {
    if (event.type === "settled" && runId === this.runId) {
      if (this.active === false) return;
      this.active = false;
    }
    if (event.type === "question") (this.questions ??= new Map()).set(event.question.id, runId);
    if (event.type === "resolved") this.questions?.delete(event.id);
    this.options.onEvent({ ...event, ...(runId == null ? {} : { runId }) });
  }

  private clearQuestions(mode: "all" | "turn" | "task" = "all"): void {
    const tasks = new Set([...this.parentCalls.values()].map(call => call.id));
    for (const [id, scope] of this.questions ?? []) {
      if (mode === "all" || mode === "turn" && scope !== null || mode === "task" && tasks.has(id))
        this.emit({ type: "resolved", id }, scope ?? null);
    }
    this.parentCalls.clear();
  }

  private event(record: WireRecord): void {
    // Question normalization and cached UI replay adapted from Paseo's rpiv-ask-user-question
    // mapper (Apache-2.0). Copyright (c) 2025-present Mohamed Boudra; see README.md#credits.
    // Modified: one question per call, per-call tracking and exact, versioned UI stages.
    if (this.active !== false && record.toolName === ASK_PARENT_TOOL && typeof record.toolCallId === "string") {
      if (record.type === "tool_execution_start") {
        const question = readParentQuestion(record.args);
        if (question) {
          const id = `${ASK_PARENT_TOOL}:${this.runId ? `${this.runId}:` : ""}${record.toolCallId}`;
          const values = question.options.map(option => option.label);
          this.parentCalls.set(record.toolCallId, { id, question, next: "select" });
          this.emit({ type: "question", question: {
            id, method: "select", kind: "question", humanOnly: false,
            title: parentQuestionDialog(record.toolCallId, question, "select").displayTitle,
            message: question.options.map(option => `${option.label} — ${option.description}`).join("\n"),
            options: values, parentPolicy: { values, text: true },
          } });
        }
      } else if (record.type === "tool_execution_end") {
        const active = this.parentCalls.get(record.toolCallId);
        this.parentCalls.delete(record.toolCallId);
        if (active) this.emit({ type: "resolved", id: active.id });
      }
    }
    if (this.active !== false && record.type === "message_end" && typeof record.message === "object" && record.message?.role === "assistant") this.assistant = record.message;
    if (record.type === "agent_start" || record.type === "tool_execution_start" || record.type === "tool_execution_end")
      this.emit({ type: "activity", detail: piActivity(record.type, record.toolName) }, this.active === false ? null : this.runId);
    if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(record.method))) {
      if ((record.method === "select" || record.method === "input") && typeof record.id === "string" && record.message === undefined && record.prefill === undefined) {
        for (const [callId, active] of this.parentCalls) {
          if (active.next !== record.method) continue;
          const expected = parentQuestionDialog(callId, active.question, record.method);
          const matches = record.method === "select"
            ? Array.isArray(record.options) && record.options.length === expected.options!.length && record.options.every((value, i) => value === expected.options![i])
            : record.options === undefined && (record.placeholder === undefined || record.placeholder === expected.placeholder);
          if (record.title !== expected.title || !matches) continue;
          active.deferred = { id: record.id, options: record.options };
          // The logical answer can arrive before the first UI, or while Pi is waiting on it.
          if (active.answer) void this.answerParentDialog(callId).catch(() => {});
          return;
        }
      }
      const question: Question = {
        id: String(record.id), method: record.method as Question["method"], title: String(record.title ?? "Subagent needs a response"),
        message: typeof record.message === "string" ? record.message : undefined,
        options: record.options, placeholder: record.placeholder, prefill: record.prefill,
        // Pi RPC supplies dialog shapes, not approval provenance. Forward native choices;
        // the parent must judge their meaning against the user's authorization (as in Paseo).
        humanOnly: false,
        parentPolicy: record.method === "confirm" ? { confirm: true } :
          record.method === "select" ? { values: record.options } : { text: true },
        ...(typeof record.timeout === "number" ? { expiresAt: Date.now() + record.timeout } : {}),
      };
      // Ordinary RPC dialogs can originate in session_start or while idle. They
      // remain answerable independently of the next delegated run.
      this.emit({ type: "question", question, runtimeScoped: true }, this.active === false ? null : this.runId);
    }
    if (record.type === "agent_settled" && this.active !== false) {
      const reason = record.aborted === true ? "aborted" : this.assistant?.stopReason;
      // Ordinary dialogs have no reliable task provenance. Normal completion must
      // not discard them; an explicit abort invalidates dialogs from that turn.
      this.clearQuestions(reason === "aborted" ? "turn" : "task");
      const text = Array.isArray(this.assistant?.content) ? this.assistant.content.filter(part => part.type === "text").map(part => part.text).join("") : "";
      this.emit({ type: "settled", status: reason === "stop" ? "completed" : reason === "aborted" ? "stopped" : "failed", text,
        ...(reason === "stop" || reason === "aborted" ? {} : { error: String(this.assistant?.errorMessage ?? `Did not complete normally: ${reason ?? "missing final message"}`) }) });
    }
  }

  async ready(): Promise<NativeSession> {
    const initial = await this.rpc.request<{ sessionId?: string; sessionFile?: string }>({ type: "get_state" });
    if (typeof initial.sessionId !== "string" || typeof initial.sessionFile !== "string") throw new Error("Pi did not provide persistent session handles");
    const previous = this.options.session;
    if (previous && (previous.cli !== "pi" || initial.sessionId !== previous.sessionId || path.resolve(initial.sessionFile) !== path.resolve(previous.sessionFile)))
      throw new Error("Resume returned a different session; refusing to continue");
    return { cli: "pi", sessionId: initial.sessionId, sessionFile: initial.sessionFile };
  }
  async start(message: string, runId?: string): Promise<void> {
    this.rpc.assertPromptAllowed();
    if (this.active) throw new Error("Pi already has an active run");
    // Reserve the run before sending: events may precede the acceptance response.
    this.runId = runId;
    this.assistant = undefined;
    this.parentCalls.clear();
    this.active = true;
    try { await this.rpc.request({ type: "prompt", message }); }
    catch (error) { this.active = false; throw error; }
  }
  async send(message: string, mode: Delivery): Promise<void> { await this.rpc.request({ type: "prompt", message, streamingBehavior: mode }); }
  async reply(answer: InteractionReply): Promise<void> {
    for (const [callId, active] of this.parentCalls) {
      if (active.id !== answer.id) continue;
      if (active.answer) throw new Error("Pi interaction was already answered");
      active.answer = { value: answer.value, cancelled: answer.cancelled };
      if (active.deferred) await this.answerParentDialog(callId);
      return;
    }
    const scope = this.questions?.get(answer.id);
    if (!this.questions?.delete(answer.id)) throw new Error("Pi interaction is no longer pending or was already answered");
    await this.rpc.reply({ id: answer.id, value: answer.value, confirmed: answer.confirmed, cancelled: answer.cancelled });
    this.emit({ type: "resolved", id: answer.id }, scope ?? null);
  }

  private async answerParentDialog(callId: string): Promise<void> {
    const active = this.parentCalls.get(callId)!;
    const runId = this.runId;
    const dialog = active.deferred!;
    const answer = active.answer!;
    active.deferred = undefined;
    let value = answer.value;
    if (!answer.cancelled && active.next === "select") {
      const index = active.question.options.findIndex(option => option.label === value);
      value = dialog.options![index < 0 ? active.question.options.length : index];
      active.next = index < 0 ? "input" : undefined;
    } else active.next = undefined;
    try {
      await this.rpc.reply(answer.cancelled ? { id: dialog.id, cancelled: true } : { id: dialog.id, value });
    } catch (error) {
      // A later auto-write has no waiting caller to receive its error. Fail the run rather than
      // silently lose the answer or replay it after an uncertain write.
      if (this.parentCalls.get(callId) === active) this.parentCalls.delete(callId);
      this.emit({ type: "settled", status: "failed", text: "", stop: true,
        error: `Question response delivery failed: ${(error as Error).message}` }, runId);
      throw error;
    }
  }

  interrupt(): Promise<void> { return this.rpc.interrupt(); }
  end(): Promise<{ exit: Exit; forced: boolean }> { this.clearQuestions(); return this.rpc.end(); }
  stop(): Promise<{ exit: Exit; forced: boolean }> { this.clearQuestions(); return this.rpc.stop(); }
}

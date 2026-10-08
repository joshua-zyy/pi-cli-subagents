import path from "node:path";
import { mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { PiProcess, type WireRecord, type Exit } from "./pi-process.js";
import type { AdapterOptions, CliAdapter, InteractionReply } from "./cli-adapter.js";
import type { Delivery, NativeSession, Question, SessionHandle } from "./types.js";

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

/**
 * The only Pi interaction contract this extension has audited: the option set of
 * @firstpick/pi-extension-safety-guard. "Block" and "Allow once" settle one command, while
 * "Allow for this session" and "Always allow in this cwd" write a wider grant (the last one
 * persists under the agent directory). A Pi UI request carries no source identifier, so this is
 * the only Pi case where the meaning of a response is known; every other Pi interaction stays
 * answerable by the human alone.
 */
const AUDITED_PI_OPTIONS = ["Block", "Allow once", "Allow for this session", "Always allow in this cwd"];
const AUDITED_PI_PARENT_VALUES = ["Block", "Allow once"];

function auditedParentPolicy(method: unknown, options: unknown): Pick<Question, "parentPolicy" | "humanOnly"> {
  const audited = method === "select" && Array.isArray(options)
    && options.length === AUDITED_PI_OPTIONS.length && AUDITED_PI_OPTIONS.every((value, index) => options[index] === value);
  return audited ? { humanOnly: false, parentPolicy: { values: AUDITED_PI_PARENT_VALUES } } : { humanOnly: true };
}

export class PiAdapter implements CliAdapter {
  readonly rpc: PiProcess;
  readonly closed: Promise<Exit>;
  private assistant?: WireRecord;
  private readonly sessionDir: string;
  get pid(): number | undefined { return this.rpc.child.pid; }

  constructor(private readonly options: AdapterOptions) {
    if (options.session && options.session.cli !== "pi") throw new Error("The saved native session belongs to a different CLI; refusing to create a replacement");
    this.sessionDir = path.join(path.dirname(options.logFile), "..", "..", "sessions");
    mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
    const { spec } = options;
    const args = ["--mode", "rpc", "--session-dir", this.sessionDir, "--append-system-prompt", `# Delegated role: ${spec.roleName}\n${spec.role.instructions}`];
    if (options.session?.cli === "pi") args.push("--session", options.session.sessionFile);
    else args.push("--name", `${spec.roleName}:${spec.id}`);
    if (spec.role.provider) args.push("--provider", spec.role.provider);
    if (spec.role.model) args.push("--model", spec.role.model);
    if (spec.role.thinking) args.push("--thinking", spec.role.thinking);
    this.rpc = new PiProcess(spec.launch, args, spec.cwd, options.logFile, record => this.event(record));
    this.closed = this.rpc.closed;
  }

  private event(record: WireRecord): void {
    if (record.type === "message_end" && typeof record.message === "object" && record.message?.role === "assistant") this.assistant = record.message;
    if (record.type === "agent_start" || record.type === "tool_execution_start" || record.type === "tool_execution_end")
      this.options.onEvent({ type: "activity", detail: record.type === "agent_start" ? "agent_start" : `${record.type}: ${record.toolName}` });
    if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(record.method))) {
      const question: Question = {
        id: String(record.id), method: record.method as Question["method"], title: String(record.title ?? "Subagent needs a response"),
        message: typeof record.message === "string" ? record.message : undefined,
        options: record.options, placeholder: record.placeholder, prefill: record.prefill,
        ...auditedParentPolicy(record.method, record.options),
        ...(typeof record.timeout === "number" ? { expiresAt: Date.now() + record.timeout } : {}),
      };
      this.options.onEvent({ type: "question", question });
    }
    if (record.type === "agent_settled") {
      const reason = this.assistant?.stopReason;
      const text = Array.isArray(this.assistant?.content) ? this.assistant.content.filter(part => part.type === "text").map(part => part.text).join("") : "";
      this.options.onEvent({ type: "settled", status: reason === "stop" ? "completed" : reason === "aborted" ? "stopped" : "failed", text,
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
  async start(message: string): Promise<void> { await this.rpc.request({ type: "prompt", message }); }
  async send(message: string, mode: Delivery): Promise<void> { await this.rpc.request({ type: "prompt", message, streamingBehavior: mode }); }
  async reply(answer: InteractionReply): Promise<void> { await this.rpc.reply({ id: answer.id, value: answer.value, confirmed: answer.confirmed, cancelled: answer.cancelled }); }
  end(): Promise<{ exit: Exit; forced: boolean }> { return this.rpc.end(); }
  stop(): Promise<{ exit: Exit; forced: boolean }> { return this.rpc.stop(); }
}

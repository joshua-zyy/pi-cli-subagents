import path from "node:path";
import { mkdirSync } from "node:fs";
import { PiProcess, type WireRecord, type Exit } from "./pi-process.js";
import type { AdapterOptions, CliAdapter, InteractionReply } from "./cli-adapter.js";
import type { Delivery, NativeSession, Question } from "./types.js";

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

import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export interface TranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "notice";
  title: string;
  text: string;
  input?: string;
  status?: "running" | "done" | "error";
}
export interface TranscriptSnapshot { entries: TranscriptEntry[]; loading: boolean; notice?: string; revision?: number }

const CHUNK_BYTES = 512 * 1024;
const MAX_RECORD = 4 * 1024 * 1024;
const MAX_ENTRIES = 300;
const MAX_TEXT = 24_000;
const object = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const bounded = (value: string): string => value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}\n[Content clipped; see the original event log.]`;
function textOf(content: unknown): string {
  if (typeof content === "string") return bounded(content);
  if (!Array.isArray(content)) return "";
  return bounded(content.map(part => part?.type === "text" && typeof part.text === "string" ? part.text : part?.type === "image" ? "[Image omitted from terminal transcript]" : "").filter(Boolean).join("\n"));
}
function argumentsOf(value: unknown): string {
  return bounded(typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2));
}

/** Incremental, bounded reader of existing RPC logs; it never controls a child process. */
export class TranscriptReader {
  private files: string[] = [];
  private fileIndex = 0;
  private offset = 0;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private droppingLine = false;
  private entries = new Map<string, TranscriptEntry>();
  private serial = 0;
  private revision = 0;
  private assistant?: TranscriptEntry;
  private user?: TranscriptEntry;
  private blocks = new Map<number, string>();
  private calls = new Map<number, { id: string; name: string; args: string }>();
  private clipped = false;
  private malformed = false;
  private error?: string;

  async read(files: string[]): Promise<TranscriptSnapshot> {
    // A different instance/history or a truncated file must not share parsing state.
    if (this.files.some((file, i) => files[i] !== file)) this.reset();
    this.files = [...files];
    const file = files[this.fileIndex];
    if (!file) return this.snapshot(false);
    let handle;
    try {
      handle = await open(file, "r");
      const { size } = await handle.stat();
      if (size < this.offset) { this.reset(); this.files = [...files]; return this.snapshot(true); }
      if (this.offset === 0 && this.buffer === "") this.add({ id: `${this.fileIndex}:run`, kind: "notice", title: `Run ${this.fileIndex + 1}`, text: file });
      const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(0, size - this.offset)));
      if (bytes.length) {
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, this.offset);
        this.offset += bytesRead;
        this.consume(this.decoder.write(bytes.subarray(0, bytesRead)));
      }
      this.error = undefined;
      if (this.offset < size) return this.snapshot(true);
      if (this.fileIndex + 1 < files.length) {
        if (this.buffer.trim()) this.malformed = true;
        this.fileIndex++; this.offset = 0; this.buffer = ""; this.decoder = new StringDecoder("utf8");
        this.droppingLine = false; this.assistant = undefined; this.user = undefined; this.blocks.clear(); this.calls.clear();
        return this.snapshot(true);
      }
    } catch (error) {
      this.error = `Event log unavailable: ${(error as Error).message}`;
    } finally { await handle?.close(); }
    return this.snapshot(false);
  }

  private reset(): void {
    this.revision++;
    this.files = []; this.fileIndex = 0; this.offset = 0; this.buffer = "";
    this.decoder = new StringDecoder("utf8"); this.droppingLine = false;
    this.entries.clear(); this.assistant = undefined; this.user = undefined;
    this.blocks.clear(); this.calls.clear(); this.clipped = false; this.malformed = false; this.error = undefined;
  }
  private snapshot(loading: boolean): TranscriptSnapshot {
    const notice = [this.error, this.clipped ? "Showing recent content only; older or oversized content remains in the event logs." : undefined,
      this.malformed ? "Some malformed or incomplete log records were skipped." : undefined].filter(Boolean).join(" ");
    return { entries: [...this.entries.values()].map(entry => ({ ...entry })), loading, revision: this.revision, ...(notice ? { notice } : {}) };
  }
  private add(entry: TranscriptEntry): TranscriptEntry {
    this.revision++;
    this.entries.set(entry.id, entry);
    while (this.entries.size > MAX_ENTRIES) { this.entries.delete(this.entries.keys().next().value!); this.clipped = true; }
    return entry;
  }
  private consume(chunk: string): void {
    this.revision++;
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (this.droppingLine || Buffer.byteLength(line, "utf8") > MAX_RECORD) { this.droppingLine = false; this.clipped = true; continue; }
      if (!line.trim()) continue;
      try { const record = object(JSON.parse(line)); if (record) this.event(record); }
      catch { this.malformed = true; }
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RECORD) { this.buffer = ""; this.droppingLine = true; this.clipped = true; }
  }
  private tool(id: string, name: string, args?: unknown): TranscriptEntry {
    const key = `${this.fileIndex}:tool:${id}`;
    const entry = this.entries.get(key) ?? this.add({ id: key, kind: "tool", title: name, text: "", status: "running" });
    if (name) entry.title = name;
    if (args !== undefined) entry.input = argumentsOf(args);
    return entry;
  }
  private message(message: Record<string, any>, type: string): void {
    if (message.role === "assistant") {
      if (!this.assistant || type === "message_start") {
        this.assistant = this.add({ id: `assistant:${++this.serial}`, kind: "assistant", title: "Assistant", text: "" });
        this.blocks.clear(); this.calls.clear();
      }
      if (!this.entries.has(this.assistant.id)) this.add(this.assistant);
      this.assistant.text = textOf(message.content);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall" && typeof part.id === "string") this.tool(part.id, part.name ?? "tool", part.arguments);
      }
      if (typeof message.errorMessage === "string") this.assistant.text += `\n${bounded(message.errorMessage)}`;
      if (type === "message_end") this.assistant = undefined;
    } else if (message.role === "user") {
      if (!this.user || type === "message_start") this.user = this.add({ id: `user:${++this.serial}`, kind: "user", title: "User", text: "" });
      this.user.text = textOf(message.content);
      if (type === "message_end") this.user = undefined;
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const entry = this.tool(message.toolCallId, message.toolName ?? "tool");
      entry.text = textOf(message.content); entry.status = message.isError ? "error" : "done";
    }
  }
  private event(record: Record<string, any>): void {
    if (["message_start", "message_end", "message_update"].includes(record.type) && object(record.message)) {
      this.message(record.message, record.type);
      return; // Legacy cumulative snapshots already include the delta.
    }
    if (record.type === "message_update") {
      const update = object(record.assistantMessageEvent);
      if (!update) return;
      if (!this.assistant) this.message({ role: "assistant", content: [] }, "message_start");
      const index = Number(update.contentIndex);
      if (!Number.isInteger(index) || index < 0) return;
      if (update.type === "text_delta" || update.type === "text_end") {
        const text = update.type === "text_end" ? update.content : (this.blocks.get(index) ?? "") + (update.delta ?? "");
        if (typeof text === "string") this.blocks.set(index, bounded(text));
        this.assistant!.text = bounded([...this.blocks].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("\n"));
      } else if (update.type === "toolcall_start" && typeof update.id === "string") {
        this.calls.set(index, { id: update.id, name: update.toolName ?? "tool", args: "" });
        this.tool(update.id, update.toolName ?? "tool");
      } else if (update.type === "toolcall_delta") {
        const call = this.calls.get(index);
        if (call && typeof update.delta === "string") { call.args = bounded(call.args + update.delta); this.tool(call.id, call.name, call.args); }
      } else if (update.type === "toolcall_end" && object(update.toolCall)) {
        const call = update.toolCall;
        if (typeof call.id === "string") this.tool(call.id, call.name ?? "tool", call.arguments);
      }
      return;
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(record.type) && typeof record.toolCallId === "string") {
      const entry = this.tool(record.toolCallId, record.toolName ?? "tool", record.args);
      if (record.type === "tool_execution_update") entry.text = textOf(record.partialResult?.content);
      if (record.type === "tool_execution_end") { entry.text = textOf(record.result?.content); entry.status = record.isError ? "error" : "done"; }
    } else if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method)) {
      this.add({ id: `${this.fileIndex}:question:${String(record.id)}`, kind: "notice", title: `Interaction request (${record.method})`,
        text: bounded([record.title, record.message, Array.isArray(record.options) ? `Options: ${record.options.join(" | ")}` : undefined].filter(value => typeof value === "string").join("\n")) });
    } else if (record.type === "extension_error" || record.type === "auto_retry_start") {
      this.add({ id: `notice:${++this.serial}`, kind: "notice", title: record.type === "extension_error" ? "Extension error" : "Retry", text: bounded(String(record.error ?? record.errorMessage ?? "")), status: "error" });
    }
  }
}

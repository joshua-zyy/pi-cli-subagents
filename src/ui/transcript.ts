import { open } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Cli } from "../types.js";

/** A byte offset inside one run log. `source` is the normalized log path, never a list position. */
export interface TranscriptPosition { source: string; offset: number }
/** Byte range of the run-log records that produced an entry, inclusive start and exclusive end. */
export interface TranscriptSpan { start: TranscriptPosition; end: TranscriptPosition }
export interface TranscriptWindowInfo {
  from: TranscriptPosition;
  to: TranscriptPosition;
  /** No older records are left in the logs behind the materialized window. */
  atStart: boolean;
  /** The window ends at the live end of the newest run. */
  atEnd: boolean;
  entries: number;
}

/**
 * Normalized log identity for entry ids and window anchors. The full resolved path keeps files in the
 * same directory apart and survives a run list that grows at the front or the end.
 */
export function logSourceKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when this record continues a group that started earlier, so a log range must not begin here. */
export function continuesGroup(cli: Cli, record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  if (cli === "codex") return typeof (record.params as Record<string, unknown> | undefined)?.itemId === "string";
  if (cli === "claude") return record.type === "stream_event" && (record.event as Record<string, unknown> | undefined)?.type !== "message_start";
  return record.type === "message_update" || record.type === "tool_execution_update";
}

export interface TranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "notice";
  title: string;
  text: string;
  input?: string;
  status?: "running" | "done" | "error";
  /** `head` marks content whose group began before the window; `tail` marks a group the window cut short. */
  partial?: "head" | "tail";
  /** Records that produced this entry; present in paged windows, absent in sequential reads. */
  span?: TranscriptSpan;
}
export interface TranscriptPageBoundary { position: TranscriptPosition; id?: string }

export interface TranscriptSnapshot {
  /** Changes when the source logs are replaced, truncated, or reattached, not when paging. */
  sourceEpoch?: number;
  entries: TranscriptEntry[];
  loading: boolean;
  /** Recent content is usable, but older history and lifetime totals are still being reconstructed. */
  historyLoading?: boolean;
  notice?: string;
  revision?: number;
  /** New log bytes, excluding historical reconstruction and the preview-to-history handoff. */
  outputRevision?: number;
  usage?: TranscriptUsage;
  provider?: string;
  model?: string;
  /** Whole-log figures only: false means the parsed range never covered every run. */
  usageComplete?: boolean;
  /** Materialized byte window; present only for on-demand paged reads. */
  window?: TranscriptWindowInfo;
}
export interface TranscriptReaderOptions {
  /** `position` keys entries by run path and record offset, so ids survive a changing run list. */
  keys?: "serial" | "position";
  maxEntries?: number;
  /** Whether a parsed record may establish the native session identity; off for tail-window replays. */
  adoptIdentity?: boolean;
}
/** Lifetime tokens reported by the child's assistant messages, plus the latest context size. */
export interface TranscriptUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens?: number }

const CHUNK_BYTES = 512 * 1024;
const MAX_RECORD = 4 * 1024 * 1024;
const MAX_ENTRIES = 300;
const MAX_TEXT = 24_000;
// pi-lens-ignore: no-unsafe-dictionary-any
const object = (value: unknown): Record<string, any> | undefined =>
  // pi-lens-ignore: no-unsafe-dictionary-any
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
const zeroUsage = (): TranscriptUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const utf8Bytes = (value: string | undefined): number => value ? Buffer.byteLength(value, "utf8") : 0;

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
  private unavailableHistory = false;
  private error?: string;
  private usage?: TranscriptUsage;
  private provider?: string;
  private model?: string;

  private readonly initialThreadId?: string;
  private generation = 0;
  private recentFiles: string[] = [];
  private preview?: TranscriptReader;
  private caughtUp = false;
  private publishedKey = "";
  private publishedRevision = 0;
  private outputCursor = "";
  private outputRevision = 0;

  // Paged (position-keyed) mode: byte positions are tracked so ids, spans and windows stay stable.
  private readonly keys: "serial" | "position";
  private readonly maxEntries: number;
  private keepOldest = false;
  private readonly adoptIdentity: boolean;
  private recordStart = 0;
  private recordEnd = 0;
  private bufferStart = 0;
  private spans = new Map<string, TranscriptSpan>();
  private rangeFrom?: TranscriptPosition;
  private rangeTo?: TranscriptPosition;
  private readBytes = 0;
  private readCalls = 0;
  private tailContinues = false;
  private currentContinues = false;
  private inRecord = false;

  constructor(private readonly cli: Cli = "pi", private threadId?: string, options: TranscriptReaderOptions = {}) {
    this.initialThreadId = threadId;
    this.keys = options.keys ?? "serial";
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.adoptIdentity = options.adoptIdentity ?? true;
  }

  /**
   * Position-contiguous read of [from, to) with fresh parse state, or a continuation of the current
   * parse when `append` is set. It never scans outside the requested range.
   */
  async readRange(files: string[], from: TranscriptPosition, to: TranscriptPosition, options: { append?: boolean; budget?: number; cancelled?: () => boolean; fragmentStart?: boolean; keepOldest?: boolean } = {}): Promise<TranscriptSnapshot> {
    const sources = files.map(logSourceKey);
    const fromIndex = sources.indexOf(from.source), toIndex = sources.indexOf(to.source);
    if (fromIndex < 0 || toIndex < fromIndex) {
      this.reset();
      this.files = [...files];
      this.error = "Event log unavailable: the window no longer matches the run logs.";
      return this.snapshot(false);
    }
    if (!options.append) {
      this.reset();
      this.files = [...files];
      this.fileIndex = fromIndex;
      this.offset = from.offset;
      this.bufferStart = from.offset;
      this.rangeFrom = { ...from };
      // A window deliberately starting inside a record marks that leading fragment clipped, never malformed.
      this.droppingLine = options.fragmentStart === true;
    } else {
      const current = this.files[this.fileIndex] === undefined ? undefined : logSourceKey(this.files[this.fileIndex]);
      if (current !== from.source) {
        this.reset();
        this.files = [...files];
        this.fileIndex = fromIndex;
        this.offset = from.offset;
        this.bufferStart = from.offset;
        this.rangeFrom = { ...from };
      } else if (this.offset !== from.offset) {
        // Rewind to the last published record boundary; already parsed entries stay valid.
        this.offset = from.offset;
        this.bufferStart = from.offset;
        this.buffer = "";
        this.decoder = new StringDecoder("utf8");
      }
      this.files = [...files];
    }
    let remaining = options.budget ?? Number.POSITIVE_INFINITY;
    let reached = false;
    let bound = false;
    const cancelled = (): boolean => options.cancelled?.() === true;
    while (!reached) {
      // A closed page stops initiating reads; the cursor stays on the last parsed record.
      if (cancelled()) break;
      if (this.fileIndex > toIndex || (this.fileIndex === toIndex && this.offset >= to.offset)) { bound = true; break; }
      const file = this.files[this.fileIndex];
      if (file === undefined) { bound = true; break; }
      let handle;
      try {
        handle = await open(file, "r");
        const { size } = await handle.stat();
        // Closing a page between opening and reading must not submit another content read.
        if (cancelled()) break;
        const limit = this.fileIndex === toIndex ? Math.min(size, to.offset) : size;
        const want = Math.min(CHUNK_BYTES, Math.max(0, limit - this.offset), remaining);
        if (want > 0) {
          const bytes = Buffer.alloc(want);
          const { bytesRead } = await handle.read(bytes, 0, want, this.offset);
          this.readCalls++;
          this.readBytes += bytesRead;
          // The read was already in the kernel; do not parse or advance it after a cancel.
          if (cancelled()) break;
          const start = this.offset;
          this.offset += bytesRead;
          remaining -= bytesRead;
          this.keepOldest = options.keepOldest === true;
          try { this.consume(this.decoder.write(bytes.subarray(0, bytesRead)), start); }
          finally { this.keepOldest = false; }
        }
        this.error = undefined;
        if (this.offset >= size && this.fileIndex < toIndex) { this.nextFile(); continue; }
        if (this.fileIndex >= toIndex || this.offset >= limit) { bound = this.fileIndex >= toIndex && this.offset >= to.offset; if (want === 0 && !bound) break; continue; }
      } catch (error) {
        if (this.fileIndex < toIndex) {
          this.add({ id: `${this.fileKey()}:unavailable`, kind: "notice", title: "Unavailable historical run", text: `${file}\nEvent log unavailable: ${(error as Error).message}`, status: "error" });
          this.unavailableHistory = true;
          this.nextFile();
          continue;
        }
        // The newest run may not exist yet; retain the cursor and let the caller retry.
        this.error = undefined;
        bound = true;
        break;
      } finally { await handle?.close(); }
      if (remaining <= 0) break;
    }
    this.rangeTo = this.publishedEnd();
    return this.snapshot(!bound && Number.isFinite(remaining) && remaining <= 0);
  }

  /** Native identity learned from a run head; a tail record can never establish it. */
  get nativeId(): string | undefined { return this.threadId; }

  /**
   * Raw byte position after the last read, including a partially buffered record. Callers that append
   * must resume from here, so buffered UTF-8/LF fragments are never dropped or read twice.
   */
  get cursor(): TranscriptPosition { return { source: this.fileKey(), offset: this.offset }; }

  /** Real I/O and parse accounting for bounded-work checks; the paged window aggregates it. */
  stats(): { readBytes: number; readCalls: number; clipped: boolean; malformed: boolean; unavailable: boolean; tailContinues: boolean; entries: number; textBytes: number } {
    let textBytes = 0;
    for (const entry of this.entries.values()) textBytes += utf8Bytes(entry.text) + utf8Bytes(entry.input);
    return { readBytes: this.readBytes, readCalls: this.readCalls,
      clipped: this.clipped, malformed: this.malformed, unavailable: this.unavailableHistory, tailContinues: this.tailContinues,
      entries: this.entries.size, textBytes };
  }

  /** The last complete record boundary of the current file, so a partial tail record is never published. */
  private publishedEnd(): TranscriptPosition {
    const source = this.fileKey();
    return this.buffer.length ? { source, offset: this.bufferStart } : { source, offset: this.offset };
  }

  /** Stable per-file identity: the normalized log path, never the position in a changing run list. */
  private fileKey(index = this.fileIndex): string {
    const file = this.files[index];
    return this.keys === "position" && file !== undefined ? logSourceKey(file) : String(index);
  }
  /** Entry id for records without a native id: the run path plus the offset of the creating record. */
  private key(kind: string): string {
    return this.keys === "position" ? `${this.fileKey()}:${this.recordStart}:${kind}` : `${kind}:${++this.serial}`;
  }
  /** Entry id for records that carry their own id; the native id is always preserved verbatim. */
  private scoped(prefix: string, native: string): string {
    return `${this.keys === "position" ? this.fileKey() : String(this.fileIndex)}:${prefix}:${native}`;
  }
  /** Records the byte span of the records behind an entry, so windows can be anchored on real offsets. */
  private mark(id: string): void {
    if (this.keys !== "position") return;
    const source = this.fileKey();
    const span = this.spans.get(id);
    if (span && span.end.source === source && span.end.offset === this.recordEnd) return;
    if (span) span.end = { source, offset: this.recordEnd };
    else this.spans.set(id, { start: { source, offset: this.recordStart }, end: { source, offset: this.recordEnd } });
  }

  /** Serial calls only: show the tail first, then advance live output and one historical batch per refresh. */
  async readRecent(files: string[]): Promise<TranscriptSnapshot> {
    if (!files.length) {
      if (this.recentFiles.length) { this.reset(); this.preview = undefined; this.caughtUp = false; }
      this.recentFiles = [];
      return this.publish(this.snapshot(false), this, false);
    }
    const changed = this.recentFiles.some((file, i) => files[i] !== file);
    const extended = files.length > this.recentFiles.length;
    this.recentFiles = [...files];
    if (changed || (!this.preview && !this.caughtUp)) return this.startRecent(files);

    const generation = this.generation;
    const history = await this.read(files);
    if (generation !== this.generation) return this.startRecent(files);
    if (this.caughtUp) return this.publish(history, this, false);

    let preview = this.preview!;
    let recent: TranscriptSnapshot;
    if (extended || (this.cli !== "pi" && !preview.threadId && this.threadId)) {
      this.preview = preview = new TranscriptReader(this.cli, this.threadId);
      await preview.seekTail(files);
      recent = preview.snapshot(false);
    } else if (this.cli === "pi" || preview.threadId) {
      const previewGeneration = preview.generation;
      recent = await preview.read(files);
      if (previewGeneration !== preview.generation) return this.startRecent(files);
    } else recent = preview.snapshot(false);
    // Read history BEFORE the tail, and publish any new live bytes before handing off. Only replace
    // at the last displayed cursor, so historical prepends cannot move a paused view past an append.
    const cursor = `${this.generation}:${files[preview.fileIndex] ?? ""}:${preview.offset}`;
    if (!history.loading && !recent.loading && this.fileIndex === preview.fileIndex && this.offset === preview.offset && cursor === this.outputCursor) {
      this.caughtUp = true;
      this.preview = undefined;
      return this.publish(history, this, false);
    }
    return this.publish(recent, preview, true);
  }

  private async startRecent(files: string[]): Promise<TranscriptSnapshot> {
    this.reset();
    this.threadId = this.initialThreadId;
    this.caughtUp = false;
    this.preview = new TranscriptReader(this.cli, this.threadId);
    await this.preview.seekTail(files);
    return this.publish(this.preview.snapshot(false), this.preview, true);
  }

  private publish(snapshot: TranscriptSnapshot, source: TranscriptReader, historyLoading: boolean): TranscriptSnapshot {
    const key = `${this.generation}:${historyLoading ? "preview" : "history"}:${source.fileIndex}:${source.revision}`;
    if (key !== this.publishedKey) { this.publishedKey = key; this.publishedRevision++; }
    const cursor = `${this.generation}:${source.files[source.fileIndex] ?? ""}:${source.offset}`;
    if (cursor !== this.outputCursor) { this.outputCursor = cursor; this.outputRevision++; }
    return { ...snapshot, historyLoading, revision: this.publishedRevision, outputRevision: this.outputRevision,
      ...(historyLoading ? { usage: undefined } : {}) };
  }

  /** A bounded initial seek; never join a partial first line to a later event or decode half a UTF-8 prefix. */
  private async seekTail(files: string[]): Promise<void> {
    this.files = [...files];
    this.fileIndex = Math.max(0, files.length - 1);
    for (let i = files.length - 1; i >= 0; i--) {
      let handle;
      try {
        handle = await open(files[i], "r");
        const { size } = await handle.stat();
        if (size === 0 && i > 0) continue;
        this.fileIndex = i;
        this.add({ id: this.scoped("run", ""), kind: "notice", title: `Run ${i + 1}`, text: files[i] });
        let window = Math.min(size, CHUNK_BYTES);
        while (true) {
          const start = Math.max(0, size - window), readStart = Math.max(0, start - 1);
          const bytes = Buffer.alloc(size - readStart);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, readStart);
          this.readCalls++;
          this.readBytes += bytesRead;
          const data = bytes.subarray(0, bytesRead);
          let first = start - readStart;
          let fragment = false;
          if (start > 0 && data[0] !== 10) {
            const newline = data.indexOf(10, first);
            first = newline < 0 ? data.length : newline + 1;
            fragment = newline < 0;
          }
          // Grow only when the window cannot contain even one complete record. A supported record
          // is at most MAX_RECORD bytes; one extra chunk covers its preceding boundary.
          if (start > 0 && data.lastIndexOf(10) < first && window < MAX_RECORD + CHUNK_BYTES) {
            window = Math.min(size, MAX_RECORD + CHUNK_BYTES, window * 2);
            continue;
          }
          if (start > 0 && this.cli !== "pi" && !this.threadId) {
            // Learn identity only from the beginning of this run, never from an arbitrary tail event.
            const head = new TranscriptReader(this.cli);
            await head.read([files[i]]);
            this.threadId = head.threadId;
            this.provider = head.provider; this.model = head.model;
          }
          this.offset = readStart + bytesRead;
          this.clipped = start > 0 || i > 0;
          this.droppingLine = fragment;
          if (start === 0 || this.cli === "pi" || this.threadId) this.consume(this.decoder.write(data.subarray(first)), readStart + first);
          else this.error = "Waiting for the native session identity while history loads.";
          return;
        }
      } catch (error) {
        this.error = `Event log unavailable: ${(error as Error).message}`;
      } finally { await handle?.close(); }
    }
  }

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
      if (this.offset === 0 && this.buffer === "") this.add({ id: this.scoped("run", ""), kind: "notice", title: `Run ${this.fileIndex + 1}`, text: file });
      const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(0, size - this.offset)));
      if (bytes.length) {
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, this.offset);
        const start = this.offset;
        this.offset += bytesRead;
        this.readCalls++;
        this.readBytes += bytesRead;
        this.consume(this.decoder.write(bytes.subarray(0, bytesRead)), start);
      }
      this.error = undefined;
      if (this.offset < size) return this.snapshot(true);
      if (this.fileIndex + 1 < files.length) {
        this.nextFile();
        return this.snapshot(true);
      }
    } catch (error) {
      this.error = `Event log unavailable: ${(error as Error).message}`;
      if (this.fileIndex + 1 < files.length) {
        this.add({ id: this.scoped("unavailable", ""), kind: "notice", title: "Unavailable historical run", text: `${file}\n${this.error}`, status: "error" });
        this.unavailableHistory = true;
        this.nextFile();
        return this.snapshot(true);
      }
      // The latest file may not exist yet; retain its cursor and retry on refresh.
    } finally { await handle?.close(); }
    return this.snapshot(false);
  }

  /** Every run boundary resets decoder/message state, including skipped history. */
  private nextFile(): void {
    if (this.buffer.trim()) this.malformed = true;
    this.fileIndex++; this.offset = 0; this.buffer = ""; this.bufferStart = 0; this.decoder = new StringDecoder("utf8");
    this.droppingLine = false; this.assistant = undefined; this.user = undefined; this.blocks.clear(); this.calls.clear();
    this.error = undefined;
  }
  private reset(): void {
    this.generation++;
    this.revision++;
    this.files = []; this.fileIndex = 0; this.offset = 0; this.buffer = ""; this.bufferStart = 0;
    this.decoder = new StringDecoder("utf8"); this.droppingLine = false;
    this.entries.clear(); this.spans.clear(); this.assistant = undefined; this.user = undefined;
    this.blocks.clear(); this.calls.clear(); this.clipped = false; this.malformed = false; this.unavailableHistory = false; this.error = undefined;
    this.usage = undefined; this.provider = undefined; this.model = undefined;
    this.rangeFrom = undefined; this.rangeTo = undefined; this.tailContinues = false; this.currentContinues = false; this.inRecord = false;
  }
  private snapshot(loading: boolean): TranscriptSnapshot {
    const notice = [this.error, this.unavailableHistory ? "Some historical event logs were unavailable; skipped runs are marked in the transcript." : undefined,
      this.clipped ? "Showing recent content only; older or oversized content remains in the event logs." : undefined,
      this.malformed ? "Some malformed or incomplete log records were skipped." : undefined].filter(Boolean).join(" ");
    const entries = [...this.entries.values()].map(entry => {
      const span = this.spans.get(entry.id);
      // Copy spans: the reader keeps mutating its own record while a snapshot is displayed.
      return span ? { ...entry, span: { start: { ...span.start }, end: { ...span.end } } } : { ...entry };
    });
    const from = this.rangeFrom;
    return { entries, loading, revision: this.revision, ...(notice ? { notice } : {}),
      ...(this.usage ? { usage: { ...this.usage } } : {}), ...(this.provider ? { provider: this.provider } : {}), ...(this.model ? { model: this.model } : {}),
      ...(this.keys === "position" && from ? { window: { from: { ...from }, to: { ...(this.rangeTo ?? from) }, atStart: false, atEnd: false, entries: this.entries.size } } : {}) };
  }
  private add(entry: TranscriptEntry): TranscriptEntry {
    this.revision++;
    if (this.keys === "position" && this.inRecord && this.currentContinues) entry.partial = "head";
    this.entries.set(entry.id, entry);
    if (this.keys === "position") this.mark(entry.id);
    while (this.entries.size > this.maxEntries) {
      const removed = this.keepOldest ? entry.id : this.entries.keys().next().value!;
      this.entries.delete(removed); this.spans.delete(removed); this.clipped = true;
    }
    return entry;
  }
  private consume(chunk: string, at: number): void {
    this.revision++;
    if (this.buffer === "") this.bufferStart = at;
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      const recordStart = this.bufferStart;
      this.buffer = this.buffer.slice(newline + 1);
      this.bufferStart = recordStart + Buffer.byteLength(line, "utf8") + 1;
      if (this.droppingLine || Buffer.byteLength(line, "utf8") > MAX_RECORD) { this.droppingLine = false; this.clipped = true; continue; }
      if (!line.trim()) continue;
      this.recordStart = recordStart; this.recordEnd = this.bufferStart;
      try {
        const record = object(JSON.parse(line));
        if (record) {
          // A record that continues an earlier group is exactly what a window start cannot cut.
          this.currentContinues = this.keys === "position" && continuesGroup(this.cli, record);
          this.tailContinues = this.currentContinues;
          this.inRecord = true;
          try { this.event(record); } finally { this.inRecord = false; }
        }
      } catch { this.malformed = true; }
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RECORD) { this.buffer = ""; this.bufferStart = this.offset; this.droppingLine = true; this.clipped = true; }
  }
  private tool(id: string, name: string, args?: unknown): TranscriptEntry {
    const key = this.scoped("tool", id);
    const existing = this.entries.get(key);
    const entry = existing ?? this.add({ id: key, kind: "tool", title: name, text: "", status: "running" });
    if (existing) this.mark(key);
    if (name) entry.title = name;
    if (args !== undefined) entry.input = argumentsOf(args);
    return entry;
  }
  // pi-lens-ignore: no-unsafe-dictionary-any
  private message(message: Record<string, any>, type: string): void {
    if (message.role === "assistant") {
      if (!this.assistant || type === "message_start") {
        this.assistant = this.add({ id: this.key("assistant"), kind: "assistant", title: "Assistant", text: "" });
        this.blocks.clear(); this.calls.clear();
      }
      if (!this.entries.has(this.assistant.id)) this.add(this.assistant);
      this.assistant.text = textOf(message.content);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall" && typeof part.id === "string") this.tool(part.id, part.name ?? "tool", part.arguments);
      }
      if (typeof message.errorMessage === "string") this.assistant.text += `\n${bounded(message.errorMessage)}`;
      this.mark(this.assistant.id);
      if (type === "message_end") { this.countUsage(message); this.assistant = undefined; }
    } else if (message.role === "user") {
      if (!this.user || type === "message_start") this.user = this.add({ id: this.key("user"), kind: "user", title: "User", text: "" });
      this.user.text = textOf(message.content);
      this.mark(this.user.id);
      if (type === "message_end") this.user = undefined;
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const entry = this.tool(message.toolCallId, message.toolName ?? "tool");
      entry.text = textOf(message.content); entry.status = message.isError ? "error" : "done";
      this.mark(entry.id);
    }
  }
  /** Sum provider-reported usage per finished assistant message; the last context size is kept separately. */
  // pi-lens-ignore: no-unsafe-dictionary-any
  private countUsage(message: Record<string, any>): void {
    if (typeof message.provider === "string") this.provider = message.provider;
    if (typeof message.model === "string") this.model = message.model;
    const usage = object(message.usage);
    if (!usage) return;
    if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) this.usage = { ...(this.usage ?? zeroUsage()), contextTokens: usage.totalTokens };
    const counted = ["input", "output", "cacheRead", "cacheWrite"].some(key => typeof usage[key] === "number" && Number.isFinite(usage[key]));
    if (!counted) return;
    const total = this.usage ?? zeroUsage();
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) total[key] += value;
    }
    const cost = object(usage.cost)?.total;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total.cost += cost;
    this.usage = total;
  }
  private codexItem(id: string, kind: TranscriptEntry["kind"], title: string): TranscriptEntry {
    const key = this.scoped("codex", id);
    return this.entries.get(key) ?? this.add({ id: key, kind, title, text: "" });
  }
  // pi-lens-ignore: no-unsafe-dictionary-any
  private codex(record: Record<string, any>): void {
    const response = object(record.result);
    // A tail window must never claim a native identity; only a trusted head read or the caller may.
    if (this.adoptIdentity && !this.threadId && typeof response?.thread?.id === "string") this.threadId = response.thread.id;
    if (!this.threadId) return;
    if (response?.thread?.id === this.threadId) {
      if (typeof response.model === "string") this.model = response.model;
      if (typeof response.modelProvider === "string") this.provider = response.modelProvider;
      return;
    }
    const p = object(record.params);
    if (!p || p.threadId !== this.threadId) return;
    const item = object(p.item);
    if (record.method === "thread/tokenUsage/updated") {
      const total = object(p.tokenUsage)?.total;
      if (!object(total)) return;
      const input = Number(total.inputTokens), cached = Number(total.cachedInputTokens), write = Number(total.cacheWriteInputTokens ?? 0), output = Number(total.outputTokens);
      if (![input, cached, write, output].every(value => Number.isSafeInteger(value) && value >= 0)) return;
      this.usage = { input: Math.max(0, input - cached - write), cacheRead: cached, cacheWrite: write, output, cost: 0 };
      return;
    }
    if (record.method === "item/agentMessage/delta" && typeof p.itemId === "string" && typeof p.delta === "string") {
      const entry = this.codexItem(p.itemId, "assistant", "Assistant");
      entry.text = bounded(entry.text + p.delta);
      this.mark(entry.id);
      return;
    }
    if (record.method === "item/commandExecution/outputDelta" && typeof p.itemId === "string" && typeof p.delta === "string") {
      const entry = this.codexItem(p.itemId, "tool", "Shell command");
      entry.text = bounded(entry.text + p.delta);
      this.mark(entry.id);
      return;
    }
    if (!item || typeof item.id !== "string") return;
    if (record.method === "item/completed" && item.type === "userMessage") {
      const entry = this.codexItem(item.id, "user", "User"); entry.text = textOf(item.content); this.mark(entry.id);
    } else if (item.type === "agentMessage" && record.method === "item/completed") {
      const entry = this.codexItem(item.id, "assistant", "Assistant");
      if (typeof item.text === "string") entry.text = bounded(item.text);
      this.mark(entry.id);
    } else if (["item/started", "item/completed"].includes(record.method) && ["commandExecution", "fileChange"].includes(item.type)) {
      const command = item.type === "commandExecution";
      const entry = this.codexItem(item.id, "tool", command ? "Shell command" : "File change");
      const input = command ? { command: item.command, cwd: item.cwd } : item.changes;
      if (input !== undefined) entry.input = argumentsOf(input);
      entry.status = record.method === "item/started" ? "running" : ["failed", "declined"].includes(item.status) ? "error" : "done";
      if (command && record.method === "item/completed" && typeof item.aggregatedOutput === "string") entry.text = bounded(item.aggregatedOutput);
      this.mark(entry.id);
    }
  }
  // pi-lens-ignore: no-unsafe-dictionary-any
  private claude(record: Record<string, any>): void {
    if (record.parent_tool_use_id != null) return;
    if (this.adoptIdentity && !this.threadId && record.type === "system" && typeof record.session_id === "string") this.threadId = record.session_id;
    if (!this.threadId || record.session_id !== undefined && record.session_id !== this.threadId) return;
    if (record.type === "system" && record.subtype === "init" && typeof record.model === "string") this.model = record.model;
    if (record.type === "control_request" && record.request?.subtype === "can_use_tool") {
      this.add({ id: this.scoped("claude-permission", String(record.request_id)), kind: "notice", title: "Claude tool permission",
        text: argumentsOf(record.request) });
      return;
    }
    const message = object(record.message);
    const event = object(record.event);
    if (record.type === "stream_event" && event?.type === "message_start" && typeof event.message?.id === "string") {
      const id = this.scoped("claude", event.message.id);
      this.assistant = this.entries.get(id) ?? this.add({ id, kind: "assistant", title: "Assistant", text: "" });
      if (this.entries.has(id)) this.mark(id);
      this.blocks.clear(); this.calls.clear();
    }
    if (record.type === "stream_event" && event && this.assistant) {
      const index = event.index;
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        const block = event.content_block;
        this.calls.set(index, { id: block.id, name: block.name, args: "" }); this.tool(block.id, block.name, block.input);
      }
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
        this.blocks.set(index, bounded((this.blocks.get(index) ?? "") + event.delta.text));
        this.assistant.text = bounded([...this.blocks].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join("\n"));
      }
      if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
        const call = this.calls.get(index);
        if (call && typeof event.delta.partial_json === "string") { call.args = bounded(call.args + event.delta.partial_json); this.tool(call.id, call.name, call.args); }
      }
      this.mark(this.assistant.id);
    }
    if (record.type === "assistant" && message && typeof message.id === "string") {
      if (typeof message.model === "string") this.model = message.model;
      const id = this.scoped("claude", message.id);
      this.assistant = this.entries.get(id) ?? this.add({ id, kind: "assistant", title: "Assistant", text: "" });
      const text = textOf(message.content);
      if (text) this.assistant.text = text;
      for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "tool_use" && typeof part.id === "string") this.tool(part.id, part.name ?? "tool", part.input);
      this.mark(this.assistant.id);
    }
    if (record.type === "user" && message) {
      const text = textOf(message.content);
      if (text) this.add({ id: this.scoped("claude-user", String(record.uuid)), kind: "user", title: "User", text });
      for (const part of Array.isArray(message.content) ? message.content : []) if (part?.type === "tool_result" && typeof part.tool_use_id === "string") {
        const tool = this.tool(part.tool_use_id, ""); tool.text = textOf(part.content); tool.status = part.is_error ? "error" : "done";
        this.mark(tool.id);
      }
    }
    if (record.type === "result") {
      const failed = record.is_error || record.subtype !== "success";
      const text = typeof record.result === "string" ? record.result : Array.isArray(record.errors) ? record.errors.filter((value: unknown) => typeof value === "string").join("\n") : "";
      if (text && (failed || text !== this.assistant?.text)) this.add({
        id: this.scoped("claude-result", String(record.uuid)), kind: failed ? "notice" : "assistant", title: failed ? "Claude error" : "Final response",
        text: bounded(text), ...(failed ? { status: "error" } : {}),
      });
      const models = object(record.modelUsage);
      if (!models) return;
      const total = zeroUsage();
      for (const usage of Object.values(models)) {
        if (!object(usage)) return;
        for (const [native, key] of [["inputTokens", "input"], ["outputTokens", "output"], ["cacheReadInputTokens", "cacheRead"], ["cacheCreationInputTokens", "cacheWrite"]] as const) {
          const value = usage[native]; if (!Number.isSafeInteger(value) || value < 0) return;
          total[key] += value;
        }
      }
      if (typeof record.total_cost_usd !== "number" || !Number.isFinite(record.total_cost_usd) || record.total_cost_usd < 0) return;
      total.cost = record.total_cost_usd;
      // These totals include saved earlier turns on resume. Never add successive snapshots.
      if (!record.is_error || Object.values(total).some(value => value > 0)) this.usage = total;
    }
  }
  // pi-lens-ignore: no-unsafe-dictionary-any
  private event(record: Record<string, any>): void {
    if (this.cli === "claude") { this.claude(record); return; }
    if (this.cli === "codex") { this.codex(record); return; }
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
      if (this.assistant) this.mark(this.assistant.id);
      return;
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(record.type) && typeof record.toolCallId === "string") {
      const entry = this.tool(record.toolCallId, record.toolName ?? "tool", record.args);
      if (record.type === "tool_execution_update") entry.text = textOf(record.partialResult?.content);
      if (record.type === "tool_execution_end") { entry.text = textOf(record.result?.content); entry.status = record.isError ? "error" : "done"; }
      this.mark(entry.id);
    } else if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method)) {
      this.add({ id: this.scoped("question", String(record.id)), kind: "notice", title: `Interaction request (${record.method})`,
        text: bounded([record.title, record.message, Array.isArray(record.options) ? `Options: ${record.options.join(" | ")}` : undefined].filter(value => typeof value === "string").join("\n")) });
    } else if (record.type === "extension_error" || record.type === "auto_retry_start") {
      this.add({ id: this.key("notice"), kind: "notice", title: record.type === "extension_error" ? "Extension error" : "Retry", text: bounded(String(record.error ?? record.errorMessage ?? "")), status: "error" });
    }
  }
}
